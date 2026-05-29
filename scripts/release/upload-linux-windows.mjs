import {spawn, spawnSync} from "node:child_process";
import {createWriteStream, existsSync} from "node:fs";
import {cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const releaseScriptsDir = path.join(repoRoot, "scripts", "release");
const defaultWindowsHost = "192.168.101.218";
const defaultWindowsUser = "administrator";
const defaultWindowsPassword = "123";
const defaultWindowsPort = 22;
const defaultArtifactsDir = "release-artifacts";
const defaultKeyPath = "~/.tauri/claude-desktop-plus/updater.key";
const defaultKeyPasswordPath = "/home/njcm/Downloads/tmp/2.txt";

function parseArgs(argv) {
  const args = {
    currentWorktree: false,
    dryRun: false,
    keepWorktree: false,
    skipLinux: false,
    skipSync: false,
    upload: false,
    windowsPasswordFile: "",
    windowsHost: defaultWindowsHost,
    windowsPassword: defaultWindowsPassword,
    windowsPort: defaultWindowsPort,
    windowsUser: defaultWindowsUser,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];

    if (item === "--current-worktree") {
      args.currentWorktree = true;
      continue;
    }

    if (item === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (item === "--keep-worktree") {
      args.keepWorktree = true;
      continue;
    }

    if (item === "--skip-linux") {
      args.skipLinux = true;
      continue;
    }

    if (item === "--skip-sync") {
      args.skipSync = true;
      continue;
    }

    if (item === "--upload") {
      args.upload = true;
      continue;
    }

    if (item.startsWith("--")) {
      const equalsIndex = item.indexOf("=");
      const name = equalsIndex >= 0 ? item.slice(0, equalsIndex) : item;
      const inlineValue = equalsIndex >= 0 ? item.slice(equalsIndex + 1) : undefined;
      const value = inlineValue ?? argv[index + 1];

      if (inlineValue === undefined) {
        index += 1;
      }

      switch (name) {
        case "--commit":
          args.commit = value;
          break;
        case "--github-token":
          args.githubToken = value;
          break;
        case "--key":
          args.key = value;
          break;
        case "--key-password":
          args.keyPassword = value ?? "";
          break;
        case "--key-password-file":
          args.keyPasswordFile = value;
          break;
        case "--pubkey":
          args.pubkey = value;
          break;
        case "--release-repo":
          args.releaseRepo = value;
          break;
        case "--tag":
          args.tag = value;
          break;
        case "--artifacts-dir":
          args.artifactsDir = value;
          break;
        case "--windows-dir":
          args.windowsDir = value;
          break;
        case "--windows-host":
          args.windowsHost = value;
          break;
        case "--windows-password":
          args.windowsPassword = value;
          break;
        case "--windows-password-file":
          args.windowsPasswordFile = value;
          break;
        case "--windows-port":
          args.windowsPort = Number(value);
          break;
        case "--windows-user":
          args.windowsUser = value;
          break;
        default:
          throw new Error(`Unknown argument: ${name}`);
      }

      continue;
    }

    throw new Error(`Unknown argument: ${item}`);
  }

  return args;
}

function usage() {
  return [
    "Usage:",
    "  pnpm release:upload-linux-win --current-worktree",
    "  pnpm release:upload-linux-win --commit <sha> --upload",
    "",
    "Environment alternatives:",
    "  RELEASE_COMMIT, CLAUDE_DESKTOP_PLUS_RELEASE_TOKEN, GH_TOKEN, GITHUB_TOKEN,",
    "  TAURI_SIGNING_PRIVATE_KEY_PATH, TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD,",
    "  CLAUDE_DESKTOP_PLUS_WINDOWS_PASSWORD, CLAUDE_DESKTOP_PLUS_WINDOWS_PASSWORD_FILE",
  ].join("\n");
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  const config = await resolveConfig(cliArgs);

  validateHostCommands(["node", "pnpm", "docker", "ssh", "scp", "sshpass", "tar"]);
  if (!config.currentWorktree) {
    validateHostCommands(["git"]);
  }

  let worktreeDir = "";
  let removeWorktreeDir = false;

  try {
    if (config.currentWorktree) {
      worktreeDir = repoRoot;
    } else {
      const fullCommit = capture("git", ["rev-parse", "--verify", `${config.commit}^{commit}`], repoRoot).trim();
      const shortCommit = capture("git", ["rev-parse", "--short=12", fullCommit], repoRoot).trim();
      worktreeDir = path.join(repoRoot, ".release-cache", "worktrees", `upload-${shortCommit}-${Date.now()}`);
      removeWorktreeDir = true;

      log(`create worktree ${shortCommit}`);
      await mkdir(path.dirname(worktreeDir), {recursive: true});
      await run("git", ["worktree", "add", "--detach", worktreeDir, fullCommit], {cwd: repoRoot});
      await injectReleaseTooling(worktreeDir);
      await injectPackageScripts(worktreeDir);
    }

    const packageJson = JSON.parse(await readFile(path.join(worktreeDir, "package.json"), "utf8"));
    const releaseTag = config.tag || `v${packageJson.version}`;
    const releaseEnv = buildReleaseEnv(config, {
      commit: config.commit || "current-worktree",
      tag: releaseTag,
    });
    const shortName = config.currentWorktree
      ? `current-${Date.now()}`
      : capture("git", ["rev-parse", "--short=12", config.commit], repoRoot).trim();
    const windowsDir = config.windowsDir || `C:\\workspaces\\claude-desktop-plus-release-${shortName}`;

    log(`release ${releaseTag}`);
    log(`repo ${releaseEnv.RELEASE_REPO}`);
    log(`mode ${config.upload ? "build-and-upload" : "build-only"}`);
    log(`windows ${config.windowsUser}@${config.windowsHost}:${config.windowsPort} -> ${windowsDir}`);

    if (config.dryRun) {
      printDryRun({
        releaseTag,
        windowsDir,
        worktreeDir,
        upload: config.upload,
      });
      return;
    }

    await checkWindowsTools(config);

    if (!config.skipLinux) {
      log("install dependencies");
      await run("pnpm", ["install", "--frozen-lockfile"], {cwd: worktreeDir, env: releaseEnv});

      log(config.upload ? "build/upload linux deb/rpm" : "build linux deb/rpm");
      await run("node", [
        "scripts/release/build-desktop.mjs",
        "--bundles",
        "deb,rpm",
        "--skip-install",
        ...(config.upload ? ["--upload"] : []),
      ], {
        cwd: worktreeDir,
        env: releaseEnv,
      });

      log(config.upload ? "build/upload linux appimage" : "build linux appimage");
      await run("node", [
        "scripts/release/build-linux-appimage-docker.mjs",
        ...(config.upload ? ["--upload"] : []),
      ], {
        cwd: worktreeDir,
        env: releaseEnv,
      });
    }

    const localArtifactsDir = path.resolve(worktreeDir, config.artifactsDir, releaseTag);
    await archiveLinuxArtifacts(worktreeDir, localArtifactsDir);

    if (!config.skipSync) {
      log("sync windows worktree");
      await syncWorktreeToWindows(worktreeDir, windowsDir, config);
    }

    log(config.upload ? "build/upload windows bundles" : "build windows bundles");
    await runWindowsBuild(windowsDir, config, releaseEnv);
    await downloadWindowsArtifacts(windowsDir, localArtifactsDir, config);

    if (config.upload) {
      log("refresh draft latest.json and SHA256SUMS");
      await run("node", ["scripts/release/publish-desktop.mjs", "--draft", "--platforms", "linux,windows"], {
        cwd: worktreeDir,
        env: releaseEnv,
      });
    }
  } finally {
    if (removeWorktreeDir && worktreeDir && !config.keepWorktree) {
      await removeGitWorktree(worktreeDir);
    } else if (removeWorktreeDir && worktreeDir) {
      log(`kept worktree ${worktreeDir}`);
    }
  }
}

async function resolveConfig(args) {
  const commit = args.commit || process.env.RELEASE_COMMIT;
  const githubToken = args.githubToken
    || process.env.CLAUDE_DESKTOP_PLUS_RELEASE_TOKEN
    || process.env.GH_TOKEN
    || process.env.GITHUB_TOKEN
    || getGitHubCliToken();
  const keyValue = args.key || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || process.env.TAURI_SIGNING_PRIVATE_KEY || defaultKeyPath;
  const keyPassword = args.keyPassword
    ?? process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    ?? await readPasswordFile(args.keyPasswordFile || process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE || defaultKeyPasswordPath);
  const windowsPassword = args.windowsPassword
    || process.env.CLAUDE_DESKTOP_PLUS_WINDOWS_PASSWORD
    || process.env.WINDOWS_PASSWORD
    || await readPasswordFile(args.windowsPasswordFile || process.env.CLAUDE_DESKTOP_PLUS_WINDOWS_PASSWORD_FILE)
    || defaultWindowsPassword;

  if (!args.currentWorktree && !commit) {
    throw new Error(`${usage()}\n\nMissing required value: commit. Use --current-worktree to package the current working tree.`);
  }

  if (args.upload && !githubToken) {
    throw new Error(`${usage()}\n\nMissing required value: github token`);
  }

  const key = await readKey(keyValue);
  const pubkey = (args.pubkey || process.env.TAURI_UPDATER_PUBKEY || await findPubkeyForKey(key)).trim();

  if (!pubkey) {
    throw new Error("Missing pubkey. Pass --pubkey, set TAURI_UPDATER_PUBKEY, or provide a key file with a sibling .pub file.");
  }

  if (!Number.isInteger(args.windowsPort) || args.windowsPort <= 0) {
    throw new Error(`Invalid --windows-port: ${args.windowsPort}`);
  }

  if (!windowsPassword) {
    throw new Error(`${usage()}\n\nMissing required value: Windows SSH password. Pass --windows-password or --windows-password-file.`);
  }

  return {
    artifactsDir: args.artifactsDir || process.env.CLAUDE_DESKTOP_PLUS_ARTIFACTS_DIR || defaultArtifactsDir,
    commit,
    currentWorktree: args.currentWorktree,
    dryRun: args.dryRun,
    githubToken,
    keepWorktree: args.keepWorktree,
    key,
    keyPassword,
    pubkey,
    releaseRepo: args.releaseRepo || process.env.RELEASE_REPO || process.env.CLAUDE_DESKTOP_PLUS_RELEASE_REPO || "duanluan/claude-desktop-plus",
    tag: args.tag || process.env.RELEASE_TAG || "",
    skipLinux: args.skipLinux,
    skipSync: args.skipSync,
    upload: args.upload,
    windowsDir: args.windowsDir,
    windowsHost: args.windowsHost,
    windowsPassword,
    windowsPort: args.windowsPort,
    windowsUser: args.windowsUser,
  };
}

async function readPasswordFile(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return "";
  }

  return (await readFile(filePath, "utf8")).trimEnd();
}

