import {invoke} from "@tauri-apps/api/core";
import {defineStore} from "pinia";
import {computed, ref} from "vue";

import type {
  AppSettings,
  ClaudeInstallation,
  DoctorResult,
  OperationResult,
  ScanResult,
  SetupResult,
  UpdateInfo,
  UpdateProgress,
  UpdateStatus,
} from "../types";

type TauriUpdate = {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
  download: (onEvent?: (event: TauriDownloadEvent) => void) => Promise<void>;
  install: () => Promise<void>;
};

type TauriDownloadEvent = {
  event: "Started";
  data: {
    contentLength?: number;
  };
} | {
  event: "Progress";
  data: {
    chunkLength: number;
  };
} | {
  event: "Finished";
};

const defaultSettings: AppSettings = {
  selectedInstallationId: null,
  locale: "zh-CN",
  injectEnabled: true,
  launchAfterInstall: false,
  quickStartCompleted: false,
  launcherCreatedAt: null,
  launcherPath: null,
};

export const useClaudePlusStore = defineStore("claude-plus", () => {
  const installations = ref<ClaudeInstallation[]>([]);
  const settings = ref<AppSettings>({...defaultSettings});
  const doctor = ref<DoctorResult | null>(null);
  const isBusy = ref(false);
  const errorMessage = ref("");
  const lastOperationMessage = ref("");
  const setupStatus = ref<"idle" | "running" | "needsConfirmation" | "completed" | "failed">("idle");
  const pendingSetupResult = ref<SetupResult | null>(null);
  const updateStatus = ref<UpdateStatus>("idle");
  const updateInfo = ref<UpdateInfo | null>(null);
  const updateProgress = ref<UpdateProgress>({
    downloadedBytes: 0,
    contentLength: null,
    percent: null,
  });
  const pendingUpdate = ref<TauriUpdate | null>(null);

  const activeInstallation = computed(() => {
    return installations.value.find(installation => installation.id === settings.value.selectedInstallationId)
      ?? installations.value[0]
      ?? null;
  });

  async function run<T>(task: () => Promise<T>) {
    isBusy.value = true;
    errorMessage.value = "";
    lastOperationMessage.value = "";
    try {
      return await task();
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      isBusy.value = false;
    }
  }

  async function bootstrap() {
    await run(async () => {
      settings.value = await invoke<AppSettings>("read_settings");
      if (!settings.value.quickStartCompleted) {
        const result = await setupQuickStart(false);
        if (result.requiresCloseConfirmation) {
          return;
        }
      } else {
        await scan();
        doctor.value = await invoke<DoctorResult>("run_doctor");
      }
      await checkForUpdate(false);
    });
  }

  async function scan() {
    const result = await invoke<ScanResult>("scan_claude_installations");
    installations.value = result.installations;
    if (result.selectedInstallationId) {
      settings.value.selectedInstallationId = result.selectedInstallationId;
    } else if (!settings.value.selectedInstallationId && result.installations[0]) {
      settings.value.selectedInstallationId = result.installations[0].id;
    }
  }

  async function selectInstallation(id: string) {
    await updateSettings({selectedInstallationId: id});
  }

  async function installPack(locale: string) {
    await run(async () => {
      const result = await invoke<OperationResult>("install_language_pack", {locale});
      lastOperationMessage.value = result.message;
      await scan();
      doctor.value = await invoke<DoctorResult>("run_doctor");
    });
  }

  async function setupQuickStart(confirmClose: boolean) {
    setupStatus.value = "running";
    const result = await invoke<SetupResult>("setup_quick_start", {confirmClose});
    pendingSetupResult.value = result;
    lastOperationMessage.value = result.message;
    if (result.doctor) {
      doctor.value = result.doctor;
    }
    if (result.requiresCloseConfirmation) {
      setupStatus.value = "needsConfirmation";
      return result;
    }
    if (result.success) {
      setupStatus.value = "completed";
      settings.value = await invoke<AppSettings>("read_settings");
      await scan();
      return result;
    }
    setupStatus.value = "failed";
    await scan();
    doctor.value = await invoke<DoctorResult>("run_doctor");
    return result;
  }

  async function confirmSetupCloseAndRetry() {
    await run(async () => {
      const result = await setupQuickStart(true);
      if (!result.success && !result.requiresCloseConfirmation) {
        throw new Error(result.message);
      }
    });
  }

  async function createLauncher() {
    await run(async () => {
      const result = await invoke<OperationResult>("create_launcher_shortcut");
      lastOperationMessage.value = result.message;
      settings.value = await invoke<AppSettings>("read_settings");
    });
  }

  async function launch() {
    await run(async () => {
      const result = await invoke<OperationResult>("launch_claude_plus");
      lastOperationMessage.value = result.message;
    });
  }

  async function restore() {
    await run(async () => {
      const result = await invoke<OperationResult>("restore_claude");
      lastOperationMessage.value = result.message;
      await scan();
      doctor.value = await invoke<DoctorResult>("run_doctor");
    });
  }

  async function doctorCheck() {
    await run(async () => {
      doctor.value = await invoke<DoctorResult>("run_doctor");
      lastOperationMessage.value = "诊断完成";
    });
  }

  async function updateSettings(patch: Partial<AppSettings>) {
    settings.value = {
      ...settings.value,
      ...patch,
    };
    settings.value = await invoke<AppSettings>("write_settings", {
      settings: settings.value,
    });
  }

  async function checkForUpdate(showResult: boolean) {
    updateStatus.value = "checking";
    try {
      const {check} = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) {
        pendingUpdate.value = null;
        updateInfo.value = null;
        updateStatus.value = "upToDate";
        if (showResult) {
          lastOperationMessage.value = settings.value.locale === "zh-CN" ? "当前已是最新版本" : "Claude Desktop Plus is up to date";
        }
        return;
      }

      pendingUpdate.value = update;
      updateInfo.value = {
        version: update.version,
        currentVersion: update.currentVersion,
        date: update.date ?? null,
        body: update.body ?? null,
      };
      updateProgress.value = {
        downloadedBytes: 0,
        contentLength: null,
        percent: null,
      };
      updateStatus.value = "available";
    } catch (error) {
      updateStatus.value = "failed";
      if (showResult) {
        errorMessage.value = error instanceof Error ? error.message : String(error);
      }
    }
  }

  async function downloadUpdate() {
    const update = pendingUpdate.value;
    if (!update) {
      throw new Error("No update is available.");
    }

    await run(async () => {
      updateStatus.value = "downloading";
      let downloadedBytes = 0;
      let contentLength: number | null = null;
      await update.download((event) => {
        if (event.event === "Started") {
          downloadedBytes = 0;
          contentLength = event.data.contentLength ?? null;
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
        }
        updateProgress.value = {
          downloadedBytes,
          contentLength,
          percent: contentLength ? Math.min(100, Math.round((downloadedBytes / contentLength) * 100)) : null,
        };
      });
      updateStatus.value = "readyToInstall";
      lastOperationMessage.value = settings.value.locale === "zh-CN" ? "更新已下载，重启后生效" : "Update downloaded. Restart to apply it.";
    });
  }

  async function installUpdate() {
    const update = pendingUpdate.value;
    if (!update) {
      throw new Error("No downloaded update is ready to install.");
    }

    await run(async () => {
      updateStatus.value = "installing";
      await update.install();
      lastOperationMessage.value = settings.value.locale === "zh-CN" ? "更新已安装" : "Update installed";
    });
  }

  return {
    activeInstallation,
    bootstrap,
    checkForUpdate,
    doctor,
    doctorCheck,
    downloadUpdate,
    errorMessage,
    installPack,
    installUpdate,
    installations,
    isBusy,
    lastOperationMessage,
    launch,
    confirmSetupCloseAndRetry,
    createLauncher,
    pendingSetupResult,
    restore,
    scan,
    selectInstallation,
    settings,
    setupQuickStart,
    setupStatus,
    updateInfo,
    updateProgress,
    updateStatus,
    updateSettings,
  };
});
