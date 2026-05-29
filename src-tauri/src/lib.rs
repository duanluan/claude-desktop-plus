pub mod core;

use anyhow::Result;
use clap::{Parser, Subcommand};
use core::{
    audit_i18n_resources, audit_i18n_resources_cli, create_launcher_shortcut,
    create_launcher_shortcut_cli, install_language_pack, install_language_pack_cli,
    launch_claude_plus, launch_claude_plus_cli, read_settings, restore_claude, restore_claude_cli,
    run_doctor, run_doctor_cli, scan_claude_installations, scan_claude_installations_cli,
    setup_quick_start, setup_quick_start_cli, write_settings_cli, AppSettings,
};

#[derive(Debug, Parser)]
#[command(author, version, about)]
struct Cli {
    #[command(subcommand)]
    command: Option<CliCommand>,
}

#[derive(Debug, Subcommand)]
enum CliCommand {
    Scan,
    InstallPack {
        #[arg(long, default_value = "zh-CN")]
        locale: String,
    },
    Setup,
    CreateLauncher,
    Launch,
    Restore,
    Doctor,
    AuditI18n,
}

pub fn run_entrypoint() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Some(CliCommand::Scan) => {
            print_json(&scan_claude_installations_cli()?)?;
        }
        Some(CliCommand::InstallPack { locale }) => {
            print_json(&install_language_pack_cli(&locale)?)?;
        }
        Some(CliCommand::Setup) => {
            print_json(&setup_quick_start_cli()?)?;
        }
        Some(CliCommand::CreateLauncher) => {
            print_json(&create_launcher_shortcut_cli()?)?;
        }
        Some(CliCommand::Launch) => {
            print_json(&launch_claude_plus_cli()?)?;
        }
        Some(CliCommand::Restore) => {
            print_json(&restore_claude_cli()?)?;
        }
        Some(CliCommand::Doctor) => {
            print_json(&run_doctor_cli()?)?;
        }
        Some(CliCommand::AuditI18n) => {
            print_json(&audit_i18n_resources_cli()?)?;
        }
        None => run_tauri_app()?,
    }
    Ok(())
}

fn print_json<T: serde::Serialize>(value: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn run_tauri_app() -> Result<()> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            scan_claude_installations,
            install_language_pack,
            setup_quick_start,
            create_launcher_shortcut,
            launch_claude_plus,
            restore_claude,
            run_doctor,
            audit_i18n_resources,
            read_settings,
            write_settings,
        ])
        .run(tauri::generate_context!())?;
    Ok(())
}

#[tauri::command]
fn write_settings(settings: AppSettings) -> Result<AppSettings, String> {
    write_settings_cli(settings).map_err(|error| error.to_string())
}
