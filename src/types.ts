export type WritableStrategy = "direct" | "userOverlay" | "copyAppBundle" | "unknown";

export type AppSettings = {
  selectedInstallationId: string | null;
  locale: string;
  injectEnabled: boolean;
  launchAfterInstall: boolean;
  quickStartCompleted: boolean;
  launcherCreatedAt: string | null;
  launcherPath: string | null;
};

export type InstallManifest = {
  appVersion: string | null;
  installedLocale: string;
  languagePackVersion: string;
  installedAt: string;
  sourceRootPath: string;
  targetRootPath: string;
  originalAppAsarSha256: string | null;
  backupLocalesPath: string | null;
  overlay: boolean;
};

export type ClaudeInstallation = {
  id: string;
  label: string;
  platform: string;
  source: string;
  rootPath: string;
  appAsarPath: string;
  localesPath: string;
  executablePath: string | null;
  version: string | null;
  writableStrategy: WritableStrategy;
  installedManifest: InstallManifest | null;
};

export type ScanResult = {
  installations: ClaudeInstallation[];
  selectedInstallationId: string | null;
};

export type OperationResult = {
  success: boolean;
  message: string;
  installation: ClaudeInstallation | null;
};

export type SetupResult = {
  success: boolean;
  message: string;
  installation: ClaudeInstallation | null;
  launcherPath: string | null;
  doctor: DoctorResult | null;
  requiresCloseConfirmation: boolean;
};

export type DoctorStatus = "pass" | "warn" | "fail";

export type DoctorCheck = {
  key: string;
  status: DoctorStatus;
  message: string;
};

export type DoctorResult = {
  checks: DoctorCheck[];
};

export type UpdateStatus =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "readyToInstall"
  | "installing"
  | "failed";

export type UpdateInfo = {
  version: string;
  currentVersion: string;
  date: string | null;
  body: string | null;
};

export type UpdateProgress = {
  downloadedBytes: number;
  contentLength: number | null;
  percent: number | null;
};
