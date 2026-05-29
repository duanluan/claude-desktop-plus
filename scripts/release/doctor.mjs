import {spawnSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import path from "node:path";

import {normalizeUpdaterPubkey} from "./shared.mjs";

const checks = [];
const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const projectPubkeyPath = path.join(repoRoot, "src-tauri", "updater.pubkey");
const defaultKeyPath = expandHome("~/.tauri/claude-desktop-plus/updater.key");
const defaultPubkeyPath = `${defaultKeyPath}.pub`;
const defaultPasswordPath = "/home/njcm/Downloads/tmp/2.txt";

function commandExists(command, args = ["--version"]) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  return result.status === 0;
}

function pkgConfigExists(packageName) {
  const result = spawnSync("pkg-config", ["--exists", packageName], {
    encoding: "utf8",
  });

  return result.status === 0;
}

function addCheck(name, passed, hint = "") {
  checks.push({hint, name, passed});
}

function addWarning(name, passed, hint = "") {
  checks.push({hint, name, passed, warning: true});
}

function hasUpdaterPubkey() {
  if (normalizeUpdaterPubkey(process.env.TAURI_UPDATER_PUBKEY || "")) {
    return true;
  }

  for (const candidate of [projectPubkeyPath, defaultPubkeyPath]) {
    if (!existsSync(candidate)) {
      continue;
    }

    if (normalizeUpdaterPubkey(readFileSync(candidate, "utf8"))) {
      return true;
    }
  }

  return false;
}

addCheck("node", commandExists("node"));
addCheck("pnpm", commandExists("pnpm"));
addCheck("git", commandExists("git"));
addCheck("rustc", commandExists("rustc"));
addCheck("cargo", commandExists("cargo"));
addCheck(
  "TAURI_SIGNING_PRIVATE_KEY",
  Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || existsSync(defaultKeyPath)),
  "Set TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH to the updater private key.",
);
addCheck(
  "TAURI_UPDATER_PUBKEY",
  hasUpdaterPubkey(),
  "Set TAURI_UPDATER_PUBKEY or commit src-tauri/updater.pubkey.",
);
addCheck(
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || existsSync(defaultPasswordPath)),
  "Set TAURI_SIGNING_PRIVATE_KEY_PASSWORD or keep the local password file available.",
);
addCheck(
  "GitHub release token",
  Boolean(process.env.CLAUDE_DESKTOP_PLUS_RELEASE_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN) || commandExists("gh", ["auth", "status"]),
  "Set CLAUDE_DESKTOP_PLUS_RELEASE_TOKEN, GH_TOKEN, GITHUB_TOKEN, or log in with gh.",
);

if (process.platform === "linux") {
  addCheck("curl", commandExists("curl"));
  addCheck("patchelf", commandExists("patchelf"));
  addCheck("rpm", commandExists("rpm"));
  addCheck("xdg-open", commandExists("xdg-open"));
  addCheck("pkg-config", commandExists("pkg-config"));

  if (commandExists("pkg-config")) {
    addCheck("webkit2gtk-4.1", pkgConfigExists("webkit2gtk-4.1"), "Install libwebkit2gtk-4.1-dev.");
    addCheck("appindicator3-0.1", pkgConfigExists("appindicator3-0.1"), "Install libappindicator3-dev.");
    addCheck("librsvg-2.0", pkgConfigExists("librsvg-2.0"), "Install librsvg2-dev.");
  }
}

if (process.platform === "darwin") {
  addCheck("xcodebuild", commandExists("xcodebuild", ["-version"]));
  addWarning(
    "Apple signing",
    Boolean(process.env.APPLE_CERTIFICATE && process.env.APPLE_CERTIFICATE_PASSWORD && process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID),
    "Set Apple certificate and notarization secrets for a formal signed macOS release.",
  );
}

if (process.platform === "win32") {
  addCheck("powershell", commandExists("powershell", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]));
  addWarning(
    "Windows signing",
    Boolean(process.env.WINDOWS_CERTIFICATE || process.env.WINDOWS_CERTIFICATE_PATH || process.env.WINDOWS_SIGN_COMMAND),
    "Set Windows signing certificate or a Tauri signCommand for a formal Windows release.",
  );
}

const failed = checks.filter(check => !check.passed && !check.warning);

for (const check of checks) {
  const status = check.passed ? "ok" : check.warning ? "warning" : "missing";
  console.log(`${status.padEnd(8)} ${check.name}${check.hint && !check.passed ? ` - ${check.hint}` : ""}`);
}

if (failed.length > 0) {
  process.exitCode = 1;
}

function expandHome(value) {
  if (value === "~") {
    return process.env.HOME || value;
  }

  if (value.startsWith("~/")) {
    return path.join(process.env.HOME || "~", value.slice(2));
  }

  return value;
}
