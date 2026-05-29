import {spawn} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {cp, mkdir} from "node:fs/promises";
import path from "node:path";

import {repoRoot} from "./shared.mjs";

const imageName = "claude-desktop-plus-linux-appimage-builder:ubuntu22";
const cacheDir = path.join(repoRoot, ".release-cache");
const dockerfilePath = path.join(repoRoot, "scripts", "release", "linux-appimage.Dockerfile");

function parseArgs(argv) {
  const args = {
    buildImage: true,
    innerArgs: ["release:desktop", "--bundles", "appimage", "--skip-install"],
  };

  for (const item of argv) {
    if (item === "--skip-image-build") {
      args.buildImage = false;
      continue;
    }

    if (item === "--upload" || item === "--no-clean") {
      args.innerArgs.push(item);
      continue;
    }

    if (item === "--install") {
      args.innerArgs = args.innerArgs.filter(arg => arg !== "--skip-install");
      continue;
    }

    if (item === "--skip-install") {
      continue;
    }

    throw new Error(`Unknown argument: ${item}`);
  }

  return args;
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: options.env ?? process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function releaseEnvironment() {
  const env = {...process.env};
  const keyPath = expandHome(env.TAURI_SIGNING_PRIVATE_KEY_PATH) || pathIfExisting(env.TAURI_SIGNING_PRIVATE_KEY);

  if (keyPath) {
    env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, "utf8");
    delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  }

  return env;
}

function pathIfExisting(value) {
  if (!value) {
    return "";
  }

  try {
    const filePath = expandHome(value);
    return existsSync(filePath) ? filePath : "";
  } catch {
    return "";
  }
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

async function prepareCache() {
  await mkdir(path.join(cacheDir, "cargo"), {recursive: true});
  await mkdir(path.join(cacheDir, "home"), {recursive: true});
  await mkdir(path.join(cacheDir, "pnpm-home"), {recursive: true});
  await mkdir(path.join(cacheDir, "pnpm-store"), {recursive: true});

  const hostTauriCache = path.join(process.env.HOME || "", ".cache", "tauri");
  const containerTauriCache = path.join(cacheDir, "home", ".cache", "tauri");

  if (existsSync(hostTauriCache) && !existsSync(containerTauriCache)) {
    await mkdir(path.dirname(containerTauriCache), {recursive: true});
    await cp(hostTauriCache, containerTauriCache, {recursive: true});
  }
}

function dockerRunArgs(env, innerArgs) {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const envNames = [
    "ALLOW_PUBLISHED_RELEASE_UPLOAD",
    "ALLOW_RELEASE_TAG_MISMATCH",
    "CLAUDE_DESKTOP_PLUS_RELEASE_REPO",
    "CLAUDE_DESKTOP_PLUS_RELEASE_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "RELEASE_REPO",
    "RELEASE_TAG",
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "TAURI_UPDATER_PUBKEY",
  ];

  return [
    "run",
    "--rm",
    "--init",
    "--user",
    `${uid}:${gid}`,
    "--volume",
    `${repoRoot}:/work`,
    "--workdir",
    "/work",
    "--env",
    "APPIMAGE_EXTRACT_AND_RUN=1",
    "--env",
    "CARGO_HOME=/work/.release-cache/cargo",
    "--env",
    "CARGO_TARGET_DIR=/work/src-tauri/target/ubuntu22-appimage",
    "--env",
    "HOME=/work/.release-cache/home",
    "--env",
    "PNPM_HOME=/work/.release-cache/pnpm-home",
    "--env",
    "RUSTUP_HOME=/opt/rustup",
    "--env",
    "XDG_CACHE_HOME=/work/.release-cache/home/.cache",
    ...envNames.filter(name => env[name]).flatMap(name => ["--env", name]),
    imageName,
    "bash",
    "-lc",
    [
      "set -euo pipefail",
      "mkdir -p \"$CARGO_HOME\" \"$PNPM_HOME\" /work/.release-cache/pnpm-store",
      "printf '[source.crates-io]\\nreplace-with = \"rsproxy-sparse\"\\n\\n[source.rsproxy-sparse]\\nregistry = \"%s\"\\n\\n[registries.crates-io]\\nprotocol = \"sparse\"\\n\\n[http]\\nmultiplexing = false\\n' \"$CARGO_REGISTRY\" > \"$CARGO_HOME/config.toml\"",
      "pnpm config set store-dir /work/.release-cache/pnpm-store",
      `pnpm ${innerArgs.join(" ")}`,
    ].join("; "),
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = releaseEnvironment();

  await prepareCache();

  if (args.buildImage) {
    await run("docker", [
      "build",
      "--tag",
      imageName,
      "--file",
      dockerfilePath,
      path.dirname(dockerfilePath),
    ]);
  }

  await run("docker", dockerRunArgs(env, args.innerArgs), {env});
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
