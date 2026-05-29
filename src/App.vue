<script setup lang="ts">
import {
  Button as TButton,
  Card as TCard,
  Col as TCol,
  Empty as TEmpty,
  Layout as TLayout,
  Header as THeader,
  Content as TContent,
  MessagePlugin,
  Alert as TAlert,
  Row as TRow,
  Space as TSpace,
  Switch as TSwitch,
  TabPanel as TTabPanel,
  Tabs as TTabs,
  Tag as TTag,
  Select as TSelect,
  Option as TOption,
  Progress as TProgress,
} from "tdesign-vue-next";
import {confirm} from "@tauri-apps/plugin-dialog";
import {openUrl} from "@tauri-apps/plugin-opener";
import {storeToRefs} from "pinia";
import {computed, onMounted} from "vue";

import {useClaudePlusStore} from "./stores/useClaudePlusStore";
import type {DoctorStatus} from "./types";

const PLUS_VERSION = "0.1.0";
const HOMEPAGE_URL = "https://github.com/duanluan/claude-desktop-plus";
const RELEASES_URL = "https://github.com/duanluan/claude-desktop-plus/releases/latest";
const DISCORD_URL = "https://discord.gg/knqvmJWFT3";
const QQ_GROUP_URL = "https://qm.qq.com/q/orZxEV9t04";

const languages = [
  {locale: "en-US", label: "English"},
  {locale: "de-DE", label: "Deutsch"},
  {locale: "es-ES", label: "Español"},
  {locale: "es-419", label: "Español (Latinoamérica)"},
  {locale: "fr-FR", label: "Français"},
  {locale: "hi-IN", label: "हिन्दी"},
  {locale: "id-ID", label: "Bahasa Indonesia"},
  {locale: "it-IT", label: "Italiano"},
  {locale: "ja-JP", label: "日本語"},
  {locale: "ko-KR", label: "한국어"},
  {locale: "pt-BR", label: "Português (Brasil)"},
  {locale: "zh-CN", label: "简体中文"},
];

const messages = {
  "en-US": {
    tagline: "Localization, launch injection, and restore",
    scan: "Scan",
    launchClaude: "Launch Claude",
    home: "Home",
    settings: "Settings",
    doctor: "Doctor",
    about: "About",
    currentStatus: "Status",
    installPath: "Install path",
    version: "Version",
    languagePack: "Language pack",
    installed: "Installed",
    notInstalled: "Not installed",
    strategy: "Strategy",
    unknown: "Unknown",
    noClaude: "Claude Desktop not found",
    quickActions: "Actions",
    installZh: "Install Simplified Chinese",
    createLauncher: "Create launcher",
    launcher: "Launcher",
    launcherReady: "Launcher created",
    launcherMissing: "Launcher not created",
    quickSetup: "Quick setup",
    setupRunning: "Configuring enhanced Claude Desktop...",
    setupCompleted: "Enhanced Claude Desktop is ready.",
    setupNeedsClose: "Claude Desktop is running. Close it and continue setup?",
    confirmClose: "Close and continue",
    launchPlus: "Launch Plus",
    restore: "Restore",
    detectedInstallations: "Installations",
    noInstallations: "No installation found.",
    plusSettings: "Plus Settings",
    injectEntry: "Plus entry",
    language: "Language",
    doctorResult: "Doctor",
    runDoctor: "Run doctor",
    doctorIdle: "Doctor has not run",
    summary: "Adds Chinese support, localization patches, and a Plus entry to Claude Desktop.",
    homepage: "Project homepage",
    discord: "Discord",
    qqGroup: "QQ group",
    update: "Update",
    checkUpdate: "Check for updates",
    updateAvailable: "Update available",
    upToDate: "Up to date",
    updateFailed: "Update check failed",
    downloadUpdate: "Download update",
    installUpdate: "Install and restart",
    downloading: "Downloading...",
    openReleases: "Open releases",
  },
  "zh-CN": {
    tagline: "本地化、启动注入与恢复",
    scan: "扫描",
    launchClaude: "启动 Claude",
    home: "首页",
    settings: "设置",
    doctor: "诊断",
    about: "关于",
    currentStatus: "状态",
    installPath: "安装位置",
    version: "版本",
    languagePack: "语言包",
    installed: "已安装",
    notInstalled: "未安装",
    strategy: "策略",
    unknown: "未知",
    noClaude: "未发现 Claude Desktop",
    quickActions: "操作",
    installZh: "安装简体中文",
    createLauncher: "创建启动图标",
    launcher: "启动图标",
    launcherReady: "已创建启动图标",
    launcherMissing: "未创建启动图标",
    quickSetup: "快速配置",
    setupRunning: "正在配置增强版 Claude Desktop...",
    setupCompleted: "增强版 Claude Desktop 已就绪。",
    setupNeedsClose: "Claude Desktop 正在运行。是否关闭后继续配置？",
    confirmClose: "关闭并继续",
    launchPlus: "启动增强版",
    restore: "恢复原状",
    detectedInstallations: "安装",
    noInstallations: "未扫描到安装目录",
    plusSettings: "Plus 设置",
    injectEntry: "Plus 入口",
    language: "语言",
    doctorResult: "诊断",
    runDoctor: "运行诊断",
    doctorIdle: "尚未运行诊断",
    summary: "为 Claude Desktop 添加中文支持、本地化补丁和 Plus 入口。",
    homepage: "项目主页",
    discord: "Discord",
    qqGroup: "QQ 群",
    update: "更新",
    checkUpdate: "检查更新",
    updateAvailable: "发现新版本",
    upToDate: "已是最新版本",
    updateFailed: "检查更新失败",
    downloadUpdate: "下载更新",
    installUpdate: "安装并重启",
    downloading: "正在下载...",
    openReleases: "打开发布页",
  },
} as const;

