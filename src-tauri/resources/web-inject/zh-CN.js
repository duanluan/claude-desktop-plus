(function claudeDesktopPlusZhCn() {
  const INSTANCE_KEY = "__CLAUDE_DESKTOP_PLUS_ZH_CN_INSTANCE__";
  if (window[INSTANCE_KEY]?.active) {
    return;
  }
  window[INSTANCE_KEY] = {active: true};
  const DEFAULT_LOCALE = window.__CLAUDE_DESKTOP_PLUS_LOCALE__ || "zh-CN";
  const TRANSLATED_LOCALE = "zh-CN";
  const PLUS_VERSION = "0.1.0";
  const HOMEPAGE_URL = "https://github.com/duanluan/claude-desktop-plus";
  const DISCORD_URL = "https://discord.gg/knqvmJWFT3";
  const QQ_GROUP_URL = "https://qm.qq.com/q/orZxEV9t04";
  const LANGUAGE_STORAGE_KEY = "claude-desktop-plus.locale";
  const RELOAD_STORAGE_KEY = "claude-desktop-plus.pending-reload-locale";
  const TRANSITION_STORAGE_KEY = "claude-desktop-plus.locale-transition";
  const DEBUG_KEY = "claude-desktop-plus.debug";
  let localeReloadTimer = 0;
  let localeEnforceTimer = 0;
  let unsubscribeClaudeLocale = null;
  let activeLocale = null;
  let localeEnforcementInFlight = false;
  let translateQueueTimer = 0;
  let languageControlScanTimer = 0;
  let interactionTranslateTimer = 0;
  let sidebarTranslateTimer = 0;
  let sidebarBurstAt = 0;
  let navigationHooksInstalled = false;
  const pendingTranslateRoots = new Set();
  const TRANSLATE_BATCH_LIMIT = 120;
  const TRANSLATE_ROOT_LIMIT = 16;

  const LANGUAGES = [
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

  const PLUS_I18N = {
    "en-US": {
      language: "Language",
      about: "About",
      summary: "Adds Chinese support, localization patches, and a Plus entry to Claude Desktop.",
      version: "Version",
      homepage: "Project homepage",
      discord: "Discord",
      qqGroup: "QQ group",
      close: "Close",
    },
    "de-DE": {
      language: "Sprache",
      about: "Über",
      summary: "Fügt Claude Desktop Chinesisch, Lokalisierungspatches und einen Plus-Einstieg hinzu.",
      version: "Version",
      homepage: "Projektseite",
      discord: "Discord",
      qqGroup: "QQ-Gruppe",
      close: "Schließen",
    },
    "es-ES": {
      language: "Idioma",
      about: "Acerca de",
      summary: "Añade chino, parches de localización y una entrada Plus a Claude Desktop.",
      version: "Versión",
      homepage: "Página del proyecto",
      discord: "Discord",
      qqGroup: "Grupo QQ",
      close: "Cerrar",
    },
    "es-419": {
      language: "Idioma",
      about: "Acerca de",
      summary: "Agrega chino, parches de localización y una entrada Plus a Claude Desktop.",
      version: "Versión",
      homepage: "Página del proyecto",
      discord: "Discord",
      qqGroup: "Grupo QQ",
      close: "Cerrar",
    },
    "fr-FR": {
      language: "Langue",
      about: "À propos",
      summary: "Ajoute le chinois, des correctifs de localisation et une entrée Plus à Claude Desktop.",
      version: "Version",
      homepage: "Page du projet",
      discord: "Discord",
      qqGroup: "Groupe QQ",
      close: "Fermer",
    },
    "hi-IN": {
      language: "भाषा",
      about: "परिचय",
      summary: "Claude Desktop में चीनी समर्थन, स्थानीयकरण पैच और Plus प्रवेश जोड़ता है।",
      version: "संस्करण",
      homepage: "प्रोजेक्ट पेज",
      discord: "Discord",
      qqGroup: "QQ समूह",
      close: "बंद करें",
    },
    "id-ID": {
      language: "Bahasa",
      about: "Tentang",
      summary: "Menambahkan dukungan bahasa Mandarin, patch pelokalan, dan akses Plus ke Claude Desktop.",
      version: "Versi",
      homepage: "Halaman proyek",
      discord: "Discord",
      qqGroup: "Grup QQ",
      close: "Tutup",
    },
    "it-IT": {
      language: "Lingua",
      about: "Informazioni",
      summary: "Aggiunge cinese, patch di localizzazione e un accesso Plus a Claude Desktop.",
      version: "Versione",
      homepage: "Pagina progetto",
      discord: "Discord",
      qqGroup: "Gruppo QQ",
      close: "Chiudi",
    },
    "ja-JP": {
      language: "言語",
      about: "概要",
      summary: "Claude Desktop に中国語対応、ローカライズパッチ、Plus 入口を追加します。",
      version: "バージョン",
      homepage: "プロジェクトページ",
      discord: "Discord",
      qqGroup: "QQ グループ",
      close: "閉じる",
    },
    "ko-KR": {
      language: "언어",
      about: "정보",
      summary: "Claude Desktop에 중국어 지원, 현지화 패치, Plus 진입점을 추가합니다.",
      version: "버전",
      homepage: "프로젝트 페이지",
      discord: "Discord",
      qqGroup: "QQ 그룹",
      close: "닫기",
    },
    "pt-BR": {
      language: "Idioma",
      about: "Sobre",
      summary: "Adiciona chinês, patches de localização e uma entrada Plus ao Claude Desktop.",
      version: "Versão",
      homepage: "Página do projeto",
      discord: "Discord",
      qqGroup: "Grupo QQ",
      close: "Fechar",
    },
    "zh-CN": {
      language: "语言",
      about: "关于",
      summary: "为 Claude Desktop 添加中文支持、本地化补丁和 Plus 入口。",
      version: "版本",
      homepage: "项目主页",
      discord: "Discord",
      qqGroup: "QQ 群",
      close: "关闭",
    },
  };

  const TEXT_MAP = new Map([
    ["Hey there,", "你好，"],
    ["Type / for skills", "输入 / 使用技能"],
    ["Chat", "聊天"],
    ["Code", "代码"],
    ["New chat", "新建聊天"],
    ["New Conversation", "新建对话"],
    ["Write", "写作"],
    ["Learn", "学习"],
    ["Life stuff", "生活事务"],
    ["Projects", "项目"],
    ["Project", "项目"],
    ["Artifacts", "工件"],
    ["Artifact", "工件"],
    ["Work", "工作"],
    ["Customize", "自定义"],
    ["Free plan", "免费套餐"],
    ["Free", "免费"],
    ["Upgrade", "升级"],
    ["Upgrade plan", "升级套餐"],
    ["Claude's choice", "Claude 的选择"],
    ["Claude’s choice", "Claude 的选择"],
    ["What can I help you with today?", "今天我能帮你做什么？"],
    ["How can I help you today?", "今天我能帮你做什么？"],
    ["Code isn't included in your plan", "当前套餐不包含 Code"],
    ["Code isn’t included in your plan", "当前套餐不包含 Code"],
    ["Upgrade to Pro or Max to use Code on desktop.", "升级到 Pro 或 Max 即可在桌面端使用 Code。"],
    ["Settings", "设置"],
    ["Language", "语言"],
    ["Plan usage", "套餐用量"],
    ["Help", "帮助"],
    ["Get help", "获取帮助"],
    ["Get apps and extensions", "获取应用和扩展"],
    ["Log out", "退出登录"],
    ["Developer", "开发者"],
    ["Extensions", "扩展"],
    ["Open Settings", "打开设置"],
    ["Submit Feedback", "提交反馈"],
    ["Get support", "获取支持"],
    ["Get Support", "获取支持"],
    ["Learn more", "了解更多"],
    ["Search", "搜索"],
    ["Search settings", "搜索设置"],
    ["General", "通用"],
    ["Account", "账户"],
    ["Privacy", "隐私"],
    ["Billing", "账单"],
    ["Capabilities", "能力"],
    ["Connectors", "连接器"],
    ["Skills", "技能"],
    ["Personal skills", "个人技能"],
    ["Personal plugins", "个人插件"],
    ["Added by", "添加者"],
    ["Trigger", "触发方式"],
    ["Description", "描述"],
    ["Try in chat", "在聊天中试用"],
    ["Uninstall", "卸载"],
    ["Give Claude role-level expertise with plugins", "通过插件为 Claude 提供角色级专业能力"],
    ["Browse plugins", "浏览插件"],
    ["Customize Claude", "自定义 Claude"],
    ["Skills, connectors, and plugins shape how Claude works with you.", "技能、连接器和插件会决定 Claude 如何与你协作。"],
    ["Connect your apps", "连接你的应用"],
    ["Let Claude read and write to the tools you already use.", "让 Claude 读写你已在使用的工具。"],
    ["Create new skills", "创建新技能"],
    ["Teach Claude your processes, team norms, and expertise.", "把你的流程、团队规范和专业经验教给 Claude。"],
    ["Not connected", "未连接"],
    ["GitHub Integration", "GitHub 集成"],
    ["You are not connected to GitHub Integration yet.", "你尚未连接 GitHub 集成。"],
    ["Connect", "连接"],
    ["Claude Code", "Claude Code"],
    ["Desktop app", "桌面应用"],
    ["Profile", "个人资料"],
    ["Avatar", "头像"],
    ["Full name", "姓名"],
    ["What should Claude call you?", "希望 Claude 怎么称呼你？"],
    ["What best describes your work?", "哪项最符合你的工作？"],
    ["Instructions for Claude", "给 Claude 的指令"],
    ["Claude will keep these in mind across chats and Cowork within Anthropic's guidelines.", "Claude 会在聊天和 Cowork 中遵循 Anthropic 指南，并记住这些内容。"],
    ["Preferences", "偏好设置"],
    ["Appearance", "外观"],
    ["Chat font", "聊天字体"],
    ["Voice", "语音"],
    ["Voice speed", "语速"],
    ["Normal", "正常"],
    ["Engineering", "工程"],
    ["Configure third-party inference", "配置第三方推理"],
    ["Configure Third-Party Inference", "配置第三方推理"],
    ["Connection", "连接"],
    ["Choose where Claude Desktop sends inference requests.", "选择 Claude Desktop 发送推理请求的位置。"],
    ["Workspace restrictions", "工作区限制"],
    ["Connectors & extensions", "连接器和扩展"],
    ["Telemetry & updates", "遥测与更新"],
    ["Usage limits", "使用限制"],
    ["Plugins & skills", "插件和技能"],
    ["Egress Requirements", "出站要求"],
    ["Applies to both the Cowork and Code tabs.", "同时适用于 Cowork 和 Code 标签页。"],
    ["Only affects tool calls. Inference and MCP traffic are covered by their own allowlists elsewhere.", "仅影响工具调用。推理和 MCP 流量由各自的允许列表控制。"],
    ["When unset, only the inference endpoint is reachable from the sandbox; the agent's package installs (pip/npm) and web fetches will fail with a 403.", "未设置时，沙箱只能访问推理端点；Agent 的包安装（pip/npm）和网页获取会因 403 失败。"],
    ["Gateway", "网关"],
    ["GATEWAY CREDENTIALS", "网关凭据"],
    ["Credential kind *", "凭据类型 *"],
    ["Credential kind", "凭据类型"],
    ["Selects the credential source. When set, only that source is used (no fallback).", "选择凭据来源。设置后只使用该来源，不会回退。"],
    ["Gateway base URL *", "网关基础 URL *"],
    ["Gateway base URL", "网关基础 URL"],
    ["Full URL of the inference gateway endpoint.", "推理网关端点的完整 URL。"],
    ["Custom inference headers", "自定义推理请求头"],
    ["Extra HTTP headers sent on every inference request to the configured provider. For tenant routing, org IDs, Bedrock Guardrails, etc.", "每次向已配置提供方发送推理请求时附加的 HTTP 头。可用于租户路由、组织 ID、Bedrock Guardrails 等。"],
    ["Add header", "添加请求头"],
    ["Add Header", "添加请求头"],
    ["MODELS", "模型"],
    ["Models", "模型"],
    ["Model discovery", "模型发现"],
    ["Auto-populate the model picker from /v1/models at launch.", "启动时从 /v1/models 自动填充模型选择器。"],
    ["Default", "默认"],
    ["Export", "导出"],
    ["Apply Changes", "应用更改"],
    ["Connection needs 2 fields", "连接还需填写 2 项"],
    ["Connection needs 1 field", "连接还需填写 1 项"],
    ["needs 2 fields", "还需填写 2 项"],
    ["needs 1 field", "还需填写 1 项"],
    ["Hide details", "隐藏详情"],
    ["Show details", "显示详情"],
    ["Read in docs", "阅读文档"],
    ["Enable Main Process Debugger", "启用主进程调试器"],
    ["Record Performance Trace", "记录性能跟踪"],
    ["Write Main Process Heap Snapshot", "写入主进程堆快照"],
    ["Record Memory Trace (auto-stop)", "记录内存跟踪（自动停止）"],
    ["Sent on every inference and model-discovery request (joined into the CLI's ANTHROPIC_CUSTOM_HEADERS).", "随每次推理请求和模型发现请求发送（会合并到 CLI 的 ANTHROPIC_CUSTOM_HEADERS）。"],
    ["Use this for fleet-wide constants. For per-user or per-session values, have the credential helper script emit JSON with a headers field; those are merged over these static entries (helper wins on conflict).", "用于整个团队通用的固定值。若需按用户或会话设置，请让凭据辅助脚本输出带有 headers 字段的 JSON；这些值会覆盖并合并到静态条目中（冲突时辅助脚本优先）。"],
    ["Model list", "模型列表"],
    ["Override the auto-discovered model list. First entry is the default.", "覆盖自动发现的模型列表。第一项为默认模型。"],
    ["Add model", "添加模型"],
    ["Allow Claude Code tab", "允许 Claude Code 标签页"],
    ["Show the Code tab (terminal-based coding sessions). Sessions run on the host, not inside the VM.", "显示 Code 标签页（基于终端的编码会话）。会话在主机上运行，不在虚拟机内运行。"],
    ["Allowed egress hosts", "允许的出站主机"],
    ["Hostnames the agent's tools may reach from the Cowork and Code tabs. Also surfaced under Egress Requirements.", "Agent 工具可从 Cowork 和 Code 标签页访问的主机名，也会显示在出站要求中。"],
    ["* Allow all", "* 全部允许"],
    ["Allowed workspace folders", "允许的工作区文件夹"],
    ["Folders users may attach as a workspace. Leave unset for unrestricted access.", "用户可作为工作区附加的文件夹。不设置则不限制访问。"],
    ["Disabled built-in tools", "禁用的内置工具"],
    ["Built-in tools removed from Cowork.", "从 Cowork 中移除的内置工具。"],
    ["Built-in tool policy", "内置工具策略"],
    ["Per-tool approval policy. \"ask\" requires user approval before each call; \"allow\" is the default. Use Disabled built-in tools to remove a tool entirely.", "按工具设置审批策略。\"ask\" 表示每次调用前都需用户批准；\"allow\" 为默认值。若要完全移除某个工具，请使用“禁用的内置工具”。"],
    ["Add policy", "添加策略"],
    ["Disable Claude.ai sign-in", "禁用 Claude.ai 登录"],
    ["Users see only this provider at the login screen. The option to sign in to Claude.ai is hidden.", "用户在登录页面只会看到此提供方，Claude.ai 登录选项会被隐藏。"],
    ["Disable claude:// deep-link handling", "禁用 claude:// 深链接处理"],
    ["Stop external apps and websites from opening Cowork via claude:// links.", "阻止外部应用和网站通过 claude:// 链接打开 Cowork。"],
    ["Choose...", "选择..."],
    ["MCP SERVERS", "MCP 服务器"],
    ["Managed MCP servers", "托管 MCP 服务器"],
    ["Org-pushed MCP servers: remote (HTTP/SSE) or local (stdio command). May embed bearer tokens.", "组织下发的 MCP 服务器：远程（HTTP/SSE）或本地（stdio 命令）。可内嵌 bearer token。"],
    ["Add server", "添加服务器"],
    ["Allow user-added MCP servers", "允许用户添加 MCP 服务器"],
    ["Local stdio servers added via the Developer settings. Remote servers come from the managed list above, or plugins mounted to a user's computer by an organization admin.", "通过开发者设置添加的本地 stdio 服务器。远程服务器来自上方托管列表，或由组织管理员挂载到用户电脑上的插件提供。"],
    ["Allow desktop extensions", "允许桌面扩展"],
    [".dxt and .mcpb installs.", "允许安装 .dxt 和 .mcpb。"],
    ["Require signed extensions", "要求扩展已签名"],
    ["Reject desktop extensions that are not signed by a trusted publisher.", "拒绝未由受信任发布者签名的桌面扩展。"],
    ["Prompts, completions, and your data are never sent to Anthropic. Telemetry covers crash and usage signals only.", "提示词、补全内容和你的数据绝不会发送给 Anthropic。遥测只包含崩溃和使用信号。"],
    ["ANTHROPIC TELEMETRY", "Anthropic 遥测"],
    ["Organization UUID", "组织 UUID"],
    ["Tags telemetry events with your organization's UUID so Anthropic support can find them. Not used for auth.", "用组织 UUID 标记遥测事件，便于 Anthropic 支持团队定位。此项不用于身份验证。"],
    ["Block essential telemetry", "阻止必要遥测"],
    ["Crash and performance reports to Anthropic.", "发送给 Anthropic 的崩溃和性能报告。"],
    ["What you lose when this is on:", "开启后会失去什么："],
    ["Why this is discouraged, not blocked:", "为什么不建议开启但没有禁用："],
    ["Block nonessential telemetry", "阻止非必要遥测"],
    ["Product-usage analytics and diagnostic-report uploads. No message content.", "产品使用分析和诊断报告上传。不包含消息内容。"],
    ["Block nonessential services", "阻止非必要服务"],
    ["Favicon fetch and the artifact-preview iframe origin. Artifacts will not render.", "阻止获取网站图标和 artifact 预览 iframe 来源。Artifacts 将无法渲染。"],
    ["OPENTELEMETRY", "OpenTelemetry"],
    ["OpenTelemetry collector endpoint", "OpenTelemetry 收集器端点"],
    ["Where Cowork sends OpenTelemetry logs and metrics. Leave blank to disable.", "Cowork 发送 OpenTelemetry 日志和指标的位置。留空则禁用。"],
    ["UPDATES", "更新"],
    ["Block auto-updates", "阻止自动更新"],
    ["Stop Cowork from fetching updates. You’ll need to push new versions yourself.", "阻止 Cowork 获取更新。你需要自行推送新版本。"],
    ["Stop Cowork from fetching updates. You'll need to push new versions yourself.", "阻止 Cowork 获取更新。你需要自行推送新版本。"],
    ["Auto-update enforcement window", "自动更新强制安装窗口"],
    ["Hours before a downloaded update force-installs. Blank = 72-hour default.", "已下载更新在强制安装前等待的小时数。留空则默认 72 小时。"],
    ["hours", "小时"],
    ["Max tokens per window", "每个窗口的最大 token 数"],
    ["tokens", "token"],
    ["Per-user soft cap, counted client-side over the duration below. Not a server-enforced quota.", "按用户设置的软上限，由客户端在下方时长内统计。不是服务端强制配额。"],
    ["ORGANIZATION BANNER", "组织横幅"],
    ["Organization banner", "组织横幅"],
    ["A persistent banner across the top of the app window after sign-in.", "登录后在应用窗口顶部持续显示的横幅。"],
    ["Show banner", "显示横幅"],
    ["ORGANIZATION PLUGINS", "组织插件"],
    ["No organization plugins found", "未找到组织插件"],
    ["Mount plugin bundles to this folder using your device-management tool and Cowork will load them at launch. The folder is read-only; tool policies you set below are saved in this configuration.", "使用设备管理工具将插件包挂载到此文件夹，Cowork 会在启动时加载。该文件夹为只读；你在下方设置的工具策略会保存在此配置中。"],
    ["Copy", "复制"],
    ["Add server policy", "添加服务器策略"],
    ["FIREWALL ALLOWLIST", "防火墙允许列表"],
    ["Test connectivity", "测试连接"],
    ["Copy hostnames", "复制主机名"],
    ["Download .txt", "下载 .txt"],
    ["CORE (VM BUNDLE + CLAUDE CLI BINARY)", "核心（虚拟机包 + Claude CLI 二进制）"],
    ["AUTO-UPDATES", "自动更新"],
    ["ESSENTIAL TELEMETRY", "必要遥测"],
    ["NONESSENTIAL TELEMETRY", "非必要遥测"],
    ["NONESSENTIAL SERVICES", "非必要服务"],
    ["DESKTOP EXTENSIONS (PYTHON RUNTIME)", "桌面扩展（Python 运行时）"],
    ["macOS configuration profile", "macOS 配置描述文件"],
    ["Windows registry file", "Windows 注册表文件"],
    ["Plain JSON", "普通 JSON"],
    ["Firewall allowlist (.txt)", "防火墙允许列表（.txt）"],
    ["Copy to clipboard (redacted)", "复制到剪贴板（已隐藏敏感信息）"],
    ["Templates", "模板"],
    ["Group Policy template (ADMX)", "组策略模板（ADMX）"],
    ["Schema only — defines available policies for Intune / Group Policy. Values are configured in your management console.", "仅包含架构，用于定义 Intune / 组策略可用的策略项。具体值在你的管理控制台中配置。"],
    ["Profile Manifest (.plist)", "配置清单（.plist）"],
    ["Defines available settings for Jamf / ProfileCreator and similar macOS tools.", "定义 Jamf / ProfileCreator 及类似 macOS 工具可用的设置项。"],
    ["New artifact", "新建工件"],
    ["Search artifacts...", "搜索工件..."],
    ["What will you build with artifacts?", "你想用工件构建什么？"],
    ["If you can dream it, you can build it. Take apps, games, templates, and tools from thought to reality.", "只要能想到，就能构建。把应用、游戏、模板和工具从想法变成现实。"],
    ["Looking to start a project?", "想开始一个项目？"],
    ["Upload materials, set custom instructions, and organize conversations in one space.", "上传资料、设置自定义指令，并在一个空间中整理对话。"],
    ["New project", "新建项目"],
    ["Adaptive thinking", "自适应思考"],
    ["Thinks for more complex tasks", "为更复杂的任务思考"],
    ["More models", "更多模型"],
    ["Most capable for ambitious work", "最适合高要求任务"],
    ["Most efficient for everyday tasks", "最适合日常任务"],
    ["Fastest for quick answers", "最快获得简短回答"],
    ["Press and hold to record", "按住录音"],
    ["Use voice mode", "使用语音模式"],
    ["API Console", "API 控制台"],
    ["About Anthropic", "关于 Anthropic"],
    ["Tutorials", "教程"],
    ["Courses", "课程"],
    ["Usage policy", "使用政策"],
    ["Privacy policy", "隐私政策"],
    ["Your privacy choices", "你的隐私选择"],
    ["Keyboard shortcuts", "键盘快捷键"],
    ["Notifications", "通知"],
    ["Response completions", "回复完成"],
    ["Get notified when Claude has finished a response. Useful for long-running tasks.", "Claude 完成回复时通知你。适合耗时较长的任务。"],
    ["Dispatch messages", "Dispatch 消息"],
    ["Get a push notification on your phone when Claude messages you in Dispatch.", "当 Claude 在 Dispatch 中给你发消息时，在手机上收到推送通知。"],
    ["Log out of all devices", "退出所有设备"],
    ["Delete your account", "删除你的账户"],
    ["Delete account", "删除账户"],
    ["Organization ID", "组织 ID"],
    ["Active sessions", "活跃会话"],
    ["Device", "设备"],
    ["Location", "位置"],
    ["Created", "创建时间"],
    ["Updated", "更新时间"],
    ["Current", "当前"],
    ["Claude Desktop (Windows)", "Claude Desktop（Windows）"],
    ["Anthropic believes in transparent data practices. Learn how your information is protected when using Anthropic products, and visit our Privacy Center and Privacy Policy for more details.", "Anthropic 坚持透明的数据处理方式。了解你在使用 Anthropic 产品时信息如何受到保护，并访问我们的隐私中心和隐私政策获取更多详情。"],
    ["Privacy Center", "隐私中心"],
    ["Privacy Policy", "隐私政策"],
    ["How we protect your data", "我们如何保护你的数据"],
    ["How we use your data", "我们如何使用你的数据"],
    ["Location metadata", "位置元数据"],
    ["Allow Claude to use coarse location metadata (city/region) to improve product experiences.", "允许 Claude 使用粗略位置元数据（城市/地区）来改进产品体验。"],
    ["Help improve Claude", "帮助改进 Claude"],
    ["Allow the use of your chats and coding sessions to train and improve Anthropic AI models.", "允许使用你的聊天和编码会话来训练并改进 Anthropic AI 模型。"],
    ["Your data", "你的数据"],
    ["Export data", "导出数据"],
    ["Shared chats", "共享聊天"],
    ["Memory preferences", "记忆偏好"],
    ["Manage", "管理"],
    ["Chat on web, iOS, Android, and on your desktop", "可在网页、iOS、Android 和桌面端聊天"],
    ["Generate code and visualize data", "生成代码并可视化数据"],
    ["Write, edit, and create content", "撰写、编辑和创作内容"],
    ["Analyze text and images", "分析文本和图像"],
    ["Ability to search the web", "支持联网搜索"],
    ["Create files and execute code", "创建文件并执行代码"],
    ["Unlock more from Claude with desktop extensions", "通过桌面扩展释放 Claude 的更多能力"],
    ["Connect Slack and Google Workspace services", "连接 Slack 和 Google Workspace 服务"],
    ["Integrate any context or tool through connectors with remote MCP", "通过支持远程 MCP 的连接器集成任意上下文或工具"],
    ["Extended thinking for complex work", "为复杂任务启用扩展思考"],
    ["Memory", "记忆"],
    ["Generate memory from chat history", "根据聊天历史生成记忆"],
    ["Allow Claude to remember relevant context from your chats and Cowork sessions. Memory includes your entire chat history with Claude.", "允许 Claude 记住你在聊天和 Cowork 会话中的相关上下文。记忆会包含你与 Claude 的完整聊天历史。"],
    ["Import memory from other AI providers", "从其他 AI 提供方导入记忆"],
    ["Bring relevant context and data from another AI provider to Claude. We'll provide a prompt you can use to fetch the memory from your other account.", "将其他 AI 提供方中的相关上下文和数据带到 Claude。我们会提供一段提示词，帮助你从其他账户中获取记忆。"],
    ["Bring relevant context and data from another AI provider to Claude. We’ll provide a prompt you can use to fetch the memory from your other account.", "将其他 AI 提供方中的相关上下文和数据带到 Claude。我们会提供一段提示词，帮助你从其他账户中获取记忆。"],
    ["Start import", "开始导入"],
    ["Tool access mode", "工具访问模式"],
    ["Controls how connector tools are loaded in new conversations.", "控制连接器工具在新对话中的加载方式。"],
    ["Load tools when needed", "需要时加载工具"],
    ["Connector discovery", "连接器发现"],
    ["Let Claude surface connectors from the directory that may be relevant to your conversation.", "允许 Claude 从目录中推荐可能与你的对话相关的连接器。"],
    ["Visuals", "视觉内容"],
    ["Generate code, documents, and designs in a dedicated window alongside your conversation.", "在对话旁的专用窗口中生成代码、文档和设计。"],
    ["AI-powered artifacts", "AI 驱动的工件"],
    ["Build apps and interactive documents that use Claude inside the artifact.", "构建可在工件中使用 Claude 的应用和交互式文档。"],
    ["Inline visualizations", "内联可视化"],
    ["Allow Claude to generate interactive visualizations, charts, and diagrams directly in the conversation.", "允许 Claude 直接在对话中生成交互式可视化、图表和示意图。"],
    ["Code execution and file creation", "代码执行和文件创建"],
    ["Claude can execute code and create and edit docs, spreadsheets, presentations, PDFs, and data reports. Required for skills.", "Claude 可以执行代码，并创建和编辑文档、电子表格、演示文稿、PDF 和数据报告。技能需要启用此项。"],
    ["Allow network egress", "允许网络访问"],
    ["Allow Claude to access common package managers to install packages and libraries for data analysis, visualizations, and file processing.", "允许 Claude 访问常见包管理器，以安装用于数据分析、可视化和文件处理的包与库。"],
    ["View package manager domains", "查看包管理器域名"],
    ["Monitor chats closely as this comes with security risks.", "此功能存在安全风险，请密切关注聊天内容。"],
    ["Skills have moved to", "技能已移至"],
    ["Connectors have moved to", "连接器已移至"],
    ["Head there to browse, connect, and manage them.", "请前往那里浏览、连接和管理连接器。"],
    ["Claude understands your codebase and helps you build, debug, and ship faster. Upgrade your plan to get started.", "Claude 能理解你的代码库，帮助你更快地构建、调试并交付。升级套餐即可开始使用。"],
    ["Upgrade to Max or Pro", "升级到 Max 或 Pro"],
    ["Code appearance", "代码外观"],
    ["Code font", "代码字体"],
    ["Set a custom monospace font for code and terminal.", "为代码和终端设置自定义等宽字体。"],
    ["High-contrast dark theme", "高对比度深色主题"],
    ["Use a darker, near-black background when dark mode is on.", "开启深色模式时使用更深、接近黑色的背景。"],
    ["Interface font", "界面字体"],
    ["Font for the Claude Code interface — menus, sidebar, and chat.", "Claude Code 界面的字体，包括菜单、侧边栏和聊天。"],
    ["Transcript text size", "会话记录文字大小"],
    ["Size of the conversation transcript text.", "对话记录文本的大小。"],
    ["Classify session states", "分类会话状态"],
    ["Allow Claude to automatically classify sessions as blocked, ready for review, or done. Classifying sessions counts towards your plan usage. Applies to new sessions.", "允许 Claude 自动将会话分类为受阻、待审查或已完成。会话分类会计入套餐用量，并适用于新会话。"],
    ["Pull requests", "拉取请求"],
    ["Create pull requests automatically", "自动创建拉取请求"],
    ["When Claude pushes changes to a branch, it automatically opens a pull request without asking first. Applies to remote sessions only.", "当 Claude 将更改推送到分支时，会自动创建拉取请求，无需再次确认。仅适用于远程会话。"],
    ["Autofix pull requests", "自动修复拉取请求"],
    ["When you create a pull request, Claude automatically monitors it for CI failures and review comments, then responds proactively. Claude may post comments on your behalf.", "创建拉取请求后，Claude 会自动监控 CI 失败和审查评论，并主动响应。Claude 可能会代表你发表评论。"],
    ["Auto-archive after PR merge or close", "PR 合并或关闭后自动归档"],
    ["Automatically archive desktop sessions when the associated pull request is merged or closed.", "关联的拉取请求合并或关闭后，自动归档桌面会话。"],
    ["Authorization tokens", "授权令牌"],
    ["Created when you sign in to Claude Code. Revoke a token to sign out from that device.", "登录 Claude Code 时创建。撤销令牌即可让对应设备退出登录。"],
    ["Application", "应用"],
    ["Scopes", "权限范围"],
    ["No connected Claude Code instances", "没有已连接的 Claude Code 实例"],
    ["When you sign in to Claude Code, your authorization tokens will appear here.", "登录 Claude Code 后，你的授权令牌会显示在这里。"],
    ["Claude Code (CLI, Desktop, IDE)", "Claude Code（CLI、桌面端、IDE）"],
    ["Delete sessions stored by Anthropic", "删除 Anthropic 存储的会话"],
    ["Permanently delete Anthropic's server-side copies of your Claude Code sessions. Sessions stored locally on your computer aren't affected. Claude Code on the web sessions are managed separately — go to Claude Code.", "永久删除 Anthropic 服务器端保存的 Claude Code 会话副本。本机存储的会话不会受到影响。网页端 Claude Code 会话需单独管理，请前往 Claude Code。"],
    ["Permanently delete Anthropic’s server-side copies of your Claude Code sessions. Sessions stored locally on your computer aren’t affected. Claude Code on the web sessions are managed separately — go to Claude Code.", "永久删除 Anthropic 服务器端保存的 Claude Code 会话副本。本机存储的会话不会受到影响。网页端 Claude Code 会话需单独管理，请前往 Claude Code。"],
    ["General desktop settings", "通用桌面设置"],
    ["Run on startup", "开机启动"],
    ["Automatically start Claude when you log in to your computer", "登录电脑时自动启动 Claude"],
    ["Quick Entry keyboard shortcut", "快速入口键盘快捷键"],
    ["Quickly open Claude from anywhere", "在任意位置快速打开 Claude"],
    ["System tray", "系统托盘"],
    ["Keep Claude running in the system tray", "让 Claude 在系统托盘中保持运行"],
    ["Keep computer awake", "保持电脑唤醒"],
    ["Prevent your computer from idle-sleeping while Claude is open so scheduled tasks can run. Your display can still turn off. Closing the laptop lid will still put it to sleep.", "Claude 打开时阻止电脑因闲置而进入睡眠，以便计划任务继续运行。显示器仍可关闭；合上笔记本盖子仍会使电脑睡眠。"],
    ["Browse extensions", "浏览扩展"],
    ["Allow Claude to directly interact with apps, data, and tools on your computer.", "允许 Claude 直接与你电脑上的应用、数据和工具交互。"],
    ["Advanced settings", "高级设置"],
    ["Local MCP servers", "本地 MCP 服务器"],
    ["Add and manage MCP servers that you’re working on.", "添加并管理你正在使用的 MCP 服务器。"],
    ["Add and manage MCP servers that you're working on.", "添加并管理你正在使用的 MCP 服务器。"],
    ["No servers added", "尚未添加服务器"],
    ["Edit Config", "编辑配置"],
    ["Developer docs", "开发者文档"],
  ]);

  const MENU_TEXT_MAP = new Map([
    ["File", "文件"],
    ["Edit", "编辑"],
    ["View", "查看"],
    ["Window", "窗口"],
    ["Developer", "开发者"],
    ["Help", "帮助"],
    ["About...", "关于..."],
    ["About Claude", "关于 Claude"],
    ["New Conversation", "新建对话"],
    ["Settings...", "设置..."],
    ["Settings…", "设置…"],
    ["Open", "打开"],
    ["Close", "关闭"],
    ["Close Window", "关闭窗口"],
    ["Exit", "退出"],
    ["Quit", "退出"],
    ["Quit anyway", "仍然退出"],
    ["Cut", "剪切"],
    ["Copy", "复制"],
    ["Paste", "粘贴"],
    ["Undo", "撤销"],
    ["Redo", "重做"],
    ["Select All", "全选"],
    ["Find", "查找"],
    ["Find in page", "在页面中查找"],
    ["Back", "后退"],
    ["Forward", "前进"],
    ["Reload", "重新加载"],
    ["Reload This Page", "重新加载此页面"],
    ["Actual Size", "实际大小"],
    ["Zoom In", "放大"],
    ["Zoom Out", "缩小"],
    ["Troubleshooting", "故障排查"],
    ["Extensions", "扩展"],
    ["Open MCP Log File...", "打开 MCP 日志文件..."],
    ["Open MCP Log File…", "打开 MCP 日志文件…"],
    ["Open MCP Log File", "打开 MCP 日志文件"],
    ["Reload MCP Configuration", "重新加载 MCP 配置"],
    ["Open Hardware Buddy...", "打开硬件助手..."],
    ["Open Hardware Buddy…", "打开硬件助手…"],
    ["Open Hardware Buddy", "打开硬件助手"],
    ["Configure Third-Party Inference...", "配置第三方推理..."],
    ["Configure Third-Party Inference…", "配置第三方推理…"],
    ["Configure Third-Party Inference", "配置第三方推理"],
    ["Open App Config File...", "打开应用配置文件..."],
    ["Open App Config File…", "打开应用配置文件…"],
    ["Open App Config File", "打开应用配置文件"],
    ["Open Developer Config File...", "打开开发者配置文件..."],
    ["Open Developer Config File…", "打开开发者配置文件…"],
    ["Open Developer Config File", "打开开发者配置文件"],
    ["Show Dev Tools", "显示开发者工具"],
    ["Show All Dev Tools", "显示所有开发者工具"],
    ["Enable Main Process Debugger", "启用主进程调试器"],
    ["Record Performance Trace", "记录性能跟踪"],
    ["Write Main Process Heap Snapshot", "写入主进程堆快照"],
    ["Record Memory Trace (auto-stop)", "记录内存跟踪（自动停止）"],
    ["Record Net Log (30s)", "记录网络日志（30 秒）"],
    ["Inspect Element", "检查元素"],
    ["Generate Diagnostic Report", "生成诊断报告"],
    ["View Process Logs", "查看进程日志"],
    ["Disable Hardware Acceleration", "禁用硬件加速"],
    ["Check for Updates…", "检查更新…"],
    ["Install Update", "安装更新"],
    ["No Update Available", "没有可用更新"],
  ]);

  const ALL_TEXT_MAP = new Map([...MENU_TEXT_MAP, ...TEXT_MAP]);
  const REVERSE_TEXT_MAP = new Map(Array.from(ALL_TEXT_MAP, ([source, target]) => [target, source]));
  const SIDEBAR_TEXT_KEYS = new Set([
    "Chat",
    "Code",
    "New chat",
    "Projects",
    "Artifacts",
    "Customize",
    "聊天",
    "代码",
    "新建聊天",
    "项目",
    "工件",
    "自定义",
  ]);
  const ATTRIBUTE_NAMES = ["aria-label", "aria-placeholder", "data-placeholder", "placeholder", "title"];
  const PARTIAL_TEXT_MAP = new Map([
    ["Hey there,", "你好，"],
    ["Claude will keep these in mind across chats and Cowork within Anthropic's guidelines.", "Claude 会在聊天和 Cowork 中遵循 Anthropic 指南，并记住这些内容。"],
    ["Auto-populate the model picker from the provider's model-list endpoint at launch.", "启动时从提供方的模型列表端点自动填充模型选择器。"],
    ["Turn off if the endpoint isn’t reachable from your network, or to use a fixed list.", "如果你的网络无法访问该端点，或需要使用固定列表，请关闭此项。"],
    ["Turn off if the endpoint isn't reachable from your network, or to use a fixed list.", "如果你的网络无法访问该端点，或需要使用固定列表，请关闭此项。"],
    ["When off, the model list below is required and must use full model IDs (aliases like sonnet/opus are resolved via discovery).", "关闭后，必须填写下方模型列表，并使用完整模型 ID（sonnet/opus 等别名会通过发现机制解析）。"],
    ["Sent on every inference and model-discovery request (joined into the CLI's", "随每次推理请求和模型发现请求发送（会合并到 CLI 的"],
    ["Use this for fleet-wide constants. For per-user or per-session values, have the credential helper script emit JSON with a", "用于整个团队通用的固定值。若需按用户或会话设置，请让凭据辅助脚本输出带有"],
    ["field; those are merged over these static entries (helper wins on conflict).", "字段的 JSON；这些值会覆盖并合并到静态条目中（冲突时辅助脚本优先）。"],
    ["\"Essential\" means the signals Anthropic needs to keep your deployment working:", "“必要”指 Anthropic 为保持部署可用所需的信号："],
    ["crash stacks,", "崩溃堆栈，"],
    ["startup failure reasons,", "启动失败原因，"],
    ["and version/OS metadata. No prompts, completions, file contents, or identifiers beyond a random install ID.", "以及版本/操作系统元数据。不包含提示词、补全、文件内容，也不包含随机安装 ID 以外的标识符。"],
    ["when a Cowork build hits a bug that only reproduces on your OS version or locale, Anthropic can't see it unless a user manually reports. Fixes ship slower.", "当 Cowork 构建遇到只在你的操作系统版本或语言环境中复现的问题时，除非用户手动报告，否则 Anthropic 无法看到，修复也会更慢。"],
    ["some air-gapped environments require zero outbound telemetry as a matter of policy. The switch exists for them. If you don't have that constraint, leave it off.", "一些隔离网络环境的策略要求完全没有出站遥测，因此提供了这个开关。如果没有这种限制，请保持关闭。"],
    ["\"Nonessential\" covers two things:", "“非必要”包含两类内容："],
    ["product-usage analytics", "产品使用分析"],
    ["(which features get used, navigation patterns; no prompts or completions) and the Send action in Help → Generate Diagnostic Report. Turning this on stops both.", "（使用了哪些功能、导航模式；不含提示词或补全）以及“帮助 → 生成诊断报告”中的发送操作。开启后会同时停止这两项。"],
    ["Destination for both:", "两者的目标地址："],
    ["Already listed under Egress Requirements → Nonessential telemetry.", "已列在“出站要求 → 非必要遥测”中。"],
    ["Hosts your network firewall must allow, derived from your current settings.", "根据当前设置生成的网络防火墙必须允许访问的主机。"],
    ["This list is read-only and updates as you make changes.", "此列表为只读，并会随你的更改自动更新。"],
    ["Traffic is HTTPS on port 443 unless a custom port is specified (OTLP, gateway, or MCP server URLs).", "除非指定了自定义端口（OTLP、网关或 MCP 服务器 URL），否则流量使用 443 端口的 HTTPS。"],
    ["{featureName} isn't included in your plan", "当前套餐不包含 {featureName}"],
    ["{featureName} isn’t included in your plan", "当前套餐不包含 {featureName}"],
    ["Upgrade to Pro or Max to use {featureName} on desktop.", "升级到 Pro 或 Max 即可在桌面端使用 {featureName}。"],
    ["Accepts exact hostnames", "接受精确主机名"],
    ["Wildcards don't cross schemes", "通配符不会跨协议匹配"],
    ["Wildcards don’t cross schemes", "通配符不会跨协议匹配"],
    ["IP literals and localhost always resolve", "IP 字面量和 localhost 始终会解析"],
    ["Hosts you add here also need to be open on your network firewall. See Egress Requirements for the full allowlist.", "你在此处添加的主机也需要在网络防火墙中放行。完整允许列表请查看“出站要求”。"],
  ]);

  function cssText() {
    return `
      .cdp-launcher {
        z-index: 2147483647;
        height: 32px;
        border: 0;
        border-radius: 8px;
        padding: 0 10px;
        background: transparent;
        color: #3d3d3a;
        font: 13px system-ui, sans-serif;
        cursor: pointer;
        pointer-events: auto;
        white-space: nowrap;
        -webkit-app-region: no-drag;
        app-region: no-drag;
      }
      .cdp-launcher-inline {
        position: fixed;
      }
      .cdp-launcher-fallback {
        position: fixed;
        top: 8px;
        right: 250px;
      }
      .cdp-dialog-backdrop {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        display: grid;
        place-items: center;
        background: rgba(21, 21, 19, 0.28);
        backdrop-filter: blur(2px);
      }
      .cdp-dialog {
        width: min(420px, calc(100vw - 32px));
        max-height: calc(100vh - 32px);
        overflow: auto;
        color: #2f2f2c;
        background: #fffdfa;
        border: 1px solid rgba(51, 51, 47, 0.12);
        border-radius: 12px;
        box-shadow: 0 18px 54px rgba(20, 20, 18, 0.18);
        font: 14px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        pointer-events: auto;
      }
      .cdp-dialog header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-height: 44px;
        padding: 0 16px;
        border-bottom: 1px solid rgba(51, 51, 47, 0.1);
      }
      .cdp-dialog h2 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
      }
      .cdp-dialog main {
        padding: 4px 16px 16px;
      }
      .cdp-row {
        display: flex;
        gap: 14px;
        align-items: center;
        justify-content: space-between;
        min-height: 52px;
        border-bottom: 1px solid rgba(51, 51, 47, 0.1);
      }
      .cdp-row-label {
        flex: 0 0 auto;
        color: #353531;
        font-weight: 500;
      }
      .cdp-select {
        width: min(230px, 58vw);
        min-width: 0;
        border: 1px solid rgba(51, 51, 47, 0.14);
        border-radius: 8px;
        padding: 7px 10px;
        background: #fff;
        color: #2f2f2c;
        font: inherit;
      }
      .cdp-about {
        display: grid;
        gap: 8px;
        padding-top: 12px;
      }
      .cdp-about-title {
        margin: 0;
        color: #353531;
        font-size: 14px;
        font-weight: 500;
        line-height: 1.4;
      }
      .cdp-summary {
        margin: 0;
        padding: 0;
        color: #70706a;
        font-size: 13px;
        line-height: 1.45;
      }
      .cdp-version {
        color: #353531;
        font-size: 13px;
        font-weight: 500;
      }
      .cdp-version-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-height: 24px;
        padding-top: 2px;
      }
      .cdp-link-row {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
        padding: 2px 0 0;
      }
      .cdp-link-button {
        min-width: 0;
        border: 1px solid rgba(51, 51, 47, 0.14);
        border-radius: 8px;
        padding: 8px 8px;
        background: #fff;
        color: #353531;
        cursor: pointer;
        font: inherit;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cdp-link-button:hover {
        background: rgba(51, 51, 47, 0.05);
      }
      .cdp-launcher:hover {
        background: rgba(15, 15, 15, 0.06);
      }
      .cdp-close {
        display: grid;
        width: 28px;
        height: 28px;
        place-items: center;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: #6f6f6a;
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
      }
      .cdp-close:hover {
        background: rgba(51, 51, 47, 0.06);
      }
      @media (max-width: 420px) {
        .cdp-row {
          align-items: stretch;
          flex-direction: column;
          justify-content: center;
          padding: 12px 0;
        }
        .cdp-select {
          width: 100%;
        }
        .cdp-link-row {
          grid-template-columns: 1fr;
        }
      }
      @media (prefers-color-scheme: dark) {
        .cdp-dialog {
          color: #e5e7eb;
          background: #1f1f1d;
          border-color: rgba(229, 231, 235, 0.16);
        }
        .cdp-launcher {
          color: #e5e7eb;
        }
        .cdp-row,
        .cdp-summary {
          border-color: rgba(229, 231, 235, 0.14);
        }
        .cdp-about-title {
          color: #f3f4f6;
        }
        .cdp-summary {
          color: #d1d5db;
        }
        .cdp-select,
        .cdp-link-button {
          color: #e5e7eb;
          background: #1f2937;
          border-color: rgba(229, 231, 235, 0.16);
        }
        .cdp-link-button:hover,
        .cdp-launcher:hover,
        .cdp-close:hover {
          background: #243041;
        }
        .cdp-version {
          color: #f9fafb;
        }
      }
    `;
  }

  function ensureStyles() {
    if (document.querySelector("[data-claude-desktop-plus-style]")) {
      return;
    }
    const style = document.createElement("style");
    style.dataset.claudeDesktopPlusStyle = "true";
    style.textContent = cssText();
    document.head.appendChild(style);
  }

  function addLauncherButton() {
    let button = document.querySelector("[data-claude-desktop-plus-launcher]");
    if (!(button instanceof HTMLButtonElement)) {
      button = document.createElement("button");
      button.type = "button";
      button.dataset.claudeDesktopPlusLauncher = "true";
      button.className = "cdp-launcher";
      button.textContent = `Plus ${PLUS_VERSION}`;
      button.setAttribute("aria-label", `Claude Desktop Plus ${PLUS_VERSION}`);
      button.setAttribute("title", `Claude Desktop Plus ${PLUS_VERSION}`);
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        showPanel();
      });
    }

    const anchor = findTopRightAnchor();
    if (anchor) {
      button.classList.add("cdp-launcher-inline");
      button.classList.remove("cdp-launcher-fallback");
      if (button.parentElement !== document.body) {
        document.body.appendChild(button);
      }
      positionLauncherBeforeAnchor(button, anchor);
      return;
    }

    button.classList.remove("cdp-launcher-inline");
    button.classList.add("cdp-launcher-fallback");
    if (!button.isConnected) {
      document.body.appendChild(button);
    }
  }

  function findTopRightAnchor() {
    const byLabel = Array.from(document.querySelectorAll("button, [role='button']")).find(element => {
      if (!(element instanceof HTMLElement) || element.dataset.claudeDesktopPlusLauncher) {
        return false;
      }
      const label = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`.toLowerCase();
      return label.includes("incognito") || label.includes("private");
    });
    if (byLabel instanceof HTMLElement) {
      return byLabel;
    }

    const topButtons = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter(element => {
        if (!(element instanceof HTMLElement) || element.dataset.claudeDesktopPlusLauncher) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        const text = normalizedText(element.textContent || "");
        return rect.top >= 0
          && rect.top < 56
          && rect.right > window.innerWidth - 260
          && rect.width >= 24
          && rect.width <= 56
          && rect.height >= 24
          && rect.height <= 56
          && text.length <= 2;
      })
      .sort((left, right) => left.getBoundingClientRect().left - right.getBoundingClientRect().left);

    return topButtons[0] instanceof HTMLElement ? topButtons[0] : null;
  }

  function positionLauncherBeforeAnchor(button, anchor) {
    const anchorRect = anchor.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const left = Math.max(8, anchorRect.left - buttonRect.width - 8);
    const top = Math.max(6, anchorRect.top + ((anchorRect.height - buttonRect.height) / 2));
    button.style.left = `${Math.round(left)}px`;
    button.style.right = "auto";
    button.style.top = `${Math.round(top)}px`;
  }

  function showPanel() {
    const existing = document.querySelector("[data-claude-desktop-plus-panel]");
    if (existing) {
      existing.remove();
      return;
    }

    const currentLocale = readSelectedLocale();
    const backdrop = document.createElement("div");
    backdrop.dataset.claudeDesktopPlusPanel = "true";
    backdrop.className = "cdp-dialog-backdrop";
    backdrop.innerHTML = `
      <section class="cdp-dialog" role="dialog" aria-modal="true" aria-label="Claude Desktop Plus">
        <header>
          <h2>Claude Desktop Plus</h2>
          <button class="cdp-close" type="button" data-cdp-close aria-label="${escapeAttribute(plusText("close", currentLocale))}">×</button>
        </header>
        <main>
          <div class="cdp-row">
            <span class="cdp-row-label" data-cdp-i18n="language">${escapeHtml(plusText("language", currentLocale))}</span>
            <select class="cdp-select" data-cdp-locale aria-label="${escapeAttribute(plusText("language", currentLocale))}">
              ${LANGUAGES.map(language => `<option value="${escapeAttribute(language.locale)}" ${language.locale === currentLocale ? "selected" : ""}>${escapeHtml(language.label)}</option>`).join("")}
            </select>
          </div>
          <div class="cdp-about">
            <h3 class="cdp-about-title" data-cdp-i18n="about">${escapeHtml(plusText("about", currentLocale))}</h3>
            <p class="cdp-summary" data-cdp-i18n="summary">${escapeHtml(plusText("summary", currentLocale))}</p>
            <div class="cdp-version-row">
              <span class="cdp-row-label" data-cdp-i18n="version">${escapeHtml(plusText("version", currentLocale))}</span>
              <span class="cdp-version">${PLUS_VERSION}</span>
            </div>
            <div class="cdp-link-row">
              <button class="cdp-link-button" type="button" data-cdp-link="${escapeAttribute(HOMEPAGE_URL)}" data-cdp-i18n="homepage">${escapeHtml(plusText("homepage", currentLocale))}</button>
              <button class="cdp-link-button" type="button" data-cdp-link="${escapeAttribute(DISCORD_URL)}" data-cdp-i18n="discord">${escapeHtml(plusText("discord", currentLocale))}</button>
              <button class="cdp-link-button" type="button" data-cdp-link="${escapeAttribute(QQ_GROUP_URL)}" data-cdp-i18n="qqGroup">${escapeHtml(plusText("qqGroup", currentLocale))}</button>
            </div>
          </div>
        </main>
      </section>
    `;
    backdrop.addEventListener("click", event => {
      if (event.target === backdrop) {
        backdrop.remove();
      }
    });
    backdrop.querySelector("[data-cdp-close]")?.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      backdrop.remove();
    });
    backdrop.querySelector("[data-cdp-locale]")?.addEventListener("change", event => {
      event.preventDefault();
      event.stopPropagation();
      const select = event.currentTarget;
      if (select instanceof HTMLSelectElement) {
        void applyLocale(select.value, {userInitiated: true});
        updatePlusPanelText(backdrop, select.value);
      }
    });
    backdrop.querySelectorAll("[data-cdp-link]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const url = button instanceof HTMLElement ? button.dataset.cdpLink : "";
        if (url) {
          openExternalLink(url);
        }
      });
    });
    document.body.appendChild(backdrop);
  }

  function updatePlusPanelText(root, locale) {
    root.querySelectorAll("[data-cdp-i18n]").forEach(element => {
      if (!(element instanceof HTMLElement)) {
        return;
      }
      const key = element.dataset.cdpI18n;
      if (key) {
        element.textContent = plusText(key, locale);
      }
    });
    const close = root.querySelector("[data-cdp-close]");
    if (close instanceof HTMLElement) {
      close.setAttribute("aria-label", plusText("close", locale));
    }
    const select = root.querySelector("[data-cdp-locale]");
    if (select instanceof HTMLSelectElement) {
      select.setAttribute("aria-label", plusText("language", locale));
      select.value = locale;
    }
  }

  function plusText(key, locale = readSelectedLocale()) {
    return PLUS_I18N[locale]?.[key] || PLUS_I18N["en-US"][key] || key;
  }

  function readSelectedLocale() {
    if (activeLocale) {
      return activeLocale;
    }
    return readDesiredLocale();
  }

  function readDesiredLocale() {
    const transition = readTransitionLocale();
    if (transition) {
      return transition;
    }
    if (isKnownLocale(activeLocale)) {
      return activeLocale;
    }
    if (isKnownLocale(DEFAULT_LOCALE)) {
      return DEFAULT_LOCALE;
    }
    const stored = readStoredLocale();
    if (stored) {
      return stored;
    }
    const initial = readClaudeInitialLocale();
    if (initial) {
      return initial;
    }
    return DEFAULT_LOCALE;
  }

  function clearPendingReloadLocale() {
    try {
      sessionStorage.removeItem(RELOAD_STORAGE_KEY);
    } catch (_error) {
      // Ignore storage failures in restricted frames.
    }
  }

  function readTransitionLocale() {
    try {
      const raw = localStorage.getItem(TRANSITION_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const transition = JSON.parse(raw);
      if (!transition || Date.now() - Number(transition.at || 0) > 30000) {
        localStorage.removeItem(TRANSITION_STORAGE_KEY);
        return null;
      }
      return isKnownLocale(transition.locale) ? transition.locale : null;
    } catch (_error) {
      return null;
    }
  }

  function writeTransitionLocale(locale) {
    try {
      localStorage.setItem(TRANSITION_STORAGE_KEY, JSON.stringify({locale, at: Date.now()}));
    } catch (_error) {
      // Ignore storage failures in restricted frames.
    }
  }

  function clearTransitionLocale(locale) {
    try {
      const current = readTransitionLocale();
      if (!locale || current === locale) {
        localStorage.removeItem(TRANSITION_STORAGE_KEY);
      }
    } catch (_error) {
      // Ignore storage failures in restricted frames.
    }
  }

  function readStoredLocale() {
    try {
      const locale = localStorage.getItem(LANGUAGE_STORAGE_KEY);
      return isKnownLocale(locale) ? locale : null;
    } catch (_error) {
      return null;
    }
  }

  function readClaudeInitialLocale() {
    const initial = globalThis.initialLocale;
    if (isKnownLocale(initial)) {
      return initial;
    }
    try {
      const result = desktopIntl()?.getInitialLocale?.();
      if (isKnownLocale(result?.locale)) {
        return result.locale;
      }
    } catch (_error) {
      // Claude may not expose DesktopIntl in every frame.
    }
    return null;
  }

  function writeSelectedLocale(locale) {
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
    } catch (_error) {
      // Ignore storage failures in restricted frames.
    }
  }

  function isKnownLocale(locale) {
    return LANGUAGES.some(language => language.locale === locale);
  }

  function labelForLocale(locale) {
    return LANGUAGES.find(language => language.locale === locale)?.label || locale;
  }

  async function applyLocale(locale, options = {}) {
    const safeLocale = isKnownLocale(locale) ? locale : DEFAULT_LOCALE;
    activeLocale = safeLocale;
    writeSelectedLocale(safeLocale);
    clearPendingReloadLocale();
    if (!options.userInitiated) {
      scheduleLanguageControlScan();
      scheduleVisibleTranslation();
      debugLog("apply display locale", safeLocale);
      return;
    }
    if (!canControlClaudeLocale()) {
      debugLog("skip locale request outside Claude page", safeLocale, window.location.href);
      return;
    }
    syncClaudeLanguageControls(safeLocale);
    scheduleLanguageControlScan();
    scheduleVisibleTranslation();
    writeTransitionLocale(safeLocale);
    const relaunched = await requestClaudeRelaunchLocale(safeLocale);
    if (relaunched) {
      return;
    }
    const changed = await requestClaudeLocaleAndWait(safeLocale);
    if (changed) {
      refreshMainWindowForLocale(safeLocale);
    }
  }

  async function requestClaudeRelaunchLocale(locale) {
    try {
      const api = plusNative();
      if (api?.setLocaleAndRelaunch) {
        debugLog("persist and relaunch via native bridge", locale);
        const result = await api.setLocaleAndRelaunch(locale);
        debugLog("native relaunch result", JSON.stringify(result));
        return result?.locale === locale && result?.relaunching === true;
      }
    } catch (error) {
      debugLog("native relaunch failed", error?.message || error);
    }
    return false;
  }

  async function requestClaudeLocaleAndWait(locale) {
    debugLog("request locale", locale, "initial", readClaudeInitialLocale(), "stored", readStoredLocale());
    const persisted = await persistClaudeLocale(locale);
    const intl = desktopIntl();
    if (!intl?.requestLocaleChange) {
      debugLog("DesktopIntl unavailable after persist", locale, persisted);
      return persisted;
    }

    let cleanup = null;
    const changed = new Promise(resolve => {
      let done = false;
      const finish = value => {
        if (done) {
          return;
        }
        done = true;
        cleanup?.();
        resolve(value);
      };
      const timeout = window.setTimeout(() => finish(true), 1200);
      cleanup = () => window.clearTimeout(timeout);
      if (typeof intl.onLocaleChanged === "function") {
        try {
          const unsubscribe = intl.onLocaleChanged(nextLocale => {
            if (nextLocale === locale) {
              finish(true);
            }
          });
          cleanup = () => {
            window.clearTimeout(timeout);
            try {
              unsubscribe?.();
            } catch (_error) {
              // Ignore unsubscribe failures.
            }
          };
        } catch (_error) {
          // Continue with timeout fallback.
        }
      }
    });

    try {
      const result = await intl.requestLocaleChange(locale);
      if (result === false) {
        cleanup?.();
        debugLog("DesktopIntl returned false", locale, persisted);
        return persisted;
      }
      const didChange = Boolean(await changed) || persisted;
      debugLog("DesktopIntl changed", locale, didChange);
      return didChange;
    } catch (error) {
      cleanup?.();
      debugLog("DesktopIntl request failed", locale, error?.message || error, persisted);
      return persisted;
    }
  }

  function enforceDesiredLocale(reason) {
    if (!canControlClaudeLocale() || localeEnforcementInFlight) {
      return;
    }
    if (readTransitionLocale()) {
      debugLog("skip enforce during locale transition", reason, readTransitionLocale());
      return;
    }
    const desired = readDesiredLocale();
    if (!isKnownLocale(desired)) {
      return;
    }
    activeLocale = desired;
    writeSelectedLocale(desired);
    updateOpenPanelLocale(desired);
    const initial = readClaudeInitialLocale();
    if (initial === desired) {
      debugLog("locale already enforced", reason, desired);
      return;
    }
    debugLog("enforce locale", reason, "desired", desired, "initial", initial);
    localeEnforcementInFlight = true;
    void requestClaudeLocaleAndWait(desired).finally(() => {
      localeEnforcementInFlight = false;
    });
  }

  function scheduleLocaleEnforcement(reason) {
    if (!canControlClaudeLocale()) {
      return;
    }
    if (readTransitionLocale()) {
      debugLog("skip schedule during locale transition", reason, readTransitionLocale());
      return;
    }
    window.clearTimeout(localeEnforceTimer);
    for (const delay of [120, 900, 2400]) {
      window.setTimeout(() => enforceDesiredLocale(`${reason}+${delay}`), delay);
    }
    localeEnforceTimer = window.setTimeout(() => enforceDesiredLocale(`${reason}+final`), 5200);
  }

  async function persistClaudeLocale(locale) {
    try {
      const api = plusNative();
      if (api?.setLocale) {
        debugLog("persist via native bridge", locale);
        const result = await api.setLocale(locale);
        debugLog("native bridge result", JSON.stringify(result));
        return result?.locale === locale;
      }
    } catch (error) {
      debugLog("native bridge failed", error?.message || error);
      // Continue with Claude's own DesktopIntl bridge.
    }
    debugLog("persist via protocol", locale);
    return persistClaudeLocaleViaProtocol(locale);
  }

  function persistClaudeLocaleViaProtocol(locale) {
    return new Promise(resolve => {
      if (!isTopWindow()) {
        resolve(false);
        return;
      }
      const frame = document.createElement("iframe");
      const timer = window.setTimeout(() => {
        frame.remove();
        resolve(true);
      }, 350);
      frame.style.display = "none";
      frame.onload = () => {
        window.clearTimeout(timer);
        frame.remove();
        resolve(true);
      };
      frame.onerror = () => {
        window.clearTimeout(timer);
        frame.remove();
        resolve(false);
      };
      frame.src = `claude-desktop-plus://set-locale?locale=${encodeURIComponent(locale)}&t=${Date.now()}`;
      document.documentElement.appendChild(frame);
    });
  }

  function debugLog(...args) {
    const message = args.map(arg => {
      if (typeof arg === "string") {
        return arg;
      }
      try {
        return JSON.stringify(arg);
      } catch (_error) {
        return String(arg);
      }
    }).join(" ");
    try {
      plusNative()?.log?.(message);
    } catch (_error) {
      // Ignore bridge logging failures.
    }
    try {
      if (localStorage.getItem(DEBUG_KEY) === "1") {
        console.log("[ClaudeDesktopPlus]", ...args);
      }
    } catch (_error) {
      // Ignore storage failures.
    }
  }

  function syncClaudeLanguageControls(locale) {
    const language = LANGUAGES.find(item => item.locale === locale);
    if (!language) {
      return;
    }

    document.querySelectorAll("select").forEach(select => {
      if (!(select instanceof HTMLSelectElement)) {
        return;
      }
      if (select.closest("[data-claude-desktop-plus-panel]")) {
        return;
      }
      const visibleText = select.textContent || "";
      const looksLikeLanguageSelect = /English|Deutsch|Español|Français|日本語|한국어|Português|Italiano|हिन्दी|Bahasa|简体中文/i.test(visibleText);
      if (!looksLikeLanguageSelect) {
        return;
      }
      const option = Array.from(select.options).find(item => item.value === locale)
        || Array.from(select.options).find(item => normalizedText(item.textContent || "") === language.label);
      if (!option) {
        return;
      }
      select.value = option.value;
      select.dispatchEvent(new Event("input", {bubbles: true}));
      select.dispatchEvent(new Event("change", {bubbles: true}));
    });

    document.querySelectorAll("[role='option'], [role='menuitem']").forEach(element => {
      if (!(element instanceof HTMLElement)) {
        return;
      }
      if (element.dataset.claudeDesktopPlusLocaleOption) {
        return;
      }
      const text = normalizedText(element.textContent || "");
      if (text === language.label) {
        element.click();
      }
    });
  }

  function refreshMainWindowForLocale(locale) {
    if (!canControlClaudeLocale()) {
      return;
    }
    window.clearTimeout(localeReloadTimer);
    try {
      sessionStorage.setItem(RELOAD_STORAGE_KEY, locale);
    } catch (_error) {
      // Ignore storage failures in restricted frames.
    }
    localeReloadTimer = window.setTimeout(() => {
      try {
        window.location.reload();
      } catch (_error) {
        // Some pages cannot be reloaded.
      }
    }, 250);
  }

  function desktopIntl() {
    return globalThis.claude?.hybrid?.DesktopIntl || globalThis["claude.hybrid"]?.DesktopIntl || null;
  }

  function plusNative() {
    return globalThis.claudeDesktopPlus || globalThis["claude-desktop-plus"] || null;
  }

  function installClaudeLocaleListener() {
    if (!canControlClaudeLocale()) {
      return;
    }
    if (unsubscribeClaudeLocale) {
      return;
    }
    const intl = desktopIntl();
    if (typeof intl?.onLocaleChanged !== "function") {
      return;
    }
    try {
      unsubscribeClaudeLocale = intl.onLocaleChanged(locale => {
        if (!isKnownLocale(locale)) {
          return;
        }
        const transition = readTransitionLocale();
        if (transition) {
          debugLog("ignore DesktopIntl event during transition", locale, "desired", transition);
          activeLocale = transition;
          writeSelectedLocale(transition);
          updateOpenPanelLocale(transition);
          if (locale === transition) {
            clearTransitionLocale(transition);
          }
          return;
        }
        const desired = readDesiredLocale();
        debugLog("DesktopIntl locale event", locale, "desired", desired);
        if (desired && locale !== desired) {
          activeLocale = desired;
          writeSelectedLocale(desired);
          updateOpenPanelLocale(desired);
          return;
        }
        writeSelectedLocale(locale);
        activeLocale = locale;
        clearTransitionLocale(locale);
        scheduleVisibleTranslation();
        updateOpenPanelLocale(locale);
      });
    } catch (_error) {
      unsubscribeClaudeLocale = null;
    }
  }

  function updateOpenPanelLocale(locale) {
    const panel = document.querySelector("[data-claude-desktop-plus-panel]");
    if (panel instanceof HTMLElement) {
      updatePlusPanelText(panel, locale);
    }
  }

  function isTopWindow() {
    try {
      return window.top === window;
    } catch (_error) {
      return true;
    }
  }

  function canControlClaudeLocale() {
    if (!isTopWindow()) {
      return false;
    }
    try {
      const url = new URL(window.location.href);
      return url.hostname === "claude.ai"
        || url.hostname === "preview.claude.ai"
        || url.hostname === "claude.com"
        || url.hostname === "preview.claude.com"
        || url.hostname === "localhost";
    } catch (_error) {
      return false;
    }
  }

  function maybeAddLanguageOption(select) {
    if (!(select instanceof HTMLSelectElement)) {
      return;
    }
    if (select.closest("[data-claude-desktop-plus-panel]")) {
      return;
    }

    const visibleText = select.textContent || "";
    const looksLikeLanguageSelect = /English|Deutsch|Espanol|Español|Francais|Français|日本語|한국어|Portugues|Português|Italiano|Hindi|हिन्दी|Bahasa|简体中文/i.test(visibleText);
    if (!looksLikeLanguageSelect) {
      return;
    }

    for (const language of LANGUAGES) {
      const hasLocale = Array.from(select.options).some(option => option.value === language.locale || normalizedText(option.textContent || "") === language.label);
      if (!hasLocale) {
        const option = document.createElement("option");
        option.value = language.locale;
        option.textContent = language.label;
        select.appendChild(option);
      }
    }
  }

  function maybeAddLanguageMenuOptions(element) {
    if (!(element instanceof HTMLElement)) {
      return;
    }
    if (element.closest("[data-claude-desktop-plus-panel]")) {
      return;
    }
    const text = normalizedText(element.textContent || "");
    if (!/English/.test(text)) {
      return;
    }
    const parent = element.parentElement;
    if (!parent) {
      return;
    }

    for (const language of LANGUAGES) {
      const hasLanguage = Array.from(parent.children).some(child => {
        if (!(child instanceof HTMLElement)) {
          return false;
        }
        return child.dataset.claudeDesktopPlusLocaleOption === language.locale
          || normalizedText(child.textContent || "") === language.label;
      });
      if (hasLanguage) {
        continue;
      }

      const clone = element.cloneNode(true);
      if (!(clone instanceof HTMLElement)) {
        continue;
      }
      clone.dataset.claudeDesktopPlusLocaleOption = language.locale;
      clone.textContent = labelForLocale(language.locale);
      clone.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        applyLocale(language.locale, {userInitiated: true});
      });
      parent.appendChild(clone);
    }
  }

  function scanLanguageControls() {
    document.querySelectorAll("select").forEach(maybeAddLanguageOption);
    document.querySelectorAll("[role='option'], [role='menuitem'], button").forEach(maybeAddLanguageMenuOptions);
  }

  function scheduleLanguageControlScan() {
    if (languageControlScanTimer) {
      return;
    }
    languageControlScanTimer = window.setTimeout(() => {
      languageControlScanTimer = 0;
      scanLanguageControls();
    }, 120);
  }

  function scheduleInteractionTranslation() {
    window.clearTimeout(interactionTranslateTimer);
    interactionTranslateTimer = window.setTimeout(() => {
      scheduleLanguageControlScan();
      scheduleMenuTranslation();
      scheduleSidebarTranslation();
    }, 80);
  }

  function scheduleMenuTranslation() {
    const selectors = [
      "[role='menu']",
      "[role='menubar']",
      "[role='menuitem']",
      "[role='menuitemcheckbox']",
      "[role='menuitemradio']",
      "[data-radix-popper-content-wrapper]",
      "[data-floating-ui-portal]",
      "[data-headlessui-portal]",
    ];
    const roots = document.querySelectorAll(selectors.join(","));
    if (!roots.length) {
      return;
    }
    roots.forEach(root => {
      if (root instanceof HTMLElement && root.offsetParent !== null) {
        scheduleStaticTranslation(root);
      }
    });
  }

  function scheduleVisibleTranslation() {
    scheduleSidebarTranslation();
    const selectors = [
      "[data-testid]",
      "[role='dialog']",
      "[role='menu']",
      "[role='menuitem']",
      "[role='tablist']",
      "[role='tabpanel']",
      "header",
      "nav",
      "main",
      "aside",
    ];
    const roots = Array.from(document.querySelectorAll(selectors.join(",")))
      .filter(root => root instanceof HTMLElement && root.offsetParent !== null)
      .slice(0, 8);
    if (!roots.length && document.body) {
      for (const child of Array.from(document.body.children).slice(0, 8)) {
        if (child instanceof HTMLElement && child.offsetParent !== null) {
          roots.push(child);
        }
      }
    }
    for (const root of roots) {
      scheduleStaticTranslation(root);
    }
  }

  function scheduleSidebarTranslation() {
    if (sidebarTranslateTimer) {
      return;
    }
    sidebarTranslateTimer = window.setTimeout(() => {
      sidebarTranslateTimer = 0;
      translateSidebarText();
    }, 80);
  }

  function scheduleSidebarTranslationBurst() {
    const now = Date.now();
    if (now - sidebarBurstAt < 350) {
      return;
    }
    sidebarBurstAt = now;
    [0, 120, 350, 800, 1600, 2800].forEach(delay => {
      window.setTimeout(scheduleSidebarTranslation, delay);
    });
  }

  function translateSidebarText() {
    if (!document.body) {
      return;
    }
    const candidates = document.querySelectorAll("button, a, [role='button'], [role='link'], [role='tab']");
    let translatedCount = 0;
    for (const element of candidates) {
      if (!(element instanceof HTMLElement) || element.closest("[data-claude-desktop-plus-panel]")) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.left < 0 || rect.left > 420 || rect.top < 40 || rect.top > 330) {
        continue;
      }
      const text = normalizedText(element.textContent || "");
      if (!SIDEBAR_TEXT_KEYS.has(text)) {
        continue;
      }
      translateStaticText(element);
      translatedCount += 1;
      if (translatedCount >= 16) {
        break;
      }
    }
  }

  function installNavigationTranslationHooks() {
    if (navigationHooksInstalled) {
      return;
    }
    navigationHooksInstalled = true;
    const scheduleAfterNavigation = () => {
      scheduleLanguageControlScan();
      scheduleSidebarTranslationBurst();
    };
    ["pushState", "replaceState"].forEach(name => {
      const original = history[name];
      if (typeof original !== "function") {
        return;
      }
      history[name] = function patchedHistoryMethod(...args) {
        const result = original.apply(this, args);
        scheduleAfterNavigation();
        return result;
      };
    });
    window.addEventListener("popstate", scheduleAfterNavigation, true);
    window.addEventListener("hashchange", scheduleAfterNavigation, true);
    window.addEventListener("pageshow", scheduleAfterNavigation, true);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        scheduleAfterNavigation();
      }
    }, true);
  }

  function normalizedText(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  function scheduleStaticTranslation(root = document.body) {
    if (!root || !(root instanceof Node)) {
      return;
    }
    if (pendingTranslateRoots.size < TRANSLATE_ROOT_LIMIT) {
      pendingTranslateRoots.add(root);
    } else {
      pendingTranslateRoots.clear();
      pendingTranslateRoots.add(root);
    }
    if (translateQueueTimer) {
      return;
    }
    translateQueueTimer = window.setTimeout(flushStaticTranslationQueue, 80);
  }

  function flushStaticTranslationQueue() {
    translateQueueTimer = 0;
    const roots = Array.from(pendingTranslateRoots);
    pendingTranslateRoots.clear();
    for (const root of roots) {
      if (root === document.body) {
        continue;
      }
      translateStaticText(root);
    }
  }

  function translateStaticText(root = document.body) {
    if (!document.body || !root || !(root instanceof Node)) {
      return;
    }
    const forward = readSelectedLocale() === TRANSLATED_LOCALE;
    const map = forward ? ALL_TEXT_MAP : REVERSE_TEXT_MAP;
    const partialMap = forward
      ? PARTIAL_TEXT_MAP
      : new Map(Array.from(PARTIAL_TEXT_MAP, ([source, target]) => [target, source]));
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent || parent.closest("[data-claude-desktop-plus-panel]")) {
            return NodeFilter.FILTER_REJECT;
          }
          if (parent.closest("script, style, textarea, input, select")) {
            return NodeFilter.FILTER_REJECT;
          }
          if (parent.closest("code, pre, kbd, samp")) {
            return NodeFilter.FILTER_REJECT;
          }
          const text = normalizedText(node.nodeValue || "");
          return map.has(text) || textMatchesPartialMap(node.nodeValue || "", partialMap)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      },
    );

    const nodes = [];
    while (nodes.length < TRANSLATE_BATCH_LIMIT && walker.nextNode()) {
      nodes.push(walker.currentNode);
    }

    for (const node of nodes) {
      const raw = node.nodeValue || "";
      const key = normalizedText(raw);
      const translated = translateTextValue(key, raw, map, partialMap);
      if (translated) {
        node.nodeValue = translated;
      }
    }

    translateElementAttributes(root, map, partialMap);
  }

  function translateTextValue(key, raw, map, partialMap) {
    const exact = map.get(key);
    if (exact) {
      return raw.replace(key, exact);
    }
    for (const [source, target] of partialMap) {
      if (raw.includes(source)) {
        return raw.replaceAll(source, target);
      }
    }
    return null;
  }

  function textMatchesPartialMap(raw, partialMap) {
    for (const source of partialMap.keys()) {
      if (raw.includes(source)) {
        return true;
      }
    }
    return false;
  }

  function translateElementAttributes(root, map, partialMap) {
    const selector = ATTRIBUTE_NAMES.map(name => `[${name}]`).join(",");
    const elements = root instanceof Element
      ? [root, ...root.querySelectorAll(selector)]
      : root.querySelectorAll
        ? Array.from(root.querySelectorAll(selector))
        : [];
    elements.slice(0, TRANSLATE_BATCH_LIMIT).forEach(element => {
      if (!(element instanceof HTMLElement)) {
        return;
      }
      if (element.closest("[data-claude-desktop-plus-panel]")) {
        return;
      }
      for (const name of ATTRIBUTE_NAMES) {
        const raw = element.getAttribute(name);
        if (!raw) {
          continue;
        }
        const key = normalizedText(raw);
        const translated = translateTextValue(key, raw, map, partialMap);
        if (translated && translated !== raw) {
          element.setAttribute(name, translated);
        }
      }
    });

    const inputs = root instanceof Element
      ? [root, ...root.querySelectorAll("input, textarea")]
      : root.querySelectorAll
        ? Array.from(root.querySelectorAll("input, textarea"))
        : [];
    inputs.slice(0, TRANSLATE_BATCH_LIMIT).forEach(element => {
      if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
        return;
      }
      if (element.closest("[data-claude-desktop-plus-panel]")) {
        return;
      }
      const raw = element.placeholder;
      if (!raw) {
        return;
      }
      const translated = translateTextValue(normalizedText(raw), raw, map, partialMap);
      if (translated && translated !== raw) {
        element.placeholder = translated;
      }
    });
  }

  function openExternalLink(url) {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value);
  }

  function boot() {
    ensureStyles();
    clearPendingReloadLocale();
    installClaudeLocaleListener();
    installNavigationTranslationHooks();
    addLauncherButton();
    void applyLocale(readSelectedLocale());
    scheduleSidebarTranslationBurst();
    scheduleLocaleEnforcement("boot");
    document.addEventListener("pointerdown", scheduleInteractionTranslation, true);
    document.addEventListener("keydown", scheduleInteractionTranslation, true);
    document.addEventListener("focusin", scheduleInteractionTranslation, true);

    const observer = new MutationObserver(records => {
      addLauncherButton();
      scheduleLanguageControlScan();
      scheduleSidebarTranslationBurst();
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement || node instanceof Text) {
            scheduleStaticTranslation(node instanceof Text ? node.parentElement : node);
          }
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, {once: true});
  } else {
    boot();
  }
})();
