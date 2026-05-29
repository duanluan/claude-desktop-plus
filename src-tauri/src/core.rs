use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::ffi::OsStr;
use std::fs;
use std::io::{self, IsTerminal, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::str;
use std::thread;
use std::time::{Duration, Instant};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tungstenite::{connect, Message};

const APP_SETTINGS_FILE_NAME: &str = "settings.json";
const INSTALL_MANIFEST_FILE_NAME: &str = "install-manifest.json";
const LANGUAGE_PACK_VERSION: &str = "0.1.0";
const DEFAULT_LOCALE: &str = "zh-CN";
const SUPPORTED_LOCALES: [&str; 12] = [
    "en-US", "de-DE", "es-ES", "es-419", "fr-FR", "hi-IN", "id-ID", "it-IT", "ja-JP", "ko-KR",
    "pt-BR", "zh-CN",
];
const APP_ASAR_RELATIVE_PATH: &str = "resources/app.asar";
const ASAR_MAIN_INDEX_PATH: &str = ".vite/build/index.js";
const ASAR_MAIN_PATCH_PATHS: [&str; 1] = [ASAR_MAIN_INDEX_PATH];
const ASAR_RENDERER_PRELOAD_PATH: &str = ".vite/build/mainWindow.js";
const ASAR_WEBVIEW_PRELOAD_PATH: &str = ".vite/build/mainView.js";
const ASAR_RENDERER_PATCH_PATHS: [&str; 2] =
    [ASAR_RENDERER_PRELOAD_PATH, ASAR_WEBVIEW_PRELOAD_PATH];
const ASAR_MAIN_PATCH_MARKER: &str = "ClaudeDesktopPlusMainInjectV12";
const ASAR_PRELOAD_PATCH_MARKER: &str = "ClaudeDesktopPlusPreloadInjectV3";
const ASAR_INTEGRITY_BLOCK_SIZE: usize = 4 * 1024 * 1024;
const LANGUAGE_PACK_ZH_CN: &str = include_str!("../resources/language-packs/zh-CN.json");
const WEB_INJECT_ZH_CN: &str = include_str!("../resources/web-inject/zh-CN.js");
const DESKTOP_TRANSLATION_ZH_CN: &str =
    include_str!("../resources/desktop-translations/zh-CN.json");
const LINUX_EXTERNAL_LAUNCH_ENV_REMOVALS: [&str; 18] = [
    "APPDIR",
    "APPIMAGE",
    "APPIMAGE_EXTRACT_AND_RUN",
    "APPIMAGE_SILENT_INSTALL",
    "ARGV0",
    "GDK_PIXBUF_MODULE_FILE",
    "GDK_PIXBUF_MODULEDIR",
    "GIO_MODULE_DIR",
    "GI_TYPELIB_PATH",
    "GSETTINGS_SCHEMA_DIR",
    "GST_PLUGIN_PATH",
    "GTK_DATA_PREFIX",
    "GTK_EXE_PREFIX",
    "GTK_PATH",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "OWD",
    "QT_PLUGIN_PATH",
];

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub selected_installation_id: Option<String>,
    pub locale: String,
    pub inject_enabled: bool,
    pub launch_after_install: bool,
    pub quick_start_completed: bool,
    pub launcher_created_at: Option<String>,
    pub launcher_path: Option<PathBuf>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            selected_installation_id: None,
            locale: DEFAULT_LOCALE.to_string(),
            inject_enabled: true,
            launch_after_install: false,
            quick_start_completed: false,
            launcher_created_at: None,
            launcher_path: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeInstallation {
    pub id: String,
    pub label: String,
    pub platform: String,
    pub source: String,
    pub root_path: PathBuf,
    pub app_asar_path: PathBuf,
    pub locales_path: PathBuf,
    pub executable_path: Option<PathBuf>,
    pub version: Option<String>,
    pub writable_strategy: WritableStrategy,
    pub installed_manifest: Option<InstallManifest>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WritableStrategy {
    Direct,
    UserOverlay,
    CopyAppBundle,
    Unknown,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallManifest {
    pub app_version: Option<String>,
    pub installed_locale: String,
    pub language_pack_version: String,
    pub installed_at: String,
    pub source_root_path: PathBuf,
    pub target_root_path: PathBuf,
    pub original_app_asar_sha256: Option<String>,
    pub backup_locales_path: Option<PathBuf>,
    pub overlay: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub installations: Vec<ClaudeInstallation>,
    pub selected_installation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub success: bool,
    pub message: String,
    pub installation: Option<ClaudeInstallation>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetupResult {
    pub success: bool,
    pub message: String,
    pub installation: Option<ClaudeInstallation>,
    pub launcher_path: Option<PathBuf>,
    pub doctor: Option<DoctorResult>,
    pub requires_close_confirmation: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheck {
    pub key: String,
    pub status: DoctorStatus,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DoctorStatus {
    Pass,
    Warn,
    Fail,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DoctorResult {
    pub checks: Vec<DoctorCheck>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct I18nAuditItem {
    pub group: String,
    pub key: String,
    pub source: String,
    pub target: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct I18nAuditResult {
    pub installation_id: String,
    pub locale: String,
    pub total_items: usize,
    pub translated_items: usize,
    pub untranslated_items: Vec<I18nAuditItem>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RunningClaudeProcess {
    pid: u32,
    uses_target_app_asar: bool,
    has_remote_debugging: bool,
    is_main_process: bool,
    locale: Option<String>,
}

#[derive(Debug, Clone)]
struct AsarArchive {
    bytes: Vec<u8>,
    header: serde_json::Value,
    data_start: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AsarFileEntry {
    path: Vec<String>,
    display_path: String,
    offset: usize,
    size: usize,
}

#[derive(Debug, Clone)]
struct LanguagePackResource {
    locale_json: &'static str,
    web_inject_js: &'static str,
    desktop_translation_json: &'static str,
    inject_file_name: &'static str,
    desktop_translation_file_name: &'static str,
}

#[derive(Debug, Clone)]
struct RuntimeLocaleResource {
    web_inject_js: &'static str,
    desktop_translation_json: &'static str,
    inject_file_name: &'static str,
    desktop_translation_file_name: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LaunchConflictStrategy {
    ReportOnly,
    PromptToClose,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CloseDecision {
    Confirmed,
    Declined,
    NonInteractive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SetupConflictStrategy {
    ReportOnly,
    CloseRunningClaude,
    PromptToClose,
}

#[tauri::command]
pub fn scan_claude_installations() -> Result<ScanResult, String> {
    scan_claude_installations_inner().map_err(|error| error.to_string())
}

pub fn scan_claude_installations_cli() -> Result<ScanResult> {
    scan_claude_installations_inner()
}

#[tauri::command]
pub fn install_language_pack(locale: String) -> Result<OperationResult, String> {
    install_language_pack_inner(&locale).map_err(|error| error.to_string())
}

pub fn install_language_pack_cli(locale: &str) -> Result<OperationResult> {
    install_language_pack_inner(locale)
}

#[tauri::command]
pub fn setup_quick_start(confirm_close: Option<bool>) -> Result<SetupResult, String> {
    let strategy = if confirm_close.unwrap_or(false) {
        SetupConflictStrategy::CloseRunningClaude
    } else {
        SetupConflictStrategy::ReportOnly
    };
    setup_quick_start_inner(strategy).map_err(|error| error.to_string())
}

pub fn setup_quick_start_cli() -> Result<SetupResult> {
    setup_quick_start_inner(SetupConflictStrategy::PromptToClose)
}

#[tauri::command]
pub fn create_launcher_shortcut() -> Result<OperationResult, String> {
    create_launcher_shortcut_inner().map_err(|error| error.to_string())
}

pub fn create_launcher_shortcut_cli() -> Result<OperationResult> {
    create_launcher_shortcut_inner()
}

#[tauri::command]
pub fn launch_claude_plus() -> Result<OperationResult, String> {
    launch_claude_plus_inner(LaunchConflictStrategy::ReportOnly).map_err(|error| error.to_string())
}

pub fn launch_claude_plus_cli() -> Result<OperationResult> {
    launch_claude_plus_inner(LaunchConflictStrategy::PromptToClose)
}

#[tauri::command]
pub fn restore_claude() -> Result<OperationResult, String> {
    restore_claude_inner().map_err(|error| error.to_string())
}

pub fn restore_claude_cli() -> Result<OperationResult> {
    restore_claude_inner()
}

#[tauri::command]
pub fn run_doctor() -> Result<DoctorResult, String> {
    run_doctor_inner().map_err(|error| error.to_string())
}

pub fn run_doctor_cli() -> Result<DoctorResult> {
    run_doctor_inner()
}

#[tauri::command]
pub fn audit_i18n_resources() -> Result<I18nAuditResult, String> {
    audit_i18n_resources_inner().map_err(|error| error.to_string())
}

pub fn audit_i18n_resources_cli() -> Result<I18nAuditResult> {
    audit_i18n_resources_inner()
}

#[tauri::command]
pub fn read_settings() -> Result<AppSettings, String> {
    read_settings_inner().map_err(|error| error.to_string())
}

pub fn write_settings_cli(settings: AppSettings) -> Result<AppSettings> {
    write_settings_inner(settings)
}

fn scan_claude_installations_inner() -> Result<ScanResult> {
    let settings = read_settings_inner().unwrap_or_default();
    let mut candidates = Vec::new();

    candidates.extend(detect_linux_installations());
    candidates.extend(detect_macos_installations());
    candidates.extend(detect_windows_installations());
    candidates.extend(detect_managed_installations());
    candidates.extend(detect_env_installation());

    let mut seen = BTreeSet::new();
    let mut installations = Vec::new();
    for candidate in candidates {
        let key = candidate.root_path.to_string_lossy().to_string();
        if seen.insert(key) {
            installations.push(candidate);
        }
    }

    installations.sort_by(|left, right| left.label.cmp(&right.label));

    Ok(ScanResult {
        installations,
        selected_installation_id: settings.selected_installation_id,
    })
}

fn install_language_pack_inner(locale: &str) -> Result<OperationResult> {
    let language_pack = language_pack_for_locale(locale)?;

    let selected = selected_installation()?;
    let source = install_source_for_selected(&selected)?;
    let target = prepare_installation_target(&source)?;
    fs::create_dir_all(&target.locales_path).with_context(|| {
        format!(
            "failed to create locales directory {}",
            target.locales_path.display()
        )
    })?;

    let backup_path = backup_locales_if_needed(&target)?;
    let locale_file = target.locales_path.join(format!("{locale}.json"));
    fs::write(&locale_file, language_pack.locale_json)
        .with_context(|| format!("failed to write {}", locale_file.display()))?;
    sync_locale_to_i18n_dir(&target, locale, language_pack.locale_json)?;

    let inject_dir = app_data_dir()?.join("web-inject");
    fs::create_dir_all(&inject_dir)?;
    fs::write(
        inject_dir.join(language_pack.inject_file_name),
        language_pack.web_inject_js,
    )?;
    let translation_dir = app_data_dir()?.join("desktop-translations");
    fs::create_dir_all(&translation_dir)?;
    fs::write(
        translation_dir.join(language_pack.desktop_translation_file_name),
        language_pack.desktop_translation_json,
    )?;
    let original_app_asar_sha256 = sha256_file(&target.app_asar_path).ok();
    let app_asar_patched = patch_asar_main_injection(&target.app_asar_path)?;

    let manifest = InstallManifest {
        app_version: target.version.clone(),
        installed_locale: locale.to_string(),
        language_pack_version: LANGUAGE_PACK_VERSION.to_string(),
        installed_at: OffsetDateTime::now_utc().format(&Rfc3339)?,
        source_root_path: source.root_path.clone(),
        target_root_path: target.root_path.clone(),
        original_app_asar_sha256,
        backup_locales_path: backup_path,
        overlay: source.root_path != target.root_path,
    };
    write_install_manifest(&target, &manifest)?;

    let mut settings = read_settings_inner().unwrap_or_default();
    settings.selected_installation_id = Some(target.id.clone());
    write_settings_inner(settings)?;

    Ok(OperationResult {
        success: true,
        message: if app_asar_patched {
            format!("已安装 {locale} 语言包，并写入 Claude 内部 Plus 入口")
        } else {
            format!("已安装 {locale} 语言包，Claude 内部 Plus 入口已存在")
        },
        installation: Some(read_manifest_into_installation(target)?),
    })
}

fn launch_claude_plus_inner(conflict_strategy: LaunchConflictStrategy) -> Result<OperationResult> {
    let installation = selected_installation()?;
    let target = installation
        .installed_manifest
        .as_ref()
        .map(|manifest| manifest.target_root_path.clone())
        .and_then(|path| {
            build_installation_from_root(&path, "installed", WritableStrategy::UserOverlay).ok()
        })
        .unwrap_or(installation);

    let executable = target
        .executable_path
        .clone()
        .ok_or_else(|| anyhow!("no executable found for {}", target.label))?;

    let settings = read_settings_inner().unwrap_or_default();
    write_claude_config_locale(&settings.locale)?;
    let cdp_injection_enabled = settings.inject_enabled && cdp_injection_opted_in();
    let runtime_locale = runtime_resource_for_locale(&settings.locale);
    let app_data = app_data_dir()?;
    let inject_script_path = app_data
        .join("web-inject")
        .join(runtime_locale.inject_file_name);
    let desktop_translation_path = app_data
        .join("desktop-translations")
        .join(runtime_locale.desktop_translation_file_name);
    ensure_runtime_resources(&runtime_locale)?;
    if let Some(result) =
        handle_running_claude_before_launch(&target, cdp_injection_enabled, conflict_strategy)?
    {
        return Ok(result);
    }

    let inject_port = if cdp_injection_enabled {
        Some(pick_local_port()?)
    } else {
        None
    };
    let mut command = Command::new(&executable);
    command.arg(format!("--lang={}", settings.locale));
    if let Some(port) = inject_port {
        command.arg(format!("--remote-debugging-port={port}"));
        command.arg("--remote-debugging-address=127.0.0.1");
    }
    if cfg!(target_os = "linux") {
        command.arg("--enable-transparent-visuals");
        command.arg(&target.app_asar_path);
        command.env("ELECTRON_FORCE_IS_PACKAGED", "1");
    }
    command.env(
        "CLAUDE_DESKTOP_PLUS_INJECT",
        if settings.inject_enabled { "1" } else { "0" },
    );
    command.env("CLAUDE_DESKTOP_PLUS_INJECT_SCRIPT", &inject_script_path);
    command.env(
        "CLAUDE_DESKTOP_PLUS_TRANSLATION_FILE",
        &desktop_translation_path,
    );
    command.env("CLAUDE_DESKTOP_PLUS_LOCALE", &settings.locale);
    if cdp_injection_enabled {
        command.env("CLAUDE_DESKTOP_PLUS_CDP_INJECT", "1");
    }

    sanitize_external_launch_environment(&mut command);
    configure_detached_launch(&mut command)?;

    let mut child = command
        .spawn()
        .with_context(|| format!("failed to launch {}", executable.display()))?;

    thread::sleep(Duration::from_millis(750));
    if let Some(status) = child.try_wait()? {
        if !status.success() {
            return Ok(OperationResult {
                success: false,
                message: format!("Claude Desktop 启动脚本已退出：{status}"),
                installation: Some(target),
            });
        }
    }

    if let Some(port) = inject_port {
        let script = renderer_injection_script(&settings.locale)?;
        thread::spawn(move || {
            let _ = inject_script_with_cdp(port, &script);
        });
    }

    Ok(OperationResult {
        success: true,
        message: if settings.inject_enabled && !cdp_injection_enabled {
            "Claude Desktop 已启动；Plus 入口将由本地补丁注入".to_string()
        } else {
            "Claude Desktop 已启动".to_string()
        },
        installation: Some(target),
    })
}

fn sanitize_external_launch_environment(command: &mut Command) {
    if cfg!(target_os = "linux") {
        for key in LINUX_EXTERNAL_LAUNCH_ENV_REMOVALS {
            command.env_remove(key);
        }
    }
}

fn configure_detached_launch(command: &mut Command) -> Result<()> {
    let log_dir = app_data_dir()?.join("logs");
    fs::create_dir_all(&log_dir)?;
    let stdout = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("claude-launch.log"))?;
    let stderr = stdout.try_clone()?;
    command.stdin(Stdio::null());
    command.stdout(Stdio::from(stdout));
    command.stderr(Stdio::from(stderr));
    configure_process_group(command);
    Ok(())
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

fn handle_running_claude_before_launch(
    target: &ClaudeInstallation,
    cdp_injection_enabled: bool,
    conflict_strategy: LaunchConflictStrategy,
) -> Result<Option<OperationResult>> {
    let running_processes = find_running_claude_processes(&target.app_asar_path);
    if running_processes.is_empty() {
        return Ok(None);
    }

    let settings = read_settings_inner().unwrap_or_default();
    let locale_matches = running_processes
        .iter()
        .filter(|process| process.uses_target_app_asar && process.is_main_process)
        .any(|process| process.locale.as_deref() == Some(settings.locale.as_str()));

    let already_plus = running_processes
        .iter()
        .any(|process| process.uses_target_app_asar)
        && (!cdp_injection_enabled
            || running_processes
                .iter()
                .any(|process| process.has_remote_debugging))
        && locale_matches;

    if already_plus && conflict_strategy == LaunchConflictStrategy::ReportOnly {
        return Ok(Some(OperationResult {
            success: true,
            message: format!(
                "Claude Desktop Plus 已在运行，PID: {}",
                format_process_ids(&running_processes)
            ),
            installation: Some(target.clone()),
        }));
    }

    if conflict_strategy == LaunchConflictStrategy::PromptToClose {
        match prompt_to_close_running_claude(&running_processes, already_plus)? {
            CloseDecision::Confirmed => {
                close_running_claude_processes(&running_processes)?;
                let remaining = wait_for_claude_processes_to_exit(&target.app_asar_path);
                if remaining.is_empty() {
                    return Ok(None);
                }
                return Ok(Some(OperationResult {
                    success: false,
                    message: format!(
                        "Claude Desktop 仍在运行，请手动退出后再启动增强版，PID: {}",
                        format_process_ids(&remaining)
                    ),
                    installation: Some(target.clone()),
                }));
            }
            CloseDecision::Declined => {
                return Ok(Some(OperationResult {
                    success: already_plus,
                    message: if already_plus {
                        format!(
                            "已保持当前运行的 Claude Desktop Plus，PID: {}",
                            format_process_ids(&running_processes)
                        )
                    } else {
                        format!(
                            "已取消启动。Claude Desktop 正在运行，PID: {}",
                            format_process_ids(&running_processes)
                        )
                    },
                    installation: Some(target.clone()),
                }));
            }
            CloseDecision::NonInteractive => {}
        }
    }

    Ok(Some(OperationResult {
        success: already_plus,
        message: if already_plus {
            format!(
                "Claude Desktop Plus 已在运行，PID: {}",
                format_process_ids(&running_processes)
            )
        } else {
            format!(
                "Claude Desktop 已在运行，请先完全退出 Claude 后再启动增强版，PID: {}",
                format_process_ids(&running_processes)
            )
        },
        installation: Some(target.clone()),
    }))
}

fn prompt_to_close_running_claude(
    processes: &[RunningClaudeProcess],
    already_plus: bool,
) -> Result<CloseDecision> {
    if !io::stdin().is_terminal() {
        return Ok(CloseDecision::NonInteractive);
    }

    if already_plus {
        eprint!(
            "Claude Desktop Plus 已在运行，PID: {}。是否自动关闭后重新启动？[y/N] ",
            format_process_ids(processes)
        );
    } else {
        eprint!(
            "Claude Desktop 已在运行，PID: {}。是否自动关闭后继续启动增强版？[y/N] ",
            format_process_ids(processes)
        );
    }
    io::stderr().flush()?;

    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    let normalized = answer.trim().to_ascii_lowercase();
    if matches!(normalized.as_str(), "y" | "yes") {
        Ok(CloseDecision::Confirmed)
    } else {
        Ok(CloseDecision::Declined)
    }
}

fn wait_for_claude_processes_to_exit(target_app_asar: &Path) -> Vec<RunningClaudeProcess> {
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut remaining = Vec::new();

    while Instant::now() < deadline {
        remaining = find_running_claude_processes(target_app_asar);
        if remaining.is_empty() {
            return remaining;
        }
        thread::sleep(Duration::from_millis(300));
    }

    remaining
}

fn close_running_claude_processes(processes: &[RunningClaudeProcess]) -> Result<()> {
    let mut main_pids: Vec<_> = processes
        .iter()
        .filter(|process| process.is_main_process)
        .map(|process| process.pid)
        .collect();
    if main_pids.is_empty() {
        main_pids = processes.iter().map(|process| process.pid).collect();
    }
    main_pids.sort_unstable();
    main_pids.dedup();

    for pid in main_pids {
        terminate_process(pid)?;
    }
    Ok(())
}

#[cfg(unix)]
fn terminate_process(pid: u32) -> Result<()> {
    let result = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    if result == 0 {
        Ok(())
    } else {
        Err(anyhow!(
            "failed to terminate Claude Desktop process {pid}: {}",
            io::Error::last_os_error()
        ))
    }
}

#[cfg(windows)]
fn terminate_process(pid: u32) -> Result<()> {
    let status = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!("Stop-Process -Id {pid} -Force"),
        ])
        .status()
        .or_else(|_| {
            Command::new("pwsh")
                .args([
                    "-NoProfile",
                    "-Command",
                    &format!("Stop-Process -Id {pid} -Force"),
                ])
                .status()
        })?;

    if status.success() {
        Ok(())
    } else {
        Err(anyhow!("failed to terminate Claude Desktop process {pid}"))
    }
}

fn restore_claude_inner() -> Result<OperationResult> {
    let installation = selected_installation()?;
    let existing_settings = read_settings_inner().unwrap_or_default();
    if let Some(manifest) = &installation.installed_manifest {
        if manifest.overlay {
            if manifest.target_root_path.exists() {
                fs::remove_dir_all(&manifest.target_root_path).with_context(|| {
                    format!("failed to remove {}", manifest.target_root_path.display())
                })?;
            }
        } else if let Some(backup_path) = &manifest.backup_locales_path {
            if backup_path.exists() {
                if installation.locales_path.exists() {
                    fs::remove_dir_all(&installation.locales_path)?;
                }
                copy_dir(backup_path, &installation.locales_path)?;
            }
            remove_i18n_locale_files(&installation, &manifest.installed_locale)?;
            remove_install_manifest(&installation)?;
        }
    }

    remove_launcher_shortcut(&existing_settings)?;
    let mut settings = read_settings_inner().unwrap_or_default();
    settings.selected_installation_id = None;
    settings.quick_start_completed = false;
    settings.launcher_created_at = None;
    settings.launcher_path = None;
    write_settings_inner(settings)?;

    Ok(OperationResult {
        success: true,
        message: "已恢复 Claude Desktop Plus 改动".to_string(),
        installation: None,
    })
}

fn setup_quick_start_inner(conflict_strategy: SetupConflictStrategy) -> Result<SetupResult> {
    let scan = scan_claude_installations_inner()?;
    let selected = select_installation_from_scan(&scan, &read_settings_inner().unwrap_or_default())
        .ok_or_else(|| anyhow!("no Claude Desktop installation found"))?;
    let running_processes = find_running_claude_processes(&selected.app_asar_path);
    if !running_processes.is_empty() {
        match conflict_strategy {
            SetupConflictStrategy::ReportOnly => {
                return Ok(SetupResult {
                    success: false,
                    message: format!(
                        "Claude Desktop 正在运行，PID: {}。请确认关闭后继续配置增强版。",
                        format_process_ids(&running_processes)
                    ),
                    installation: Some(selected),
                    launcher_path: None,
                    doctor: None,
                    requires_close_confirmation: true,
                });
            }
            SetupConflictStrategy::CloseRunningClaude | SetupConflictStrategy::PromptToClose => {
                let decision = if conflict_strategy == SetupConflictStrategy::PromptToClose {
                    prompt_to_close_running_claude(&running_processes, false)?
                } else {
                    CloseDecision::Confirmed
                };
                match decision {
                    CloseDecision::Confirmed => {
                        close_running_claude_processes(&running_processes)?;
                        let remaining = wait_for_claude_processes_to_exit(&selected.app_asar_path);
                        if !remaining.is_empty() {
                            return Ok(SetupResult {
                                success: false,
                                message: format!(
                                    "Claude Desktop 仍在运行，请手动退出后再配置增强版，PID: {}",
                                    format_process_ids(&remaining)
                                ),
                                installation: Some(selected),
                                launcher_path: None,
                                doctor: None,
                                requires_close_confirmation: true,
                            });
                        }
                    }
                    CloseDecision::Declined | CloseDecision::NonInteractive => {
                        return Ok(SetupResult {
                            success: false,
                            message: format!(
                                "已取消配置。Claude Desktop 正在运行，PID: {}",
                                format_process_ids(&running_processes)
                            ),
                            installation: Some(selected),
                            launcher_path: None,
                            doctor: None,
                            requires_close_confirmation: false,
                        });
                    }
                }
            }
        }
    }

    let mut settings = read_settings_inner().unwrap_or_default();
    settings.selected_installation_id = Some(selected.id.clone());
    settings.locale = DEFAULT_LOCALE.to_string();
    settings.inject_enabled = true;
    write_settings_inner(settings)?;

    let install_result = install_language_pack_inner(DEFAULT_LOCALE)?;
    let launcher_path = create_platform_launcher_shortcut()?;
    let doctor = run_doctor_inner()?;

    let mut settings = read_settings_inner().unwrap_or_default();
    settings.quick_start_completed = true;
    settings.launcher_created_at = Some(OffsetDateTime::now_utc().format(&Rfc3339)?);
    settings.launcher_path = Some(launcher_path.clone());
    if settings.selected_installation_id.is_none() {
        if let Some(installation) = &install_result.installation {
            settings.selected_installation_id = Some(installation.id.clone());
        }
    }
    write_settings_inner(settings)?;

    Ok(SetupResult {
        success: true,
        message: "已配置增强版 Claude Desktop，并创建启动图标".to_string(),
        installation: install_result.installation,
        launcher_path: Some(launcher_path),
        doctor: Some(doctor),
        requires_close_confirmation: false,
    })
}

fn create_launcher_shortcut_inner() -> Result<OperationResult> {
    let launcher_path = create_platform_launcher_shortcut()?;
    let mut settings = read_settings_inner().unwrap_or_default();
    settings.launcher_created_at = Some(OffsetDateTime::now_utc().format(&Rfc3339)?);
    settings.launcher_path = Some(launcher_path.clone());
    write_settings_inner(settings)?;

    Ok(OperationResult {
        success: true,
        message: format!("已创建启动图标：{}", launcher_path.display()),
        installation: selected_installation().ok(),
    })
}

fn create_platform_launcher_shortcut() -> Result<PathBuf> {
    let executable = current_executable_path()?;
    if cfg!(target_os = "linux") {
        create_linux_launcher_shortcut(&executable)
    } else if cfg!(target_os = "macos") {
        create_macos_launcher_app(&executable)
    } else if cfg!(target_os = "windows") {
        create_windows_launcher_shortcuts(&executable)
    } else {
        Err(anyhow!(
            "launcher shortcut is not supported on {}",
            env::consts::OS
        ))
    }
}

fn current_executable_path() -> Result<PathBuf> {
    if cfg!(target_os = "linux") {
        if let Some(appimage) = env::var_os("APPIMAGE") {
            return Ok(PathBuf::from(appimage));
        }
    }
    env::current_exe().context("failed to resolve current executable path")
}

#[cfg(target_os = "linux")]
fn create_linux_launcher_shortcut(executable: &Path) -> Result<PathBuf> {
    let applications_dir = dirs::data_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| anyhow!("could not resolve user applications directory"))?
        .join("applications");
    fs::create_dir_all(&applications_dir)?;
    let desktop_path = applications_dir.join("claude-desktop-plus.desktop");
    fs::write(&desktop_path, linux_desktop_entry(executable))?;
    set_executable_permission(&desktop_path)?;
    Ok(desktop_path)
}

#[cfg(not(target_os = "linux"))]
fn create_linux_launcher_shortcut(_executable: &Path) -> Result<PathBuf> {
    Err(anyhow!(
        "Linux launcher shortcuts are only supported on Linux"
    ))
}

fn linux_desktop_entry(executable: &Path) -> String {
    let exec = shell_quote(&executable.to_string_lossy());
    format!(
        "[Desktop Entry]\nType=Application\nName=Claude Desktop Plus\nComment=Launch enhanced Claude Desktop\nExec={exec} launch\nIcon=claude-desktop-plus\nTerminal=false\nCategories=Utility;Development;\nStartupNotify=true\n"
    )
}

#[cfg(target_os = "macos")]
fn create_macos_launcher_app(executable: &Path) -> Result<PathBuf> {
    let launcher_root = app_data_dir()?.join("Claude Desktop Plus.app");
    let contents_dir = launcher_root.join("Contents");
    let macos_dir = contents_dir.join("MacOS");
    fs::create_dir_all(&macos_dir)?;
    fs::write(contents_dir.join("Info.plist"), macos_launcher_info_plist())?;
    let script_path = macos_dir.join("Claude Desktop Plus");
    fs::write(&script_path, macos_launcher_script(executable))?;
    set_executable_permission(&script_path)?;
    Ok(launcher_root)
}

#[cfg(not(target_os = "macos"))]
fn create_macos_launcher_app(_executable: &Path) -> Result<PathBuf> {
    Err(anyhow!("macOS launcher apps are only supported on macOS"))
}

#[cfg(any(target_os = "macos", test))]
fn macos_launcher_info_plist() -> String {
    r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Claude Desktop Plus</string>
  <key>CFBundleIdentifier</key>
  <string>dev.claude-desktop-plus.launcher</string>
  <key>CFBundleName</key>
  <string>Claude Desktop Plus</string>
  <key>CFBundleDisplayName</key>
  <string>Claude Desktop Plus</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>10.15</string>
</dict>
</plist>
"#
    .to_string()
}

#[cfg(any(target_os = "macos", test))]
fn macos_launcher_script(executable: &Path) -> String {
    format!(
        "#!/bin/sh\nexec {} launch\n",
        shell_quote(&executable.to_string_lossy())
    )
}

#[cfg(target_os = "windows")]
fn create_windows_launcher_shortcuts(executable: &Path) -> Result<PathBuf> {
    let start_menu = dirs::data_dir()
        .ok_or_else(|| anyhow!("could not resolve Windows Start Menu directory"))?
        .join("Microsoft\\Windows\\Start Menu\\Programs");
    fs::create_dir_all(&start_menu)?;
    let start_menu_link = start_menu.join("Claude Desktop Plus.lnk");
    create_windows_lnk(&start_menu_link, executable)?;

    if let Some(desktop_dir) = dirs::desktop_dir() {
        fs::create_dir_all(&desktop_dir)?;
        let desktop_link = desktop_dir.join("Claude Desktop Plus.lnk");
        let _ = create_windows_lnk(&desktop_link, executable);
    }

    Ok(start_menu_link)
}

#[cfg(not(target_os = "windows"))]
fn create_windows_launcher_shortcuts(_executable: &Path) -> Result<PathBuf> {
    Err(anyhow!(
        "Windows launcher shortcuts are only supported on Windows"
    ))
}

#[cfg(target_os = "windows")]
fn create_windows_lnk(link_path: &Path, executable: &Path) -> Result<()> {
    let script = windows_shortcut_script(link_path, executable)?;
    let status = Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .status()
        .or_else(|_| {
            Command::new("pwsh")
                .args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    &script,
                ])
                .status()
        })?;
    if status.success() {
        Ok(())
    } else {
        Err(anyhow!("failed to create shortcut {}", link_path.display()))
    }
}

#[cfg(any(target_os = "windows", test))]
fn windows_shortcut_script(link_path: &Path, executable: &Path) -> Result<String> {
    Ok(format!(
        "$shell = New-Object -ComObject WScript.Shell; $shortcut = $shell.CreateShortcut({}); $shortcut.TargetPath = {}; $shortcut.Arguments = 'launch'; $shortcut.WorkingDirectory = {}; $shortcut.IconLocation = {}; $shortcut.Save()",
        serde_json::to_string(&link_path.to_string_lossy())?,
        serde_json::to_string(&executable.to_string_lossy())?,
        serde_json::to_string(
            &executable
                .parent()
                .unwrap_or_else(|| Path::new(""))
                .to_string_lossy()
        )?,
        serde_json::to_string(&executable.to_string_lossy())?,
    ))
}

#[cfg(unix)]
fn set_executable_permission(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

#[cfg(not(unix))]
fn set_executable_permission(_path: &Path) -> Result<()> {
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn remove_launcher_shortcut(settings: &AppSettings) -> Result<()> {
    if let Some(path) = &settings.launcher_path {
        remove_launcher_path(path)?;
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(applications_dir) = dirs::data_dir().map(|dir| dir.join("applications")) {
            remove_launcher_path(&applications_dir.join("claude-desktop-plus.desktop"))?;
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(desktop_dir) = dirs::desktop_dir() {
            remove_launcher_path(&desktop_dir.join("Claude Desktop Plus.lnk"))?;
        }
    }
    Ok(())
}

fn remove_launcher_path(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn run_doctor_inner() -> Result<DoctorResult> {
    let scan = scan_claude_installations_inner()?;
    let settings = read_settings_inner().unwrap_or_default();
    let mut checks = Vec::new();

    checks.push(DoctorCheck {
        key: "installation".to_string(),
        status: if scan.installations.is_empty() {
            DoctorStatus::Fail
        } else {
            DoctorStatus::Pass
        },
        message: if scan.installations.is_empty() {
            "未发现 Claude Desktop 安装".to_string()
        } else {
            format!("发现 {} 个 Claude Desktop 安装", scan.installations.len())
        },
    });

    checks.push(DoctorCheck {
        key: "settings".to_string(),
        status: DoctorStatus::Pass,
        message: format!(
            "当前语言：{}，注入：{}",
            settings.locale,
            if settings.inject_enabled {
                "开启"
            } else {
                "关闭"
            }
        ),
    });

    let selected = select_installation_from_scan(&scan, &settings);
    checks.push(DoctorCheck {
        key: "selectedInstallation".to_string(),
        status: if selected.is_some() {
            DoctorStatus::Pass
        } else {
            DoctorStatus::Warn
        },
        message: selected
            .as_ref()
            .map(|installation| format!("当前目标：{}", installation.label))
            .unwrap_or_else(|| "尚未选择安装目标，将使用扫描到的第一个".to_string()),
    });

    if let Some(installation) = selected {
        let running_processes = find_running_claude_processes(&installation.app_asar_path);
        checks.push(DoctorCheck {
            key: "runningProcess".to_string(),
            status: if running_processes.is_empty() {
                DoctorStatus::Pass
            } else if running_processes
                .iter()
                .any(|process| process.uses_target_app_asar)
            {
                DoctorStatus::Pass
            } else {
                DoctorStatus::Warn
            },
            message: if running_processes.is_empty() {
                "当前未发现正在运行的 Claude".to_string()
            } else if running_processes
                .iter()
                .any(|process| process.uses_target_app_asar)
            {
                format!(
                    "增强版 Claude 正在运行，PID: {}",
                    format_process_ids(&running_processes)
                )
            } else {
                format!(
                    "原版 Claude 正在运行，PID: {}",
                    format_process_ids(&running_processes)
                )
            },
        });
        checks.push(DoctorCheck {
            key: "locales".to_string(),
            status: if installation.locales_path.exists() {
                DoctorStatus::Pass
            } else {
                DoctorStatus::Fail
            },
            message: format!("语言目录：{}", installation.locales_path.display()),
        });
        checks.push(DoctorCheck {
            key: "manifest".to_string(),
            status: if installation.installed_manifest.is_some() {
                DoctorStatus::Pass
            } else {
                DoctorStatus::Warn
            },
            message: if installation.installed_manifest.is_some() {
                "已检测到安装记录".to_string()
            } else {
                "未检测到安装记录".to_string()
            },
        });
        let has_main_patch = ASAR_MAIN_PATCH_PATHS.iter().any(|file_path| {
            asar_file_contains_text(
                &installation.app_asar_path,
                file_path,
                ASAR_MAIN_PATCH_MARKER,
            )
            .unwrap_or(false)
        });
        let has_preload_patch = ASAR_RENDERER_PATCH_PATHS.iter().any(|file_path| {
            asar_file_contains_text(
                &installation.app_asar_path,
                file_path,
                ASAR_PRELOAD_PATCH_MARKER,
            )
            .unwrap_or(false)
        });
        checks.push(DoctorCheck {
            key: "appAsarInjection".to_string(),
            status: if has_main_patch && has_preload_patch {
                DoctorStatus::Pass
            } else {
                DoctorStatus::Warn
            },
            message: if has_main_patch && has_preload_patch {
                "Claude 内部 Plus 入口已写入".to_string()
            } else {
                "Claude 内部 Plus 入口未写入，请重新安装语言包".to_string()
            },
        });
    }

    Ok(DoctorResult { checks })
}

fn audit_i18n_resources_inner() -> Result<I18nAuditResult> {
    let installation = selected_installation()?;
    audit_i18n_resources_for_installation(&installation, DEFAULT_LOCALE)
}

fn selected_installation() -> Result<ClaudeInstallation> {
    let scan = scan_claude_installations_inner()?;
    let settings = read_settings_inner().unwrap_or_default();
    select_installation_from_scan(&scan, &settings)
        .ok_or_else(|| anyhow!("no Claude Desktop installation found"))
}

fn select_installation_from_scan(
    scan: &ScanResult,
    settings: &AppSettings,
) -> Option<ClaudeInstallation> {
    settings
        .selected_installation_id
        .as_ref()
        .and_then(|id| {
            scan.installations
                .iter()
                .find(|installation| &installation.id == id)
        })
        .cloned()
        .or_else(|| scan.installations.first().cloned())
}

fn language_pack_for_locale(locale: &str) -> Result<LanguagePackResource> {
    match locale {
        "zh-CN" => Ok(LanguagePackResource {
            locale_json: LANGUAGE_PACK_ZH_CN,
            web_inject_js: WEB_INJECT_ZH_CN,
            desktop_translation_json: DESKTOP_TRANSLATION_ZH_CN,
            inject_file_name: "zh-CN.js",
            desktop_translation_file_name: "zh-CN.json",
        }),
        _ => Err(anyhow!("unsupported locale: {locale}")),
    }
}

fn runtime_resource_for_locale(locale: &str) -> RuntimeLocaleResource {
    let desktop_translation_json = if locale == "zh-CN" {
        DESKTOP_TRANSLATION_ZH_CN
    } else {
        r#"{"menu":{}}"#
    };

    RuntimeLocaleResource {
        web_inject_js: WEB_INJECT_ZH_CN,
        desktop_translation_json,
        inject_file_name: "zh-CN.js",
        desktop_translation_file_name: if locale == "zh-CN" {
            "zh-CN.json"
        } else {
            "passthrough.json"
        },
    }
}

fn renderer_injection_script(locale: &str) -> Result<String> {
    let locale = normalize_locale(locale);
    Ok(format!(
        "window.__CLAUDE_DESKTOP_PLUS_LOCALE__={};\n{}",
        serde_json::to_string(locale)?,
        WEB_INJECT_ZH_CN
    ))
}

fn ensure_runtime_resources(resource: &RuntimeLocaleResource) -> Result<()> {
    let data_dir = app_data_dir()?;
    let inject_dir = data_dir.join("web-inject");
    fs::create_dir_all(&inject_dir)?;
    fs::write(
        inject_dir.join(resource.inject_file_name),
        resource.web_inject_js,
    )?;

    let translation_dir = data_dir.join("desktop-translations");
    fs::create_dir_all(&translation_dir)?;
    fs::write(
        translation_dir.join(resource.desktop_translation_file_name),
        resource.desktop_translation_json,
    )?;
    Ok(())
}

fn install_source_for_selected(selected: &ClaudeInstallation) -> Result<ClaudeInstallation> {
    if !is_managed_overlay_installation(selected) {
        return Ok(selected.clone());
    }

    let scan = scan_claude_installations_inner()?;
    scan.installations
        .into_iter()
        .find(|installation| {
            installation.writable_strategy == WritableStrategy::UserOverlay
                && !is_managed_overlay_installation(installation)
        })
        .ok_or_else(|| anyhow!("no system Claude Desktop installation found for overlay rebuild"))
}

fn is_managed_overlay_installation(installation: &ClaudeInstallation) -> bool {
    let Ok(overlay_root) = app_data_dir().map(|dir| dir.join("claude-overlay")) else {
        return false;
    };
    installation.root_path == overlay_root
}

fn prepare_installation_target(source: &ClaudeInstallation) -> Result<ClaudeInstallation> {
    match source.writable_strategy {
        WritableStrategy::UserOverlay if cfg!(target_os = "linux") => prepare_linux_overlay(source),
        WritableStrategy::CopyAppBundle if cfg!(target_os = "macos") => prepare_macos_copy(source),
        _ => Ok(source.clone()),
    }
}

fn prepare_linux_overlay(source: &ClaudeInstallation) -> Result<ClaudeInstallation> {
    let overlay_root = app_data_dir()?.join("claude-overlay");
    if overlay_root.exists() {
        fs::remove_dir_all(&overlay_root)?;
    }
    let source_resources = source
        .app_asar_path
        .parent()
        .ok_or_else(|| anyhow!("app.asar has no parent"))?;
    copy_dir(source_resources, &overlay_root.join("resources"))?;
    ensure_i18n_compatibility_dir(&overlay_root.join("resources"))?;

    let mut target = build_installation_from_root(
        &overlay_root,
        "linux-user-overlay",
        WritableStrategy::Direct,
    )?;
    target.label = format!("{} 用户副本", source.label);
    target.executable_path = source.executable_path.clone();
    Ok(target)
}

fn prepare_macos_copy(source: &ClaudeInstallation) -> Result<ClaudeInstallation> {
    let app_name = source
        .root_path
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("Claude.app");
    let target_root = app_data_dir()?
        .join("Claude Desktop Plus Apps")
        .join(app_name);
    if target_root.exists() {
        fs::remove_dir_all(&target_root)?;
    }
    copy_dir(&source.root_path, &target_root)?;
    build_installation_from_root(&target_root, "macos-copy", WritableStrategy::Direct)
}

fn detect_linux_installations() -> Vec<ClaudeInstallation> {
    let mut installations = Vec::new();
    for root in [
        PathBuf::from("/usr/lib/claude-desktop-bin"),
        PathBuf::from("/usr/lib/claude-desktop"),
        PathBuf::from("/opt/Claude"),
        PathBuf::from("/opt/claude-desktop"),
    ] {
        if let Ok(installation) =
            build_installation_from_root(&root, "linux", WritableStrategy::UserOverlay)
        {
            installations.push(installation);
        }
    }
    installations
}

fn detect_macos_installations() -> Vec<ClaudeInstallation> {
    let root = PathBuf::from("/Applications/Claude.app");
    build_installation_from_root(&root, "macos", WritableStrategy::CopyAppBundle)
        .map(|installation| vec![installation])
        .unwrap_or_default()
}

fn detect_windows_installations() -> Vec<ClaudeInstallation> {
    let mut roots = Vec::new();
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local_app_data).join("Claude"));
    }
    if let Some(program_files) = env::var_os("ProgramFiles") {
        roots.push(PathBuf::from(program_files).join("Claude"));
    }
    if let Some(program_files_x86) = env::var_os("ProgramFiles(x86)") {
        roots.push(PathBuf::from(program_files_x86).join("Claude"));
    }

    roots
        .into_iter()
        .filter_map(|root| {
            build_installation_from_root(&root, "windows", WritableStrategy::Direct).ok()
        })
        .collect()
}

fn detect_managed_installations() -> Vec<ClaudeInstallation> {
    let mut installations = Vec::new();
    if let Ok(data_dir) = app_data_dir() {
        for (path, source, strategy) in [
            (
                data_dir.join("claude-overlay"),
                "managed-overlay",
                WritableStrategy::Direct,
            ),
            (
                data_dir.join("Claude Desktop Plus Apps/Claude.app"),
                "managed-macos-copy",
                WritableStrategy::Direct,
            ),
        ] {
            if let Ok(installation) = build_installation_from_root(&path, source, strategy) {
                installations.push(installation);
            }
        }
    }
    installations
}

fn detect_env_installation() -> Vec<ClaudeInstallation> {
    env::var_os("CLAUDE_DESKTOP_PLUS_TARGET")
        .map(PathBuf::from)
        .and_then(|root| build_installation_from_root(&root, "env", WritableStrategy::Direct).ok())
        .map(|installation| vec![installation])
        .unwrap_or_default()
}

fn build_installation_from_root(
    root: &Path,
    source: &str,
    strategy: WritableStrategy,
) -> Result<ClaudeInstallation> {
    let app_asar_path = find_app_asar(root)
        .ok_or_else(|| anyhow!("app.asar not found under {}", root.display()))?;
    let resources_path = app_asar_path
        .parent()
        .ok_or_else(|| anyhow!("app.asar has no parent"))?
        .to_path_buf();
    let locales_path = resources_path.join("locales");
    let package_json_path = resources_path.join("app.asar");
    let version =
        read_version_from_asar_header(&package_json_path).or_else(|| read_package_version(root));
    let executable_path = find_executable(root);
    let manifest = read_install_manifest(root).ok();

    Ok(ClaudeInstallation {
        id: stable_id(root),
        label: build_label(root, source),
        platform: env::consts::OS.to_string(),
        source: source.to_string(),
        root_path: root.to_path_buf(),
        app_asar_path,
        locales_path,
        executable_path,
        version,
        writable_strategy: strategy,
        installed_manifest: manifest,
    })
}

fn find_app_asar(root: &Path) -> Option<PathBuf> {
    let direct = root.join(APP_ASAR_RELATIVE_PATH);
    if direct.is_file() {
        return Some(direct);
    }

    let macos = root.join("Contents/Resources/app.asar");
    if macos.is_file() {
        return Some(macos);
    }

    let windows = root.join("resources/app.asar");
    if windows.is_file() {
        return Some(windows);
    }

    find_file_by_name(root, "app.asar", 4)
}

fn find_executable(root: &Path) -> Option<PathBuf> {
    if cfg!(target_os = "linux") {
        for candidate in [
            PathBuf::from("/usr/bin/electron39"),
            PathBuf::from("/usr/bin/electron37"),
            PathBuf::from("/usr/bin/electron"),
            PathBuf::from("/usr/lib/electron39/electron"),
            PathBuf::from("/usr/lib/electron37/electron"),
        ] {
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    let candidates = [
        root.join("claude"),
        PathBuf::from("/usr/lib/claude-desktop-bin/claude"),
        PathBuf::from("/usr/lib/claude-desktop/claude"),
        root.join("electron"),
        root.join("Claude.exe"),
        root.join("Update.exe"),
        root.join("Contents/MacOS/Claude"),
    ];
    candidates.into_iter().find(|candidate| candidate.exists())
}

fn find_running_claude_processes(target_app_asar: &Path) -> Vec<RunningClaudeProcess> {
    #[cfg(target_os = "linux")]
    {
        find_running_claude_processes_linux(target_app_asar)
    }

    #[cfg(target_os = "macos")]
    {
        find_running_claude_processes_macos(target_app_asar)
    }

    #[cfg(target_os = "windows")]
    {
        find_running_claude_processes_windows(target_app_asar)
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = target_app_asar;
        Vec::new()
    }
}

#[cfg(target_os = "linux")]
fn find_running_claude_processes_linux(target_app_asar: &Path) -> Vec<RunningClaudeProcess> {
    let current_pid = std::process::id();
    let Ok(entries) = fs::read_dir("/proc") else {
        return Vec::new();
    };

    let mut processes: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            let pid = entry.file_name().to_string_lossy().parse::<u32>().ok()?;
            if pid == current_pid {
                return None;
            }

            let args = read_proc_cmdline(pid)?;
            classify_claude_process(pid, &args, target_app_asar)
        })
        .collect();

    processes.sort_by_key(|process| (!process.is_main_process, process.pid));
    processes
}

#[cfg(target_os = "linux")]
fn read_proc_cmdline(pid: u32) -> Option<Vec<String>> {
    let bytes = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    if bytes.is_empty() {
        return None;
    }

    let args: Vec<_> = bytes
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).into_owned())
        .collect();

    if args.is_empty() {
        None
    } else {
        Some(args)
    }
}

#[cfg(target_os = "macos")]
fn find_running_claude_processes_macos(target_app_asar: &Path) -> Vec<RunningClaudeProcess> {
    let output = Command::new("ps").args(["-axo", "pid=,command="]).output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    let current_pid = std::process::id();
    let mut processes: Vec<_> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let (pid_text, command_line) = line.split_once(' ')?;
            if !command_line.contains("Claude") && !command_line.contains("claude") {
                return None;
            }
            let pid = pid_text.parse::<u32>().ok()?;
            if pid == current_pid {
                return None;
            }
            let args = split_process_command_line(command_line);
            classify_claude_process(pid, &args, target_app_asar)
        })
        .collect();

    processes.sort_by_key(|process| (!process.is_main_process, process.pid));
    processes
}

#[cfg(target_os = "windows")]
fn find_running_claude_processes_windows(target_app_asar: &Path) -> Vec<RunningClaudeProcess> {
    let script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(Claude|claude|electron).*\\.exe$' -or $_.CommandLine -match 'Claude|claude-desktop' } | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }";
    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", script])
        .output()
        .or_else(|_| {
            Command::new("pwsh")
                .args(["-NoProfile", "-Command", script])
                .output()
        });
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    let current_pid = std::process::id();
    let mut processes: Vec<_> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let (pid_text, command_line) = line.split_once('\t')?;
            let pid = pid_text.trim().parse::<u32>().ok()?;
            if pid == current_pid {
                return None;
            }
            let args = split_process_command_line(command_line);
            classify_claude_process(pid, &args, target_app_asar)
        })
        .collect();

    processes.sort_by_key(|process| (!process.is_main_process, process.pid));
    processes
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn split_process_command_line(command_line: &str) -> Vec<String> {
    command_line
        .split_whitespace()
        .map(|part| part.trim_matches('"').to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

fn classify_claude_process(
    pid: u32,
    args: &[String],
    target_app_asar: &Path,
) -> Option<RunningClaudeProcess> {
    let executable = args.first()?;
    let joined_args = args.join(" ");
    let executable_name = Path::new(executable)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("");
    let is_claude_executable = matches!(executable_name, "claude" | "Claude" | "Claude.exe")
        || executable_name.eq_ignore_ascii_case("claude.exe")
        || executable.ends_with("/claude-desktop-bin/claude")
        || executable.ends_with("/claude-desktop/claude")
        || executable.ends_with("Claude.app/Contents/MacOS/Claude")
        || executable.ends_with("\\Claude.exe");

    let has_claude_app_path = args
        .iter()
        .any(|arg| arg.ends_with("resources/app.asar") && is_claude_resource_path(arg))
        || args.iter().any(|arg| {
            arg.strip_prefix("--app-path=")
                .map(|path| path.ends_with("resources/app.asar") && is_claude_resource_path(path))
                .unwrap_or(false)
        });

    let looks_like_claude = is_claude_executable
        || has_claude_app_path
        || joined_args.contains("Claude.app/Contents")
        || joined_args.contains("\\Claude\\")
        || joined_args.contains("/claude-desktop-plus/claude-overlay/");

    if !looks_like_claude {
        return None;
    }

    let target = target_app_asar.to_string_lossy();
    let uses_target_app_asar = args.iter().any(|arg| {
        arg == target.as_ref()
            || arg == &format!("--app-path={target}")
            || arg.contains(target.as_ref())
    }) || joined_args.contains(target.as_ref());
    let has_remote_debugging = args.iter().any(|arg| {
        arg.starts_with("--remote-debugging-port=") || arg.contains(" --remote-debugging-port=")
    }) || joined_args.contains("--remote-debugging-port=");
    let is_main_process = !args.iter().any(|arg| arg.starts_with("--type="));
    let locale = process_locale_from_args(args);

    Some(RunningClaudeProcess {
        pid,
        uses_target_app_asar,
        has_remote_debugging,
        is_main_process,
        locale,
    })
}

fn process_locale_from_args(args: &[String]) -> Option<String> {
    for (index, arg) in args.iter().enumerate() {
        if let Some(locale) = arg
            .strip_prefix("--lang=")
            .or_else(|| arg.strip_prefix("-lang="))
        {
            return Some(normalize_locale(locale).to_string());
        }
        if (arg == "--lang" || arg == "-lang") && index + 1 < args.len() {
            return Some(normalize_locale(&args[index + 1]).to_string());
        }
    }
    None
}

fn is_claude_resource_path(path: &str) -> bool {
    path.contains("/claude-desktop-bin/")
        || path.contains("/claude-desktop/")
        || path.contains("/claude-desktop-plus/claude-overlay/")
        || path.contains("/Claude.app/Contents/")
        || path.contains("\\Claude\\")
        || path.contains("\\claude-desktop\\")
}

fn format_process_ids(processes: &[RunningClaudeProcess]) -> String {
    let ids: Vec<_> = processes
        .iter()
        .filter(|process| process.is_main_process)
        .chain(processes.iter().filter(|process| !process.is_main_process))
        .take(3)
        .map(|process| process.pid.to_string())
        .collect();
    ids.join(", ")
}

fn cdp_injection_opted_in() -> bool {
    matches!(
        env::var("CLAUDE_DESKTOP_PLUS_ENABLE_CDP").ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE")
    )
}

fn pick_local_port() -> Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

fn inject_script_with_cdp(port: u16, script: &str) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut injected_any = false;

    while Instant::now() < deadline {
        if let Ok(targets) = fetch_devtools_targets(port) {
            for target in targets {
                if target.web_socket_debugger_url.is_none() || !target.is_injectable() {
                    continue;
                }
                if inject_target(&target.web_socket_debugger_url.unwrap(), script).is_ok() {
                    injected_any = true;
                }
            }
            if injected_any {
                return Ok(());
            }
        }
        thread::sleep(Duration::from_millis(500));
    }

    if injected_any {
        Ok(())
    } else {
        Err(anyhow!(
            "could not find an injectable Claude DevTools target"
        ))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevToolsTarget {
    #[serde(default)]
    target_type: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    web_socket_debugger_url: Option<String>,
}

impl DevToolsTarget {
    fn is_injectable(&self) -> bool {
        let target_type = self.target_type.as_deref().unwrap_or("");
        if !matches!(target_type, "page" | "webview" | "iframe") {
            return false;
        }

        let url = self.url.as_deref().unwrap_or("");
        url.contains("claude.ai")
            || url.contains("claude.com")
            || url.starts_with("app://")
            || url.starts_with("file://")
    }
}

fn fetch_devtools_targets(port: u16) -> Result<Vec<DevToolsTarget>> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    write!(
        stream,
        "GET /json HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )?;

    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    let body_start = response
        .find("\r\n\r\n")
        .ok_or_else(|| anyhow!("invalid DevTools HTTP response"))?
        + 4;
    let body = &response[body_start..];
    Ok(serde_json::from_str(body)?)
}

fn inject_target(websocket_url: &str, script: &str) -> Result<()> {
    let (mut socket, _) = connect(websocket_url)?;
    let escaped_script = serde_json::to_string(script)?;
    let commands = [
        serde_json::json!({"id": 1, "method": "Page.enable"}),
        serde_json::json!({
            "id": 2,
            "method": "Page.addScriptToEvaluateOnNewDocument",
            "params": {"source": script}
        }),
        serde_json::json!({
            "id": 3,
            "method": "Runtime.evaluate",
            "params": {
                "expression": format!("void Function({escaped_script})()"),
                "awaitPromise": false
            }
        }),
    ];

    for command in commands {
        socket.send(Message::Text(command.to_string().into()))?;
    }
    let _ = socket.close(None);
    Ok(())
}

fn patch_asar_main_injection(app_asar_path: &Path) -> Result<bool> {
    let script_path = app_data_dir()?.join("web-inject").join("zh-CN.js");
    patch_asar_main_injection_with_script(app_asar_path, &script_path)
}

fn patch_asar_main_injection_with_script(app_asar_path: &Path, script_path: &Path) -> Result<bool> {
    let archive = read_asar_archive(app_asar_path)
        .with_context(|| format!("failed to read {}", app_asar_path.display()))?;
    let entries = collect_asar_file_entries(&archive.header)?;
    let mut patched_files = BTreeMap::new();
    for target_path in ASAR_MAIN_PATCH_PATHS
        .iter()
        .chain(ASAR_RENDERER_PATCH_PATHS.iter())
        .copied()
    {
        let Some(entry) = entries
            .iter()
            .find(|entry| entry.display_path == target_path)
        else {
            continue;
        };
        let bytes = read_asar_file_bytes(&archive, entry)?;
        let source = String::from_utf8(bytes)
            .with_context(|| format!("{target_path} is not valid UTF-8"))?;
        let patched = patch_asar_js_file(target_path, &source, script_path)?;
        if patched != source {
            patched_files.insert(target_path.to_string(), patched.into_bytes());
        }
    }

    if patched_files.is_empty() {
        return Ok(false);
    }

    let mut header = archive.header.clone();
    let mut next_offset = 0usize;
    for entry in &entries {
        let patched_bytes = patched_files.get(&entry.display_path);
        let size = if let Some(bytes) = patched_bytes {
            bytes.len()
        } else {
            entry.size
        };
        let node = asar_node_mut(&mut header, &entry.path)?;
        set_asar_file_metadata(node, next_offset, size);
        if let Some(bytes) = patched_bytes {
            node["integrity"] = serde_json::to_value(file_integrity(bytes))?;
        }
        next_offset = next_offset
            .checked_add(size)
            .ok_or_else(|| anyhow!("asar data is too large"))?;
    }

    let header_pickle = make_asar_header_pickle(&header)?;
    let size_pickle = make_asar_size_pickle(header_pickle.len())?;
    let temp_path = app_asar_path.with_file_name(format!(
        "{}.cdp-tmp",
        app_asar_path
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("app.asar")
    ));
    let backup_path = app_asar_path.with_file_name(format!(
        "{}.cdp-bak",
        app_asar_path
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("app.asar")
    ));

    {
        let mut output = fs::File::create(&temp_path)
            .with_context(|| format!("failed to create {}", temp_path.display()))?;
        output.write_all(&size_pickle)?;
        output.write_all(&header_pickle)?;
        for entry in &entries {
            if let Some(bytes) = patched_files.get(&entry.display_path) {
                output.write_all(bytes)?;
            } else {
                let bytes = read_asar_file_bytes(&archive, entry)?;
                output.write_all(&bytes)?;
            }
        }
        output.flush()?;
    }

    if let Ok(metadata) = fs::metadata(app_asar_path) {
        fs::set_permissions(&temp_path, metadata.permissions())?;
    }

    if backup_path.exists() {
        fs::remove_file(&backup_path)?;
    }
    fs::copy(app_asar_path, &backup_path).with_context(|| {
        format!(
            "failed to create temporary backup {}",
            backup_path.display()
        )
    })?;
    if let Err(error) = fs::copy(&temp_path, app_asar_path) {
        let _ = fs::copy(&backup_path, app_asar_path);
        let _ = fs::remove_file(&temp_path);
        let _ = fs::remove_file(&backup_path);
        return Err(error)
            .with_context(|| format!("failed to replace {}", app_asar_path.display()));
    }
    fs::remove_file(&temp_path)?;
    fs::remove_file(&backup_path)?;
    Ok(true)
}

fn patch_asar_js_file(target_path: &str, source: &str, script_path: &Path) -> Result<String> {
    if target_path == ASAR_MAIN_INDEX_PATH {
        return patch_main_index_js(source, script_path);
    }
    if target_path == ASAR_RENDERER_PRELOAD_PATH || target_path == ASAR_WEBVIEW_PRELOAD_PATH {
        return patch_renderer_preload_js(source);
    }

    Ok(source.to_string())
}

fn patch_main_index_js(index_js: &str, script_path: &Path) -> Result<String> {
    let app_data = app_data_dir()?;
    let script_path_json = serde_json::to_string(&script_path.to_string_lossy())?;
    let state_dir_json = serde_json::to_string(&app_data.to_string_lossy())?;
    let injection = format!(
        ";{}\n",
        main_process_injection_code(&script_path_json, &state_dir_json)
    );
    patch_js_with_injection(index_js, ASAR_MAIN_PATCH_MARKER, &injection)
}

fn patch_renderer_preload_js(source: &str) -> Result<String> {
    let injection = format!(";{}\n", preload_injection_code());
    patch_js_with_injection(source, ASAR_PRELOAD_PATCH_MARKER, &injection)
}

fn patch_js_with_injection(source: &str, marker: &str, injection: &str) -> Result<String> {
    if source.contains(marker) {
        return Ok(source.to_string());
    }

    if let Some(index) = source.find("\"use strict\";") {
        let insert_at = index + "\"use strict\";".len();
        let mut patched = String::with_capacity(source.len() + injection.len());
        patched.push_str(&source[..insert_at]);
        patched.push_str(injection);
        patched.push_str(&source[insert_at..]);
        return Ok(patched);
    }

    Ok(format!("{injection}{source}"))
}

fn main_process_injection_code(script_path_json: &str, state_dir_json: &str) -> String {
    format!(
        r#"(function(){{
var MARKER="{ASAR_MAIN_PATCH_MARKER}";
var fs=require("fs");
var path=require("path");
var childProcess=require("child_process");
var stateDir=process.env.CLAUDE_DESKTOP_PLUS_STATE_DIR||{state_dir_json};
var logPath=path.join(stateDir,"logs","inject.log");
function writeLog(message){{
try{{
fs.mkdirSync(path.dirname(logPath),{{recursive:true}});
fs.appendFileSync(logPath,new Date().toISOString()+" "+message+"\n");
}}catch(_e){{}}
}}
try{{
writeLog(MARKER+" bootstrap");
if(globalThis.__ClaudeDesktopPlusMainInjectV12)return;
globalThis.__ClaudeDesktopPlusMainInjectV12=true;
if(process.env.CLAUDE_DESKTOP_PLUS_INJECT==="0"){{writeLog(MARKER+" disabled by env");return;}}
process.env.ELECTRON_FORCE_IS_PACKAGED=process.env.ELECTRON_FORCE_IS_PACKAGED||"1";
var electron=require("electron");
var scriptPath=process.env.CLAUDE_DESKTOP_PLUS_INJECT_SCRIPT||{script_path_json};
var translationPath=process.env.CLAUDE_DESKTOP_PLUS_TRANSLATION_FILE||path.join(stateDir,"desktop-translations","zh-CN.json");
var selectedLocale=process.env.CLAUDE_DESKTOP_PLUS_LOCALE||"zh-CN";
var IPC_SET_LOCALE="claude-desktop-plus:set-locale";
var IPC_SET_LOCALE_AND_RELAUNCH="claude-desktop-plus:set-locale-and-relaunch";
var IPC_GET_LOCALE="claude-desktop-plus:get-locale";
var IPC_LOG="claude-desktop-plus:log";
var cachedScript=null;
var cachedTranslation=null;
var configWatchInstalled=false;
var configWatchLastLocale=null;
var relaunchInFlight=false;
function supportedLocale(locale){{
return ["en-US","de-DE","es-ES","es-419","fr-FR","hi-IN","id-ID","it-IT","ja-JP","ko-KR","pt-BR","zh-CN"].indexOf(locale)!==-1;
}}
function forceElectronLocale(locale){{
try{{
if(!supportedLocale(locale))return;
var app=electron.app;
if(app&&app.commandLine){{
try{{app.commandLine.appendSwitch("lang",locale);}}catch(error){{writeLog("append lang switch failed "+(error&&error.message?error.message:error));}}
}}
process.env.LANG=locale+".UTF-8";
process.env.LANGUAGE=locale.replace("-","_");
if(app&&!app.__claudeDesktopPlusLocaleOverride){{
app.__claudeDesktopPlusLocaleOverride=true;
var originalGetLocale=typeof app.getLocale==="function"?app.getLocale.bind(app):null;
var originalGetPreferred=typeof app.getPreferredSystemLanguages==="function"?app.getPreferredSystemLanguages.bind(app):null;
app.getLocale=function(){{return selectedLocale;}};
app.getPreferredSystemLanguages=function(){{
var values=[];
try{{values=originalGetPreferred?originalGetPreferred():[];}}catch(_error){{values=[];}}
values=Array.isArray(values)?values.filter(function(value){{return value&&value!==selectedLocale;}}):[];
return [selectedLocale].concat(values);
}};
writeLog("electron locale override ready "+locale+" original "+(originalGetLocale?originalGetLocale():"unknown"));
}}
}}catch(error){{writeLog("electron locale override failed "+(error&&error.message?error.message:error));}}
}}
function getScript(){{
if(cachedScript!==null)return cachedScript;
cachedScript="window.__CLAUDE_DESKTOP_PLUS_LOCALE__="+JSON.stringify(selectedLocale)+";\n"+fs.readFileSync(scriptPath,"utf8");
return cachedScript;
}}
function getTranslation(){{
if(cachedTranslation!==null)return cachedTranslation;
try{{
cachedTranslation=JSON.parse(fs.readFileSync(translationPath,"utf8"));
}}catch(error){{
writeLog("translation load failed "+(error&&error.message?error.message:error));
cachedTranslation={{menu:{{}}}};
}}
return cachedTranslation;
}}
function readJsonFile(filePath,fallback){{
try{{return JSON.parse(fs.readFileSync(filePath,"utf8"));}}catch(_error){{return fallback;}}
}}
function writeJsonFile(filePath,value){{
fs.mkdirSync(path.dirname(filePath),{{recursive:true}});
fs.writeFileSync(filePath,JSON.stringify(value,null,"\t")+"\n","utf8");
}}
function readClaudeLocale(){{
var userData=electron.app.getPath("userData");
var configPath=path.join(userData,"config.json");
var config=readJsonFile(configPath,{{}});
var locale=supportedLocale(config.locale)?config.locale:selectedLocale;
return {{locale:locale,configPath:configPath}};
}}
function readPlusSettingsLocale(){{
try{{
var settingsPath=path.join(stateDir,"settings.json");
var settings=readJsonFile(settingsPath,{{}});
return supportedLocale(settings.locale)?settings.locale:null;
}}catch(_error){{return null;}}
}}
function syncSelectedLocaleFromSettings(){{
var settingsLocale=readPlusSettingsLocale();
if(settingsLocale&&settingsLocale!==selectedLocale){{
writeLog("selected locale loaded from settings "+selectedLocale+" -> "+settingsLocale);
selectedLocale=settingsLocale;
cachedScript=null;
forceElectronLocale(selectedLocale);
}}
return selectedLocale;
}}
function writePlusSettingsLocale(locale){{
try{{
var settingsPath=path.join(stateDir,"settings.json");
var settings=readJsonFile(settingsPath,{{}});
settings.locale=locale;
writeJsonFile(settingsPath,settings);
}}catch(error){{writeLog("plus settings locale write failed "+(error&&error.message?error.message:error));}}
}}
function writeClaudeLocale(locale){{
if(!supportedLocale(locale))throw new Error("unsupported locale: "+locale);
selectedLocale=locale;
cachedScript=null;
forceElectronLocale(locale);
var userData=electron.app.getPath("userData");
var configPath=path.join(userData,"config.json");
var config=readJsonFile(configPath,{{}});
config.locale=locale;
writeJsonFile(configPath,config);
writePlusSettingsLocale(locale);
configWatchLastLocale=locale;
writeLog("locale persisted "+locale+" to "+configPath);
return {{locale:locale,configPath:configPath}};
}}
function removeExistingLangArgs(args){{
var cleaned=[];
for(var index=0;index<args.length;index+=1){{
var arg=String(args[index]||"");
if(arg==="--lang"||arg==="-lang"){{
index+=1;
continue;
}}
if(arg.indexOf("--lang=")===0||arg.indexOf("-lang=")===0){{
continue;
}}
cleaned.push(arg);
}}
return cleaned;
}}
function hasArg(args,value){{
return args.some(function(arg){{return String(arg)===value;}});
}}
function hasAsarArg(args){{
return args.some(function(arg){{return /\.asar(?:$|[\\/?#])/.test(String(arg));}});
}}
function buildRelaunchArgs(locale){{
var args=removeExistingLangArgs(process.argv.slice(1));
args.unshift("--lang="+locale);
if(process.platform==="linux"&&!hasArg(args,"--enable-transparent-visuals")){{
var insertAt=1;
args.splice(insertAt,0,"--enable-transparent-visuals");
}}
if(process.platform==="linux"&&!hasAsarArg(args)){{
try{{
var appPath=electron.app.getAppPath();
if(appPath)args.push(appPath);
}}catch(error){{writeLog("relaunch app path lookup failed "+(error&&error.message?error.message:error));}}
}}
return args;
}}
function setLocaleAndRelaunch(locale){{
var result=writeClaudeLocale(locale);
if(relaunchInFlight){{
result.relaunching=true;
return result;
}}
relaunchInFlight=true;
var args=buildRelaunchArgs(locale);
var env=Object.assign({{}},process.env,{{
CLAUDE_DESKTOP_PLUS_LOCALE:locale,
CLAUDE_DESKTOP_PLUS_INJECT:process.env.CLAUDE_DESKTOP_PLUS_INJECT||"1",
CLAUDE_DESKTOP_PLUS_INJECT_SCRIPT:scriptPath,
CLAUDE_DESKTOP_PLUS_TRANSLATION_FILE:translationPath,
CLAUDE_DESKTOP_PLUS_STATE_DIR:stateDir,
ELECTRON_FORCE_IS_PACKAGED:process.env.ELECTRON_FORCE_IS_PACKAGED||"1"
}});
try{{
writeLog("relaunch locale "+locale+" exec "+process.execPath+" args "+JSON.stringify(args));
var child=childProcess.spawn(process.execPath,args,{{detached:true,stdio:"ignore",env:env}});
child.unref();
result.relaunching=true;
setTimeout(function(){{
try{{electron.app.quit();}}catch(error){{writeLog("app quit failed "+(error&&error.message?error.message:error));}}
setTimeout(function(){{
try{{electron.app.exit(0);}}catch(_error){{process.exit(0);}}
}},900);
}},180);
return result;
}}catch(error){{
relaunchInFlight=false;
writeLog("manual relaunch failed "+(error&&error.message?error.message:error));
try{{
electron.app.relaunch({{args:args}});
result.relaunching=true;
setTimeout(function(){{electron.app.exit(0);}},180);
return result;
}}catch(secondError){{
writeLog("app relaunch failed "+(secondError&&secondError.message?secondError.message:secondError));
throw error;
}}
}}
}}
forceElectronLocale(selectedLocale);
function restoreSelectedLocaleIfNeeded(nextLocale,configPath){{
try{{
if(relaunchInFlight)return;
syncSelectedLocaleFromSettings();
if(nextLocale===selectedLocale)return;
writeLog("config locale restoring "+nextLocale+" -> "+selectedLocale);
writeClaudeLocale(selectedLocale);
}}catch(error){{writeLog("config locale restore failed "+(error&&error.message?error.message:error));}}
}}
function installConfigWatcher(){{
try{{
if(configWatchInstalled)return;
configWatchInstalled=true;
syncSelectedLocaleFromSettings();
var info=readClaudeLocale();
configWatchLastLocale=info.locale;
writeLog("config locale initial "+configWatchLastLocale+" at "+info.configPath);
restoreSelectedLocaleIfNeeded(configWatchLastLocale,info.configPath);
fs.watchFile(info.configPath,{{interval:500}},function(){{
try{{
var latest=readClaudeLocale();
var next=latest.locale;
if(next!==configWatchLastLocale){{
writeLog("config locale changed "+configWatchLastLocale+" -> "+next);
configWatchLastLocale=next;
}}
restoreSelectedLocaleIfNeeded(next,latest.configPath);
}}catch(error){{writeLog("config watch read failed "+(error&&error.message?error.message:error));}}
}});
}}catch(error){{writeLog("config watcher error "+(error&&error.message?error.message:error));}}
}}
function installPlusIpc(){{
try{{
var ipcMain=electron.ipcMain;
if(!ipcMain||ipcMain.__claudeDesktopPlusLocale)return;
ipcMain.__claudeDesktopPlusLocale=true;
ipcMain.handle(IPC_SET_LOCALE,function(_event,locale){{return writeClaudeLocale(locale);}});
ipcMain.handle(IPC_SET_LOCALE_AND_RELAUNCH,function(_event,locale){{return setLocaleAndRelaunch(locale);}});
ipcMain.handle(IPC_GET_LOCALE,function(){{return readClaudeLocale();}});
ipcMain.handle(IPC_LOG,function(_event,message){{writeLog("renderer "+String(message));return true;}});
writeLog("plus locale ipc ready");
}}catch(error){{writeLog("plus ipc error "+(error&&error.message?error.message:error));}}
}}
function installLocaleProtocol(){{
try{{
var protocol=electron.protocol;
if(!protocol||protocol.__claudeDesktopPlusLocale)return;
protocol.__claudeDesktopPlusLocale=true;
function handleRequest(request,callback){{
try{{
var rawUrl=typeof request==="string"?request:(request&&request.url)||"";
var parsed=new URL(rawUrl);
var locale=parsed.searchParams.get("locale")||parsed.hostname||parsed.pathname.replace(/^\/+/,"");
var result=writeClaudeLocale(locale);
var body=JSON.stringify(result);
callback({{statusCode:200,mimeType:"application/json",data:Buffer.from(body)}});
}}catch(error){{
writeLog("locale protocol error "+(error&&error.message?error.message:error));
callback({{statusCode:400,mimeType:"text/plain",data:Buffer.from(String(error&&error.message?error.message:error))}});
}}
}}
if(protocol.handle){{
protocol.handle("claude-desktop-plus",function(request){{
try{{
var parsed=new URL(request.url);
var locale=parsed.searchParams.get("locale")||parsed.hostname||parsed.pathname.replace(/^\/+/,"");
var result=writeClaudeLocale(locale);
return new Response(JSON.stringify(result),{{status:200,headers:{{"content-type":"application/json"}}}});
}}catch(error){{
writeLog("locale protocol handle error "+(error&&error.message?error.message:error));
return new Response(String(error&&error.message?error.message:error),{{status:400}});
}}
}});
}}else if(protocol.registerBufferProtocol){{
protocol.registerBufferProtocol("claude-desktop-plus",handleRequest);
}}else if(protocol.registerStringProtocol){{
protocol.registerStringProtocol("claude-desktop-plus",function(request,callback){{
try{{
var rawUrl=typeof request==="string"?request:(request&&request.url)||"";
var parsed=new URL(rawUrl);
var locale=parsed.searchParams.get("locale")||parsed.hostname||parsed.pathname.replace(/^\/+/,"");
var result=writeClaudeLocale(locale);
callback(JSON.stringify(result));
}}catch(error){{
writeLog("locale protocol string error "+(error&&error.message?error.message:error));
callback(String(error&&error.message?error.message:error));
}}
}});
}}
writeLog("plus locale protocol ready");
}}catch(error){{writeLog("plus protocol error "+(error&&error.message?error.message:error));}}
}}
function localizeMenuItem(item,menuMap){{
if(!item)return;
if(item.label){{
var label=String(item.label);
var normalized=label.replace(/\s+/g," ").trim();
if(menuMap[label])item.label=menuMap[label];
else if(menuMap[normalized])item.label=label.replace(normalized,menuMap[normalized]);
}}
if(item.submenu&&item.submenu.items)item.submenu.items.forEach(function(child){{localizeMenuItem(child,menuMap);}});
}}
function localizeMenu(menu){{
try{{
var menuMap=getTranslation().menu||{{}};
if(menu&&menu.items)menu.items.forEach(function(item){{localizeMenuItem(item,menuMap);}});
return menu;
}}catch(error){{writeLog("menu localize failed "+(error&&error.message?error.message:error));return menu;}}
}}
function installMenuLocalization(){{
try{{
var Menu=electron.Menu;
if(!Menu||Menu.__claudeDesktopPlusLocalized)return;
Menu.__claudeDesktopPlusLocalized=true;
var originalBuildFromTemplate=Menu.buildFromTemplate.bind(Menu);
Menu.buildFromTemplate=function(template){{
var menu=originalBuildFromTemplate(template);
return localizeMenu(menu);
}};
var originalSetApplicationMenu=Menu.setApplicationMenu.bind(Menu);
Menu.setApplicationMenu=function(menu){{
return originalSetApplicationMenu(localizeMenu(menu));
}};
var current=Menu.getApplicationMenu&&Menu.getApplicationMenu();
if(current)Menu.setApplicationMenu(current);
setTimeout(function(){{
try{{
var latest=Menu.getApplicationMenu&&Menu.getApplicationMenu();
if(latest)originalSetApplicationMenu(localizeMenu(latest));
}}catch(error){{writeLog("menu delayed localize failed "+(error&&error.message?error.message:error));}}
}},1200);
writeLog("menu localization ready");
}}catch(error){{writeLog("menu localization error "+(error&&error.message?error.message:error));}}
}}
function skipTarget(wc){{
var url="";
try{{url=wc.getURL()||"";}}catch(_e){{}}
return /^(devtools|chrome|chrome-extension):/.test(url)||url.indexOf("isolated-segment")!==-1;
}}
function inject(wc){{
try{{
if(wc.isDestroyed&&wc.isDestroyed())return;
if(skipTarget(wc))return;
var url="";
try{{url=wc.getURL()||"";}}catch(_e){{}}
wc.executeJavaScript(getScript(),true).then(function(){{
writeLog("injected "+url);
}}).catch(function(error){{
writeLog("inject failed "+url+" "+(error&&error.message?error.message:error));
console.log("[ClaudeDesktopPlus] inject failed: "+(error&&error.message?error.message:error));
}});
}}catch(error){{writeLog("inject error "+(error&&error.message?error.message:error));console.log("[ClaudeDesktopPlus] inject error: "+(error&&error.message?error.message:error));}}
}}
electron.app.on("web-contents-created",function(_event,wc){{
wc.on("dom-ready",function(){{inject(wc);}});
wc.on("did-navigate",function(){{setTimeout(function(){{inject(wc);}},250);}});
wc.on("did-finish-load",function(){{setTimeout(function(){{inject(wc);}},250);}});
}});
electron.app.whenReady().then(function(){{
try{{
installMenuLocalization();
installPlusIpc();
installConfigWatcher();
installLocaleProtocol();
electron.webContents.getAllWebContents().forEach(function(wc){{inject(wc);}});
}}catch(error){{writeLog("ready sweep failed "+(error&&error.message?error.message:error));}}
}});
installMenuLocalization();
installPlusIpc();
installConfigWatcher();
writeLog(MARKER+" ready");
console.log("[ClaudeDesktopPlus] "+MARKER+" ready");
}}catch(error){{writeLog(MARKER+" setup error "+(error&&error.stack?error.stack:(error&&error.message?error.message:error)));console.log("[ClaudeDesktopPlus] setup error: "+(error&&error.message?error.message:error));}}
}})();"#
    )
}

fn preload_injection_code() -> String {
    format!(
        r#"(function(){{
var MARKER="{ASAR_PRELOAD_PATCH_MARKER}";
try{{
if(globalThis.__ClaudeDesktopPlusPreloadInjectV3)return;
globalThis.__ClaudeDesktopPlusPreloadInjectV3=true;
var electron=require("electron");
var ipcRenderer=electron&&electron.ipcRenderer;
var contextBridge=electron&&electron.contextBridge;
if(!ipcRenderer||!contextBridge)return;
contextBridge.exposeInMainWorld("claudeDesktopPlus",{{
setLocale:function(locale){{return ipcRenderer.invoke("claude-desktop-plus:set-locale",locale);}},
setLocaleAndRelaunch:function(locale){{return ipcRenderer.invoke("claude-desktop-plus:set-locale-and-relaunch",locale);}},
getLocale:function(){{return ipcRenderer.invoke("claude-desktop-plus:get-locale");}},
log:function(message){{return ipcRenderer.invoke("claude-desktop-plus:log",message);}}
}});
}}catch(_error){{}}
}})();"#
    )
}

fn asar_file_contains_text(app_asar_path: &Path, file_path: &str, needle: &str) -> Result<bool> {
    let archive = read_asar_archive(app_asar_path)?;
    let entries = collect_asar_file_entries(&archive.header)?;
    let Some(entry) = entries.iter().find(|entry| entry.display_path == file_path) else {
        return Ok(false);
    };
    let bytes = read_asar_file_bytes(&archive, entry)?;
    Ok(String::from_utf8_lossy(&bytes).contains(needle))
}

fn read_asar_archive(path: &Path) -> Result<AsarArchive> {
    parse_asar_archive_bytes(fs::read(path)?)
}

fn parse_asar_archive_bytes(bytes: Vec<u8>) -> Result<AsarArchive> {
    if bytes.len() < 16 {
        return Err(anyhow!("asar archive is too small"));
    }

    let size_pickle_payload = read_u32_le(&bytes, 0)? as usize;
    if size_pickle_payload < 4 {
        return Err(anyhow!("invalid asar size pickle"));
    }

    let header_size = read_u32_le(&bytes, 4)? as usize;
    let header_start = 8usize;
    let header_end = header_start
        .checked_add(header_size)
        .ok_or_else(|| anyhow!("invalid asar header size"))?;
    if bytes.len() < header_end || header_size < 8 {
        return Err(anyhow!("asar header is truncated"));
    }

    let header_payload_size = read_u32_le(&bytes, header_start)? as usize;
    if header_payload_size + 4 != header_size {
        return Err(anyhow!("invalid asar header pickle size"));
    }

    let header_json_len = read_u32_le(&bytes, header_start + 4)? as usize;
    let header_json_start = header_start + 8;
    let header_json_end = header_json_start
        .checked_add(header_json_len)
        .ok_or_else(|| anyhow!("invalid asar header JSON size"))?;
    if header_json_end > header_end {
        return Err(anyhow!("asar header JSON is truncated"));
    }

    let header_json = str::from_utf8(&bytes[header_json_start..header_json_end])?;
    let header = serde_json::from_str(header_json)?;

    Ok(AsarArchive {
        bytes,
        header,
        data_start: header_end,
    })
}

fn collect_asar_file_entries(header: &serde_json::Value) -> Result<Vec<AsarFileEntry>> {
    let mut entries = Vec::new();
    collect_asar_file_entries_from_node(header, Vec::new(), &mut entries)?;
    entries.sort_by_key(|entry| entry.offset);
    Ok(entries)
}

fn collect_asar_file_entries_from_node(
    node: &serde_json::Value,
    path: Vec<String>,
    entries: &mut Vec<AsarFileEntry>,
) -> Result<()> {
    if let Some(files) = node.get("files").and_then(serde_json::Value::as_object) {
        for (name, child) in files {
            let mut child_path = path.clone();
            child_path.push(name.clone());
            collect_asar_file_entries_from_node(child, child_path, entries)?;
        }
        return Ok(());
    }

    if node
        .get("unpacked")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
        || node.get("link").is_some()
    {
        return Ok(());
    }

    if node.get("size").is_none() && node.get("offset").is_none() {
        return Ok(());
    }

    let size = asar_node_size(node)?;
    let offset = asar_node_offset(node)?;
    entries.push(AsarFileEntry {
        display_path: path.join("/"),
        path,
        offset,
        size,
    });
    Ok(())
}

fn asar_node_mut<'a>(
    header: &'a mut serde_json::Value,
    path: &[String],
) -> Result<&'a mut serde_json::Value> {
    let mut node = header;
    for component in path {
        let files = node
            .get_mut("files")
            .and_then(serde_json::Value::as_object_mut)
            .ok_or_else(|| anyhow!("invalid asar directory for {}", path.join("/")))?;
        node = files
            .get_mut(component)
            .ok_or_else(|| anyhow!("asar node not found: {}", path.join("/")))?;
    }
    Ok(node)
}

fn asar_node_size(node: &serde_json::Value) -> Result<usize> {
    let size = node
        .get("size")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| anyhow!("asar file node is missing size"))?;
    usize::try_from(size).context("asar file size does not fit usize")
}

fn asar_node_offset(node: &serde_json::Value) -> Result<usize> {
    let offset = node
        .get("offset")
        .and_then(|value| {
            value
                .as_str()
                .and_then(|text| text.parse::<usize>().ok())
                .or_else(|| {
                    value
                        .as_u64()
                        .and_then(|number| usize::try_from(number).ok())
                })
        })
        .ok_or_else(|| anyhow!("asar file node is missing offset"))?;
    Ok(offset)
}

fn set_asar_file_metadata(node: &mut serde_json::Value, offset: usize, size: usize) {
    node["offset"] = serde_json::Value::String(offset.to_string());
    node["size"] = serde_json::json!(size);
}

fn read_asar_file_bytes(archive: &AsarArchive, entry: &AsarFileEntry) -> Result<Vec<u8>> {
    let start = archive
        .data_start
        .checked_add(entry.offset)
        .ok_or_else(|| anyhow!("invalid asar file offset"))?;
    let end = start
        .checked_add(entry.size)
        .ok_or_else(|| anyhow!("invalid asar file size"))?;
    if end > archive.bytes.len() {
        return Err(anyhow!(
            "asar file is outside archive: {}",
            entry.display_path
        ));
    }
    Ok(archive.bytes[start..end].to_vec())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AsarIntegrity {
    algorithm: &'static str,
    hash: String,
    block_size: usize,
    blocks: Vec<String>,
}

fn file_integrity(bytes: &[u8]) -> AsarIntegrity {
    let hash = sha256_bytes(bytes);
    let mut blocks = Vec::new();
    if bytes.is_empty() {
        blocks.push(sha256_bytes(bytes));
    } else {
        for block in bytes.chunks(ASAR_INTEGRITY_BLOCK_SIZE) {
            blocks.push(sha256_bytes(block));
        }
    }

    AsarIntegrity {
        algorithm: "SHA256",
        hash,
        block_size: ASAR_INTEGRITY_BLOCK_SIZE,
        blocks,
    }
}

fn make_asar_size_pickle(header_size: usize) -> Result<Vec<u8>> {
    let header_size = u32::try_from(header_size).context("asar header is too large")?;
    let mut bytes = Vec::with_capacity(8);
    bytes.extend_from_slice(&4u32.to_le_bytes());
    bytes.extend_from_slice(&header_size.to_le_bytes());
    Ok(bytes)
}

fn make_asar_header_pickle(header: &serde_json::Value) -> Result<Vec<u8>> {
    let header_json = serde_json::to_string(header)?;
    let header_json_len =
        u32::try_from(header_json.len()).context("asar header JSON is too large")?;
    let aligned_json_len = align_to_4(header_json.len());
    let payload_size = 4usize
        .checked_add(aligned_json_len)
        .ok_or_else(|| anyhow!("asar header is too large"))?;
    let payload_size_u32 = u32::try_from(payload_size).context("asar header is too large")?;

    let mut bytes = Vec::with_capacity(4 + payload_size);
    bytes.extend_from_slice(&payload_size_u32.to_le_bytes());
    bytes.extend_from_slice(&header_json_len.to_le_bytes());
    bytes.extend_from_slice(header_json.as_bytes());
    bytes.resize(4 + payload_size, 0);
    Ok(bytes)
}

fn align_to_4(value: usize) -> usize {
    value + ((4 - (value % 4)) % 4)
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Result<u32> {
    let end = offset
        .checked_add(4)
        .ok_or_else(|| anyhow!("invalid u32 offset"))?;
    let slice = bytes
        .get(offset..end)
        .ok_or_else(|| anyhow!("unexpected end of data"))?;
    Ok(u32::from_le_bytes(slice.try_into().expect("slice length")))
}

fn find_file_by_name(root: &Path, name: &str, max_depth: usize) -> Option<PathBuf> {
    if max_depth == 0 || !root.is_dir() {
        return None;
    }

    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.file_name().and_then(OsStr::to_str) == Some(name) && path.is_file() {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_file_by_name(&path, name, max_depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

fn read_version_from_asar_header(app_asar_path: &Path) -> Option<String> {
    let bytes = fs::read(app_asar_path).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    for marker in ["\"version\":\"", "\"version\": \""] {
        if let Some(index) = text.find(marker) {
            let start = index + marker.len();
            let tail = &text[start..];
            let end = tail.find('"')?;
            return Some(tail[..end].to_string());
        }
    }
    None
}

fn read_package_version(root: &Path) -> Option<String> {
    let package_json = find_file_by_name(root, "package.json", 5)?;
    let value: serde_json::Value = serde_json::from_slice(&fs::read(package_json).ok()?).ok()?;
    value.get("version")?.as_str().map(ToOwned::to_owned)
}

fn stable_id(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    format!("{:x}", hasher.finalize())[..16].to_string()
}

fn build_label(root: &Path, source: &str) -> String {
    let name = root
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("Claude Desktop");
    format!("{name} ({source})")
}

fn backup_locales_if_needed(installation: &ClaudeInstallation) -> Result<Option<PathBuf>> {
    if installation.installed_manifest.is_some() || !installation.locales_path.exists() {
        return Ok(None);
    }

    let backup_path = app_data_dir()?
        .join("backups")
        .join(stable_id(&installation.root_path))
        .join("locales");
    if backup_path.exists() {
        fs::remove_dir_all(&backup_path)?;
    }
    copy_dir(&installation.locales_path, &backup_path)?;
    Ok(Some(backup_path))
}

fn read_manifest_into_installation(installation: ClaudeInstallation) -> Result<ClaudeInstallation> {
    build_installation_from_root(
        &installation.root_path,
        &installation.source,
        installation.writable_strategy,
    )
}

fn read_install_manifest(root: &Path) -> Result<InstallManifest> {
    let path = manifest_path(root)?;
    let bytes = fs::read(&path)?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn write_install_manifest(
    installation: &ClaudeInstallation,
    manifest: &InstallManifest,
) -> Result<()> {
    let path = manifest_path(&installation.root_path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_vec_pretty(manifest)?)?;
    Ok(())
}

fn remove_install_manifest(installation: &ClaudeInstallation) -> Result<()> {
    let path = manifest_path(&installation.root_path)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn manifest_path(root: &Path) -> Result<PathBuf> {
    Ok(app_data_dir()?
        .join("manifests")
        .join(stable_id(root))
        .join(INSTALL_MANIFEST_FILE_NAME))
}

fn read_settings_inner() -> Result<AppSettings> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    Ok(normalize_settings(serde_json::from_slice(&fs::read(
        path,
    )?)?))
}

fn write_settings_inner(settings: AppSettings) -> Result<AppSettings> {
    let settings = normalize_settings(settings);
    write_claude_config_locale(&settings.locale)?;
    let path = settings_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_vec_pretty(&settings)?)?;
    Ok(settings)
}

fn write_claude_config_locale(locale: &str) -> Result<()> {
    let locale = normalize_locale(locale);
    let Some(config_dir) = dirs::config_dir() else {
        return Ok(());
    };
    let config_path = config_dir.join("Claude").join("config.json");
    let mut config = if config_path.exists() {
        serde_json::from_slice::<serde_json::Value>(&fs::read(&config_path)?)
            .unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    if !config.is_object() {
        config = serde_json::json!({});
    }
    config["locale"] = serde_json::Value::String(locale.to_string());
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(config_path, serde_json::to_vec_pretty(&config)?)?;
    Ok(())
}

fn normalize_settings(mut settings: AppSettings) -> AppSettings {
    settings.locale = normalize_locale(&settings.locale).to_string();
    settings
}

fn normalize_locale(locale: &str) -> &str {
    if SUPPORTED_LOCALES.contains(&locale) {
        locale
    } else {
        DEFAULT_LOCALE
    }
}

fn settings_path() -> Result<PathBuf> {
    Ok(app_data_dir()?.join(APP_SETTINGS_FILE_NAME))
}

fn app_data_dir() -> Result<PathBuf> {
    let base = dirs::data_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| anyhow!("could not resolve application data directory"))?;
    Ok(base.join("claude-desktop-plus"))
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    if !from.is_dir() {
        return Err(anyhow!("{} is not a directory", from.display()));
    }

    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    if to.exists() {
        fs::remove_dir_all(to)?;
    }
    copy_dir_contents(from, to)
        .with_context(|| format!("failed to copy {} to {}", from.display(), to.display()))?;
    Ok(())
}

fn copy_dir_contents(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let from_path = entry.path();
        let to_path = to.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_dir_contents(&from_path, &to_path)?;
        } else if file_type.is_symlink() {
            copy_symlink(&from_path, &to_path)?;
        } else {
            fs::copy(&from_path, &to_path)?;
            fs::set_permissions(&to_path, entry.metadata()?.permissions())?;
        }
    }
    Ok(())
}

fn ensure_i18n_compatibility_dir(resources_path: &Path) -> Result<()> {
    let locales_path = resources_path.join("locales");
    let i18n_path = resources_path.join("i18n");
    if !locales_path.is_dir() || i18n_path.exists() {
        return Ok(());
    }
    copy_dir(&locales_path, &i18n_path)
}

fn sync_locale_to_i18n_dir(
    installation: &ClaudeInstallation,
    locale: &str,
    locale_json: &str,
) -> Result<()> {
    let Some(resources_path) = installation.locales_path.parent() else {
        return Ok(());
    };
    let i18n_path = resources_path.join("i18n");
    if !i18n_path.is_dir() {
        return Ok(());
    }
    let locale_file = i18n_path.join(format!("{locale}.json"));
    fs::write(&locale_file, locale_json)
        .with_context(|| format!("failed to write {}", locale_file.display()))?;
    Ok(())
}

fn remove_i18n_locale_files(installation: &ClaudeInstallation, locale: &str) -> Result<()> {
    let Some(resources_path) = installation.locales_path.parent() else {
        return Ok(());
    };
    let i18n_path = resources_path.join("i18n");
    if !i18n_path.is_dir() {
        return Ok(());
    }

    for path in [
        i18n_path.join(format!("{locale}.json")),
        i18n_path
            .join("ion-dist")
            .join("i18n")
            .join(format!("{locale}.json")),
        i18n_path
            .join("ion-dist")
            .join("i18n")
            .join("statsig")
            .join(format!("{locale}.json")),
    ] {
        if path.is_file() {
            fs::remove_file(&path)
                .with_context(|| format!("failed to remove {}", path.display()))?;
        }
    }
    Ok(())
}

fn audit_i18n_resources_for_installation(
    installation: &ClaudeInstallation,
    locale: &str,
) -> Result<I18nAuditResult> {
    let mut total_items = 0;
    let mut translated_items = 0;
    let mut untranslated_items = Vec::new();
    for (label, relative_parts) in [
        ("ion-dist", &["ion-dist", "i18n"][..]),
        ("ion-dist/statsig", &["ion-dist", "i18n", "statsig"][..]),
    ] {
        let dir = relative_parts
            .iter()
            .fold(installation.locales_path.to_path_buf(), |path, part| {
                path.join(part)
            });
        let en_us_file = dir.join("en-US.json");
        let locale_file = dir.join(format!("{locale}.json"));
        if !en_us_file.is_file() || !locale_file.is_file() {
            continue;
        }
        let en_us = read_json_string_map(&en_us_file)?;
        let translated = read_json_string_map(&locale_file)?;
        for (key, source) in en_us {
            if !is_probable_ui_text(&source) {
                continue;
            }
            total_items += 1;
            if let Some(target) = translated.get(&key) {
                if target != &source {
                    translated_items += 1;
                    continue;
                }
            }
            let target = translated.get(&key).cloned();
            untranslated_items.push(I18nAuditItem {
                group: label.to_string(),
                key,
                source,
                target,
            });
        }
    }
    Ok(I18nAuditResult {
        installation_id: installation.id.clone(),
        locale: locale.to_string(),
        total_items,
        translated_items,
        untranslated_items,
    })
}

fn is_probable_ui_text(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.chars().all(|character| !character.is_alphabetic()) {
        return false;
    }
    trimmed
        .chars()
        .any(|character| character.is_ascii_alphabetic())
}

fn read_json_string_map(path: &Path) -> Result<BTreeMap<String, String>> {
    let value: BTreeMap<String, String> = serde_json::from_slice(&fs::read(path)?)
        .with_context(|| format!("failed to parse {}", path.display()))?;
    Ok(value)
}

#[cfg(unix)]
fn copy_symlink(from: &Path, to: &Path) -> Result<()> {
    std::os::unix::fs::symlink(fs::read_link(from)?, to)?;
    Ok(())
}

#[cfg(windows)]
fn copy_symlink(from: &Path, to: &Path) -> Result<()> {
    let target = fs::read_link(from)?;
    if target.is_dir() {
        std::os::windows::fs::symlink_dir(target, to)?;
    } else {
        std::os::windows::fs::symlink_file(target, to)?;
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String> {
    let bytes = fs::read(path)?;
    Ok(sha256_bytes(&bytes))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn detects_fixture_installation() {
        let temp = TempDir::new().expect("temp dir");
        let resources = temp.path().join("resources");
        fs::create_dir_all(resources.join("locales")).expect("create locales");
        fs::write(resources.join("app.asar"), br#"{"version":"1.2.3"}"#).expect("write asar");

        let installation =
            build_installation_from_root(temp.path(), "fixture", WritableStrategy::Direct)
                .expect("installation");

        assert_eq!(installation.version.as_deref(), Some("1.2.3"));
        assert_eq!(installation.source, "fixture");
        assert!(installation.locales_path.ends_with("resources/locales"));
    }

    #[test]
    fn default_settings_are_zh_cn_and_injection_enabled() {
        let settings = AppSettings::default();
        assert_eq!(settings.locale, "zh-CN");
        assert!(settings.inject_enabled);
        assert!(!settings.quick_start_completed);
        assert!(settings.launcher_created_at.is_none());
        assert!(settings.launcher_path.is_none());
    }

    #[test]
    fn builds_linux_desktop_entry_for_launch_command() {
        let entry = linux_desktop_entry(Path::new("/opt/Claude Desktop Plus/claude-desktop-plus"));

        assert!(entry.contains("Name=Claude Desktop Plus"));
        assert!(entry.contains("Exec='/opt/Claude Desktop Plus/claude-desktop-plus' launch"));
        assert!(entry.contains("Terminal=false"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn removes_appimage_runtime_environment_for_external_launch() {
        let mut command = Command::new("/usr/bin/electron39");
        command.env("APPIMAGE", "/tmp/Claude Desktop Plus.AppImage");
        command.env("APPDIR", "/tmp/.mount-claude");
        command.env("LD_LIBRARY_PATH", "/tmp/.mount-claude/usr/lib");
        command.env("CLAUDE_DESKTOP_PLUS_LOCALE", "zh-CN");

        sanitize_external_launch_environment(&mut command);
        let envs: BTreeMap<_, _> = command.get_envs().collect();

        assert!(matches!(envs.get(OsStr::new("APPIMAGE")), Some(None)));
        assert!(matches!(envs.get(OsStr::new("APPDIR")), Some(None)));
        assert!(matches!(envs.get(OsStr::new("LD_LIBRARY_PATH")), Some(None)));
        assert_eq!(
            envs.get(OsStr::new("CLAUDE_DESKTOP_PLUS_LOCALE")),
            Some(&Some(OsStr::new("zh-CN")))
        );
    }

    #[test]
    fn builds_macos_launcher_script_for_launch_command() {
        let script = macos_launcher_script(Path::new(
            "/Applications/Claude Desktop Plus.app/Contents/MacOS/claude-desktop-plus",
        ));

        assert!(script.contains("exec '/Applications/Claude Desktop Plus.app/Contents/MacOS/claude-desktop-plus' launch"));
    }

    #[test]
    fn builds_macos_launcher_info_plist() {
        let plist = macos_launcher_info_plist();

        assert!(plist.contains("<key>CFBundleExecutable</key>"));
        assert!(plist.contains("<string>Claude Desktop Plus</string>"));
        assert!(plist.contains("<key>CFBundleIdentifier</key>"));
    }

    #[test]
    fn builds_windows_shortcut_script_for_launch_command() {
        let script = windows_shortcut_script(
            Path::new(r"C:\Users\user\Desktop\Claude Desktop Plus.lnk"),
            Path::new(r"C:\Program Files\Claude Desktop Plus\claude-desktop-plus.exe"),
        )
        .expect("script");

        assert!(script.contains("Claude Desktop Plus.lnk"));
        assert!(script.contains("claude-desktop-plus.exe"));
        assert!(script.contains("$shortcut.Arguments = 'launch'"));
    }

    #[test]
    fn classifies_original_claude_process() {
        let args = vec![
            "/usr/lib/claude-desktop-bin/claude".to_string(),
            "--enable-transparent-visuals".to_string(),
            "/usr/lib/claude-desktop-bin/resources/app.asar".to_string(),
        ];

        let process = classify_claude_process(
            42,
            &args,
            Path::new(
                "/home/user/.local/share/claude-desktop-plus/claude-overlay/resources/app.asar",
            ),
        )
        .expect("process");

        assert!(process.is_main_process);
        assert!(!process.uses_target_app_asar);
        assert!(!process.has_remote_debugging);
    }

    #[test]
    fn classifies_plus_claude_process() {
        let target =
            "/home/user/.local/share/claude-desktop-plus/claude-overlay/resources/app.asar";
        let args = vec![
            "/usr/bin/electron39".to_string(),
            "--lang=ja-JP".to_string(),
            target.to_string(),
            "--remote-debugging-port=45678".to_string(),
        ];

        let process = classify_claude_process(43, &args, Path::new(target)).expect("process");

        assert!(process.is_main_process);
        assert!(process.uses_target_app_asar);
        assert!(process.has_remote_debugging);
        assert_eq!(process.locale.as_deref(), Some("ja-JP"));
    }

    #[test]
    fn classifies_macos_claude_process() {
        let args = vec![
            "/Applications/Claude.app/Contents/MacOS/Claude".to_string(),
            "--flag".to_string(),
        ];

        let process = classify_claude_process(
            45,
            &args,
            Path::new(
                "/Users/user/Library/Application Support/claude-desktop-plus/Claude Desktop Plus Apps/Claude.app/Contents/Resources/app.asar",
            ),
        )
        .expect("process");

        assert!(process.is_main_process);
        assert!(!process.uses_target_app_asar);
    }

    #[test]
    fn classifies_windows_claude_process() {
        let args = vec![
            r"C:\Users\user\AppData\Local\Claude\Claude.exe".to_string(),
            r"--app-path=C:\Users\user\AppData\Local\Claude\resources\app.asar".to_string(),
        ];

        let process = classify_claude_process(
            46,
            &args,
            Path::new(r"C:\Users\user\AppData\Local\Claude\resources\app.asar"),
        )
        .expect("process");

        assert!(process.is_main_process);
        assert!(process.uses_target_app_asar);
    }

    #[test]
    fn prompt_strategy_does_not_short_circuit_plus_processes() {
        let strategy = LaunchConflictStrategy::PromptToClose;
        let already_plus = true;

        assert!(already_plus && strategy == LaunchConflictStrategy::PromptToClose);
    }

    #[test]
    fn extracts_split_lang_argument() {
        let args = vec![
            "/usr/bin/electron39".to_string(),
            "--lang".to_string(),
            "fr-FR".to_string(),
        ];

        assert_eq!(process_locale_from_args(&args).as_deref(), Some("fr-FR"));
    }

    #[test]
    fn patches_main_and_renderer_preload_separately() {
        let main = "\"use strict\";console.log('main');";
        let patched_main =
            patch_main_index_js(main, Path::new("/tmp/zh-CN.js")).expect("patch main");

        assert!(patched_main.contains(ASAR_MAIN_PATCH_MARKER));
        assert!(patched_main.contains("ipcMain.handle"));
        assert!(!patched_main.contains(ASAR_PRELOAD_PATCH_MARKER));

        let renderer = "\"use strict\";d.contextBridge.exposeInMainWorld(\"initialLocale\",Ld);";
        let patched_renderer = patch_renderer_preload_js(renderer).expect("patch preload");

        assert!(patched_renderer.contains(ASAR_PRELOAD_PATCH_MARKER));
        assert!(patched_renderer.contains("contextBridge.exposeInMainWorld(\"claudeDesktopPlus\""));
        assert!(!patched_renderer.contains(ASAR_MAIN_PATCH_MARKER));
        assert_eq!(
            patched_renderer,
            patch_renderer_preload_js(&patched_renderer).expect("patch preload twice")
        );

        let patched_webview = patch_asar_js_file(
            ASAR_WEBVIEW_PRELOAD_PATH,
            renderer,
            Path::new("/tmp/zh-CN.js"),
        )
        .expect("patch webview preload");

        assert!(patched_webview.contains(ASAR_PRELOAD_PATCH_MARKER));
    }

    #[test]
    fn ignores_unrelated_electron_process() {
        let args = vec![
            "/usr/lib/electron39/electron".to_string(),
            "/usr/lib/openai-codex-desktop/resources/app.asar".to_string(),
        ];

        let process = classify_claude_process(
            44,
            &args,
            Path::new(
                "/home/user/.local/share/claude-desktop-plus/claude-overlay/resources/app.asar",
            ),
        );

        assert!(process.is_none());
    }

    #[test]
    fn copies_directory_to_exact_destination() {
        let temp = TempDir::new().expect("temp dir");
        let source = temp.path().join("locales");
        let target = temp.path().join("target").join("locales");
        fs::create_dir_all(&source).expect("create source");
        fs::write(source.join("en-US.json"), "{}").expect("write locale");

        copy_dir(&source, &target).expect("copy dir");

        assert!(target.join("en-US.json").is_file());
        assert!(!target.join("locales").exists());
    }
}