const store = useClaudePlusStore();
const {
  activeInstallation,
  doctor,
  errorMessage,
  installations,
  isBusy,
  lastOperationMessage,
  pendingSetupResult,
  settings,
  setupStatus,
  updateInfo,
  updateProgress,
  updateStatus,
} = storeToRefs(store);

const t = computed(() => messages[settings.value.locale as keyof typeof messages] ?? messages["en-US"]);

onMounted(() => {
  void bootstrapApp();
});

async function bootstrapApp() {
  await store.bootstrap();
  if (setupStatus.value === "needsConfirmation") {
    const approved = await confirm(pendingSetupResult.value?.message || t.value.setupNeedsClose, {
      title: t.value.quickSetup,
      kind: "warning",
      okLabel: t.value.confirmClose,
      cancelLabel: t.value.restore,
    });
    if (approved) {
      await runAction(store.confirmSetupCloseAndRetry);
    }
  }
}

async function runAction(action: () => Promise<void>) {
  try {
    await action();
    if (lastOperationMessage.value) {
      MessagePlugin.success(lastOperationMessage.value);
    }
  } catch {
    if (errorMessage.value) {
      MessagePlugin.error(errorMessage.value);
    }
  }
}

function statusTheme(status: DoctorStatus) {
  if (status === "pass") {
    return "success";
  }
  if (status === "warn") {
    return "warning";
  }
  return "danger";
}

async function changeLanguage(value: unknown) {
  const locale = typeof value === "string" ? value : "zh-CN";
  await store.updateSettings({locale});
}

async function openExternal(url: string) {
  await openUrl(url);
}

async function downloadUpdate() {
  await runAction(store.downloadUpdate);
}

async function installUpdate() {
  await runAction(store.installUpdate);
}
</script>