async function readKey(value) {
  const expanded = expandHome(value);

  if (existsSync(expanded)) {
    return {
      content: await readFile(expanded, "utf8"),
      path: expanded,
    };
  }

  return {
    content: value,
    path: "",
  };
}

async function findPubkeyForKey(key) {
  if (!key.path) {
    return "";
  }

  const candidates = [
    `${key.path}.pub`,
    path.join(path.dirname(key.path), `${path.basename(key.path, path.extname(key.path))}.pub`),
  ];

  for (const candidate of new Set(candidates)) {
    if (existsSync(candidate)) {
      return readFile(candidate, "utf8");
    }
  }

  return "";
}

function getGitHubCliToken() {
  const result = spawnSync("gh", ["auth", "token"], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return "";
  }

  return result.stdout.trim();
}

function expandHome(value) {
  if (!value) {
    return "";
  }

  if (value === "~") {
    return process.env.HOME || value;
  }

  if (value.startsWith("~/")) {
    return path.join(process.env.HOME || "~", value.slice(2));
  }

  return path.resolve(value);
}

function validateHostCommands(commands) {
  const missing = commands.filter(command => !commandExists(command));

  if (missing.length > 0) {
    throw new Error(`Missing host command: ${missing.join(", ")}`);
  }
}

function commandExists(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
    cwd: repoRoot,
  });

  return result.status === 0;
}