<template>
  <TLayout class="app-shell">
    <THeader class="app-header">
      <div class="brand">
        <div class="brand-mark">C+</div>
        <div>
          <h1>Claude Desktop Plus</h1>
          <p>{{ t.tagline }}</p>
        </div>
      </div>
      <TSpace>
        <TButton :loading="isBusy" variant="outline" @click="runAction(store.scan)">
          {{ t.scan }}
        </TButton>
        <TButton :loading="isBusy" theme="primary" @click="runAction(store.launch)">
          {{ t.launchClaude }}
        </TButton>
      </TSpace>
    </THeader>

    <TContent class="app-content">
      <TTabs default-value="home" placement="top">
        <TTabPanel value="home" :label="t.home">
          <TAlert
            v-if="setupStatus === 'running'"
            class="mb-4"
            theme="info"
            :message="t.setupRunning"
          />
          <TAlert
            v-else-if="setupStatus === 'needsConfirmation'"
            class="mb-4"
            theme="warning"
            :message="pendingSetupResult?.message || t.setupNeedsClose"
          >
            <template #operation>
              <TButton size="small" theme="primary" :loading="isBusy" @click="runAction(store.confirmSetupCloseAndRetry)">
                {{ t.confirmClose }}
              </TButton>
            </template>
          </TAlert>
          <TAlert
            v-else-if="setupStatus === 'completed'"
            class="mb-4"
            theme="success"
            :message="t.setupCompleted"
          />
          <TRow :gutter="[16, 16]">
            <TCol :span="8">
              <TCard :title="t.currentStatus" class="panel-card">
                <template v-if="activeInstallation">
                  <div class="status-list">
                    <div>
                      <span>{{ t.installPath }}</span>
                      <strong>{{ activeInstallation.rootPath }}</strong>
                    </div>
                    <div>
                      <span>{{ t.version }}</span>
                      <strong>{{ activeInstallation.version || t.unknown }}</strong>
                    </div>
                    <div>
                      <span>{{ t.languagePack }}</span>
                      <TTag :theme="activeInstallation.installedManifest ? 'success' : 'warning'">
                        {{ activeInstallation.installedManifest ? t.installed : t.notInstalled }}
                      </TTag>
                    </div>
                    <div>
                      <span>{{ t.strategy }}</span>
                      <strong>{{ activeInstallation.writableStrategy }}</strong>
                    </div>
                    <div>
                      <span>{{ t.launcher }}</span>
                      <TTag :theme="settings.launcherPath ? 'success' : 'warning'">
                        {{ settings.launcherPath ? t.launcherReady : t.launcherMissing }}
                      </TTag>
                    </div>
                    <div v-if="settings.launcherPath">
                      <span>{{ t.launcher }}</span>
                      <strong>{{ settings.launcherPath }}</strong>
                    </div>
                  </div>
                </template>
                <TEmpty v-else :description="t.noClaude" />
              </TCard>
            </TCol>

            <TCol :span="4">
              <TCard :title="t.quickActions" class="panel-card">
                <TSpace direction="vertical" class="full-width">
                  <TButton block :loading="isBusy" theme="primary" @click="runAction(() => store.installPack('zh-CN'))">
                    {{ t.installZh }}
                  </TButton>
                  <TButton block :loading="isBusy" variant="outline" @click="runAction(store.createLauncher)">
                    {{ t.createLauncher }}
                  </TButton>
                  <TButton block :loading="isBusy" variant="outline" @click="runAction(store.launch)">
                    {{ t.launchPlus }}
                  </TButton>
                  <TButton block :loading="isBusy" theme="danger" variant="outline" @click="runAction(store.restore)">
                    {{ t.restore }}
                  </TButton>
                </TSpace>
              </TCard>
            </TCol>
          </TRow>

          <TCard :title="t.detectedInstallations" class="panel-card mt-4">
            <div v-if="installations.length" class="install-grid">
              <button
                v-for="installation in installations"
                :key="installation.id"
                class="install-item"
                :class="{active: settings.selectedInstallationId === installation.id}"
                type="button"
                @click="store.selectInstallation(installation.id)"
              >
                <span>{{ installation.label }}</span>
                <small>{{ installation.rootPath }}</small>
              </button>
            </div>
            <TEmpty v-else :description="t.noInstallations" />
          </TCard>
        </TTabPanel>

        <TTabPanel value="settings" :label="t.settings">
          <TCard :title="t.plusSettings" class="panel-card narrow-card">
            <div class="settings-row">
              <strong>{{ t.injectEntry }}</strong>
              <TSwitch
                :model-value="settings.injectEnabled"
                @change="value => store.updateSettings({injectEnabled: Boolean(value)})"
              />
            </div>
            <TDivider />
            <div class="settings-row">
              <strong>{{ t.language }}</strong>
              <TSelect
                class="settings-select"
                :model-value="settings.locale"
                @change="changeLanguage"
              >
                <TOption
                  v-for="language in languages"
                  :key="language.locale"
                  :label="language.label"
                  :value="language.locale"
                />
              </TSelect>
            </div>
          </TCard>
        </TTabPanel>

        <TTabPanel value="doctor" :label="t.doctor">
          <TCard :title="t.doctorResult" class="panel-card">
            <TSpace class="mb-4">
              <TButton :loading="isBusy" theme="primary" @click="runAction(store.doctorCheck)">
                {{ t.runDoctor }}
              </TButton>
            </TSpace>
            <div v-if="doctor" class="doctor-list">
              <div v-for="check in doctor.checks" :key="check.key" class="doctor-item">
                <TTag :theme="statusTheme(check.status)">{{ check.status }}</TTag>
                <span>{{ check.message }}</span>
              </div>
            </div>
            <TEmpty v-else :description="t.doctorIdle" />
          </TCard>
        </TTabPanel>

        <TTabPanel value="about" :label="t.about">
          <TCard title="Claude Desktop Plus" class="panel-card narrow-card">
            <div class="about-list">
              <p class="about-copy">{{ t.summary }}</p>
              <div class="about-version">
                <span>{{ t.version }}</span>
                <strong>{{ PLUS_VERSION }}</strong>
              </div>
              <div class="update-panel">
                <div class="about-version">
                  <span>{{ t.update }}</span>
                  <TTag
                    v-if="updateStatus === 'available' || updateStatus === 'readyToInstall'"
                    theme="warning"
                  >
                    {{ t.updateAvailable }} {{ updateInfo?.version }}
                  </TTag>
                  <TTag v-else-if="updateStatus === 'upToDate'" theme="success">
                    {{ t.upToDate }}
                  </TTag>
                  <TTag v-else-if="updateStatus === 'failed'" theme="danger">
                    {{ t.updateFailed }}
                  </TTag>
                </div>
                <p v-if="updateInfo?.body" class="about-copy update-notes">
                  {{ updateInfo.body }}
                </p>
                <TProgress
                  v-if="updateStatus === 'downloading'"
                  :percentage="updateProgress.percent ?? 0"
                  :label="updateProgress.percent === null ? t.downloading : undefined"
                />
                <TSpace>
                  <TButton
                    variant="outline"
                    :loading="updateStatus === 'checking'"
                    @click="runAction(() => store.checkForUpdate(true))"
                  >
                    {{ t.checkUpdate }}
                  </TButton>
                  <TButton
                    v-if="updateStatus === 'available'"
                    theme="primary"
                    @click="downloadUpdate"
                  >
                    {{ t.downloadUpdate }}
                  </TButton>
                  <TButton
                    v-if="updateStatus === 'readyToInstall'"
                    theme="primary"
                    @click="installUpdate"
                  >
                    {{ t.installUpdate }}
                  </TButton>
                  <TButton variant="outline" @click="openExternal(RELEASES_URL)">
                    {{ t.openReleases }}
                  </TButton>
                </TSpace>
              </div>
              <TSpace>
                <TButton variant="outline" @click="openExternal(HOMEPAGE_URL)">
                  {{ t.homepage }}
                </TButton>
                <TButton variant="outline" @click="openExternal(DISCORD_URL)">
                  {{ t.discord }}
                </TButton>
                <TButton variant="outline" @click="openExternal(QQ_GROUP_URL)">
                  {{ t.qqGroup }}
                </TButton>
              </TSpace>
            </div>
          </TCard>
        </TTabPanel>
      </TTabs>
    </TContent>
  </TLayout>
</template>