async function injectReleaseTooling(worktreeDir) {
  await mkdir(path.join(worktreeDir, "scripts"), {recursive: true});
  await rm(path.join(worktreeDir, "scripts", "release"), {force: true, recursive: true});
  await cp(releaseScriptsDir, path.join(worktreeDir, "scripts", "release"), {recursive: true});

  const sourceReleaseConfig = path.join(repoRoot, "src-tauri", "tauri.release.conf.json");
  const targetReleaseConfig = path.join(worktreeDir, "src-tauri", "tauri.release.conf.json");

  if (existsSync(sourceReleaseConfig)) {
    await mkdir(path.dirname(targetReleaseConfig), {recursive: true});
    await cp(sourceReleaseConfig, targetReleaseConfig);
  }
}

async function injectPackageScripts(worktreeDir) {
  const packageJsonPath = path.join(worktreeDir, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));

  packageJson.scripts = {
    ...packageJson.scripts,
    "release:doctor": "node scripts/release/doctor.mjs",
    "release:desktop": "node scripts/release/build-desktop.mjs",
    "release:linux-appimage": "node scripts/release/build-linux-appimage-docker.mjs",
    "release:publish": "node scripts/release/publish-desktop.mjs",
    "release:upload-linux-win": "node scripts/release/upload-linux-windows.mjs",
  };

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function buildReleaseEnv(config, release) {
  return {
    ...process.env,
    CLAUDE_DESKTOP_PLUS_RELEASE_REPO: config.releaseRepo,
    CLAUDE_DESKTOP_PLUS_RELEASE_TOKEN: config.githubToken || "",
    GH_TOKEN: config.githubToken || "",
    GITHUB_TOKEN: config.githubToken || "",
    RELEASE_COMMITISH: "main",
    RELEASE_REPO: config.releaseRepo,
    RELEASE_TAG: release.tag,
    TAURI_SIGNING_PRIVATE_KEY: config.key.content,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: config.keyPassword,
    TAURI_UPDATER_PUBKEY: config.pubkey,
    ...(config.key.path ? {TAURI_SIGNING_PRIVATE_KEY_PATH: config.key.path} : {}),
  };
}

async function checkWindowsTools(config) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$env:PATH = \"$env:USERPROFILE\\.cargo\\bin;$env:ProgramFiles\\GitHub CLI;$env:ProgramFiles\\nodejs;$env:PATH\"",
    "node --version",
    "corepack enable",
    "corepack prepare pnpm@10.33.0 --activate",
    "pnpm.cmd --version",
    "rustc --version",
    "cargo --version",
    "$vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe'",
    "if (!(Test-Path $vswhere)) { throw 'Visual Studio Build Tools vswhere.exe not found' }",
    "$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath",
    "if (!$vsPath) { throw 'MSVC x64 build tools not found' }",
    "Write-Output \"windows tools ok: $vsPath\"",
  ].join("\n");

  await runWindowsPowerShell(config, script);
}

async function syncWorktreeToWindows(worktreeDir, remoteDir, config) {
  const remoteCommand = [
    "$ErrorActionPreference = 'Stop'",
    `Remove-Item -Recurse -Force ${psString(remoteDir)} -ErrorAction SilentlyContinue`,
    `New-Item -ItemType Directory -Force ${psString(remoteDir)} | Out-Null`,
    `tar -xzf - -C ${psString(remoteDir)}`,
  ].join("\n");

  const tar = spawn("tar", [
    "--exclude=./node_modules",
    "--exclude=./.git",
    "--exclude=./dist",
    "--exclude=./src-tauri/target",
    "--exclude=./.release-cache",
    "-czf",
    "-",
    "-C",
    worktreeDir,
    ".",
  ], {
    stdio: ["ignore", "pipe", "inherit"],
  });

  const ssh = spawn("sshpass", [
    "-p",
    config.windowsPassword,
    "ssh",
    ...sshOptions(config),
    windowsTarget(config),
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    powershellEncodedCommand(remoteCommand),
  ], {
    stdio: ["pipe", "inherit", "inherit"],
  });

  tar.stdout.pipe(ssh.stdin);

  await Promise.all([
    waitForChild(tar, "tar"),
    waitForChild(ssh, "ssh windows sync"),
  ]);
}

function powershellEncodedCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

async function runWindowsBuild(remoteDir, config, releaseEnv) {
  const keyContent = releaseEnv.TAURI_SIGNING_PRIVATE_KEY;
  const uploadArgs = config.upload ? " --upload" : "";
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$env:PATH = \"$env:USERPROFILE\\.cargo\\bin;$env:ProgramFiles\\GitHub CLI;$env:ProgramFiles\\nodejs;$env:PATH\"",
    `$repo = ${psString(remoteDir)}`,
    "$tempDir = Join-Path $repo '.release-temp'",
    "$keyPath = Join-Path $tempDir 'updater.key'",
    "New-Item -ItemType Directory -Force $tempDir | Out-Null",
    `$keyContent = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psString(base64(keyContent))}))`,
    "$utf8NoBom = New-Object System.Text.UTF8Encoding($false)",
    "[IO.File]::WriteAllText($keyPath, $keyContent, $utf8NoBom)",
    "try {",
    "  Set-Location $repo",
    "  corepack enable",
    "  corepack prepare pnpm@10.33.0 --activate",
    `  $env:CLAUDE_DESKTOP_PLUS_RELEASE_TOKEN = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psString(base64(releaseEnv.CLAUDE_DESKTOP_PLUS_RELEASE_TOKEN || ""))}))`,
    "  $env:GH_TOKEN = $env:CLAUDE_DESKTOP_PLUS_RELEASE_TOKEN",
    "  $env:GITHUB_TOKEN = $env:CLAUDE_DESKTOP_PLUS_RELEASE_TOKEN",
    `  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psString(base64(releaseEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || ""))}))`,
    "  $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $keyPath",
    "  Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue",
    `  $env:TAURI_UPDATER_PUBKEY = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psString(base64(releaseEnv.TAURI_UPDATER_PUBKEY || ""))}))`,
    `  $env:RELEASE_REPO = ${psString(releaseEnv.RELEASE_REPO)}`,
    `  $env:CLAUDE_DESKTOP_PLUS_RELEASE_REPO = ${psString(releaseEnv.CLAUDE_DESKTOP_PLUS_RELEASE_REPO)}`,
    `  $env:RELEASE_TAG = ${psString(releaseEnv.RELEASE_TAG)}`,
    `  $env:RELEASE_COMMITISH = ${psString(releaseEnv.RELEASE_COMMITISH)}`,
    "  node scripts/release/doctor.mjs",
    `  node scripts/release/build-desktop.mjs${uploadArgs}`,
    "} finally {",
    "  Remove-Item -Force $keyPath -ErrorAction SilentlyContinue",
    "}",
  ].join("\n");

  await runWindowsPowerShell(config, script);
}

async function archiveLinuxArtifacts(worktreeDir, localArtifactsDir) {
  const sources = [
    {
      destination: path.join(localArtifactsDir, "linux-x64", "deb"),
      source: path.join(worktreeDir, "src-tauri", "target", "release", "bundle", "deb"),
    },
    {
      destination: path.join(localArtifactsDir, "linux-x64", "rpm"),
      source: path.join(worktreeDir, "src-tauri", "target", "release", "bundle", "rpm"),
    },
    {
      destination: path.join(localArtifactsDir, "linux-x64", "appimage"),
      source: path.join(worktreeDir, "src-tauri", "target", "ubuntu22-appimage", "release", "bundle", "appimage"),
    },
  ];

  for (const item of sources) {
    if (!existsSync(item.source)) {
      continue;
    }

    await copyReleaseFiles(item.source, item.destination);
  }
}

async function copyReleaseFiles(sourceDir, destinationDir) {
  const entries = await readdir(sourceDir, {withFileTypes: true});

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);

    if (entry.isDirectory()) {
      await copyReleaseFiles(sourcePath, destinationDir);
      continue;
    }

    if (!entry.isFile() || !isBundleArtifact(entry.name)) {
      continue;
    }

    await mkdir(destinationDir, {recursive: true});
    await cp(sourcePath, path.join(destinationDir, entry.name));
    log(`artifact saved ${path.relative(repoRoot, path.join(destinationDir, entry.name))}`);
  }
}

async function downloadWindowsArtifacts(remoteDir, localArtifactsDir, config) {
  const localDir = path.join(localArtifactsDir, "windows-x64");
  const localArchive = path.join(await mkdtemp(path.join(tmpdir(), "claude-desktop-plus-windows-artifacts-")), "windows-artifacts.zip");
  const remoteArchive = `${remoteDir}\\windows-artifacts.zip`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$repo = ${psString(remoteDir)}`,
    `$archive = ${psString(remoteArchive)}`,
    "$bundle = Join-Path $repo 'src-tauri\\target\\release\\bundle'",
    "if (!(Test-Path $bundle)) { throw \"Windows bundle directory not found: $bundle\" }",
    "Remove-Item -Force $archive -ErrorAction SilentlyContinue",
    "$files = Get-ChildItem -Path $bundle -Recurse -File | Where-Object { $_.Name -match '\\.(exe|msi|sig)$' }",
    "if (!$files) { throw 'No Windows bundle artifacts were found.' }",
    "Compress-Archive -Path $files.FullName -DestinationPath $archive -Force",
    "Write-Output $archive",
  ].join("\n");

  log("download windows artifacts");
  await runWindowsPowerShell(config, script);
  await mkdir(localDir, {recursive: true});
  await downloadWindowsFile(config, remoteArchive, localArchive);
  await run("unzip", ["-o", localArchive, "-d", localDir], {cwd: repoRoot});
  await rm(path.dirname(localArchive), {force: true, recursive: true});

  for (const artifact of await listReleaseFiles(localDir)) {
    log(`artifact saved ${path.relative(repoRoot, artifact)}`);
  }
}

async function listReleaseFiles(dir) {
  const files = [];
  const entries = await readdir(dir, {withFileTypes: true});

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...await listReleaseFiles(fullPath));
      continue;
    }

    if (entry.isFile() && isBundleArtifact(entry.name)) {
      files.push(fullPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

async function downloadWindowsFile(config, remotePath, localPath) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$file = ${psString(remotePath)}`,
    "if (!(Test-Path $file)) { throw \"Remote file not found: $file\" }",
    "$bytes = [IO.File]::ReadAllBytes($file)",
    "$stdout = [Console]::OpenStandardOutput()",
    "$stdout.Write($bytes, 0, $bytes.Length)",
    "$stdout.Flush()",
  ].join("\n");
  const child = spawn("sshpass", [
    "-p",
    config.windowsPassword,
    "ssh",
    ...sshOptions(config),
    windowsTarget(config),
    "powershell",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    powershellEncodedCommand(script),
  ], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const output = createWriteStream(localPath);

  child.stdout.pipe(output);

  await Promise.all([
    waitForChild(child, "download windows artifacts"),
    waitForWritable(output, "write windows artifacts"),
  ]);
}

async function runWindowsPowerShell(config, script) {
  const child = spawn("sshpass", [
    "-p",
    config.windowsPassword,
    "ssh",
    ...sshOptions(config),
    windowsTarget(config),
    "powershell",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    powershellEncodedCommand(script),
  ], {
    stdio: ["ignore", "inherit", "inherit"],
  });

  await waitForChild(child, "windows powershell");
}

function sshOptions(config) {
  const knownHostsPath = path.join(repoRoot, ".release-cache", "windows_known_hosts");
  spawnSync("mkdir", ["-p", path.dirname(knownHostsPath)]);
  return [
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`,
    "-p",
    String(config.windowsPort),
  ];
}

function windowsTarget(config) {
  return `${config.windowsUser}@${config.windowsHost}`;
}

function isBundleArtifact(fileName) {
  return [
    ".AppImage",
    ".AppImage.sig",
    ".deb",
    ".deb.sig",
    ".exe",
    ".exe.sig",
    ".msi",
    ".msi.sig",
    ".rpm",
    ".rpm.sig",
  ].some(suffix => fileName.endsWith(suffix));
}

function printDryRun(info) {
  console.log(JSON.stringify({
    dryRun: true,
    linux: [
      "pnpm install --frozen-lockfile",
      `node scripts/release/build-desktop.mjs --bundles deb,rpm --skip-install${info.upload ? " --upload" : ""}`,
      `node scripts/release/build-linux-appimage-docker.mjs${info.upload ? " --upload" : ""}`,
    ],
    refreshDraft: info.upload ? "node scripts/release/publish-desktop.mjs --draft --platforms linux,windows" : null,
    release: info.releaseTag,
    windowsDir: info.windowsDir,
    windowsUpload: `node scripts/release/build-desktop.mjs${info.upload ? " --upload" : ""}`,
    worktreeDir: info.worktreeDir,
  }, null, 2));
}

async function removeGitWorktree(worktreeDir) {
  try {
    await run("git", ["worktree", "remove", "--force", worktreeDir], {cwd: repoRoot});
  } catch {
    await rm(worktreeDir, {force: true, recursive: true});
  }
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    stdio: "inherit",
  });

  await waitForChild(child, `${command} ${args.join(" ")}`);
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout;
}

async function waitForChild(child, label) {
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${label} exited with ${code}`));
    });
  });
}

async function waitForWritable(stream, label) {
  await new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.on("finish", resolve);
    stream.on("close", resolve);
  }).catch(error => {
    throw new Error(`${label} failed: ${error.message || error}`);
  });
}

function base64(value) {
  return Buffer.from(value || "", "utf8").toString("base64");
}

function psString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function log(message) {
  console.log(`[release] ${message}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
