import {spawn} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {chmod, readdir, rename, rm} from "node:fs/promises";
import path from "node:path";

import {
  appName,
  bundleRootForTarget,
  cleanBundleRoots,
  collectBundleArtifacts,
  ensureDraftRelease,
  generatedReleaseConfigPath,
  getReleaseContext,
  loadPackageJson,
  productName,
  repoRoot,
  uploadAsset,
  writeGeneratedReleaseConfig,
} from "./shared.mjs";

function parseArgs(argv) {
  const args = {
    bundles: [],
    clean: true,
    install: true,
    skipBuild: false,
    targets: [],
    upload: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];

    if (item === "--target") {
      args.targets.push(argv[index + 1]);
      index += 1;
      continue;
    }

    if (item.startsWith("--target=")) {
      args.targets.push(item.slice("--target=".length));
      continue;
    }

    if (item === "--bundles" || item === "--bundle") {
      args.bundles.push(...parseBundleList(argv[index + 1]));
      index += 1;
      continue;
    }

    if (item.startsWith("--bundles=")) {
      args.bundles.push(...parseBundleList(item.slice("--bundles=".length)));
      continue;
    }

    if (item.startsWith("--bundle=")) {
      args.bundles.push(...parseBundleList(item.slice("--bundle=".length)));
      continue;
    }

    if (item === "--upload") {
      args.upload = true;
      continue;
    }

    if (item === "--skip-build") {
      args.skipBuild = true;
      args.clean = false;
      args.install = false;
      continue;
    }

    if (item === "--skip-install") {
      args.install = false;
      continue;
    }

    if (item === "--no-clean") {
      args.clean = false;
      continue;
    }

    throw new Error(`Unknown argument: ${item}`);
  }

  return args;
}

function parseBundleList(value) {
  if (!value) {
    throw new Error("Missing bundle value.");
  }

  return value.split(",").map(item => item.trim()).filter(Boolean);
}

function defaultBundlesForHost() {
  if (process.platform !== "linux") {
    return [];
  }

  if (!isArchLikeLinux()) {
    return [];
  }

  return ["deb", "rpm"];
}

function isArchLikeLinux() {
  try {
    const osRelease = readFileSync("/etc/os-release", "utf8").toLowerCase();
    return /\bid=(arch|manjaro)\b/.test(osRelease) || /\bid_like=.*\barch\b/.test(osRelease);
  } catch {
    return false;
  }
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const isWindowsPnpm = process.platform === "win32" && command === "pnpm";
    const executable = isWindowsPnpm ? "cmd.exe" : command;
    const commandArgs = isWindowsPnpm ? ["/d", "/s", "/c", "pnpm.cmd", ...args] : args;
    const child = spawn(executable, commandArgs, {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
      ...options,
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

async function runOrFail(command, args, options = {}) {
  try {
    await run(command, args, options);
  } catch (error) {
    if (options.fallback) {
      await options.fallback(error);
      return;
    }

    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bundles = args.bundles.length > 0 ? args.bundles : defaultBundlesForHost();

  if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    throw new Error("Missing TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH");
  }

  if (!process.env.TAURI_SIGNING_PRIVATE_KEY && process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    process.env.TAURI_SIGNING_PRIVATE_KEY = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  }

  const releaseConfig = await writeGeneratedReleaseConfig();

  if (args.clean) {
    await cleanBundleRoots(args.targets);
  }

  if (args.install) {
    await run("pnpm", ["install", "--frozen-lockfile"]);
  }

  if (!args.skipBuild) {
    const buildTargets = args.targets.length > 0 ? args.targets : [""];

    for (const target of buildTargets) {
      const buildArgs = ["tauri", "build", "--config", releaseConfig];

      if (target) {
        buildArgs.push("--target", target);
      }

      if (bundles.length > 0) {
        buildArgs.push("--bundles", bundles.join(","));
      }

      await runOrFail("pnpm", buildArgs, {
        fallback: shouldUseLinuxDeployFallback(bundles)
          ? () => buildAppImageWithLinuxDeploy(target)
          : null,
      });
    }
  }

  await normalizeBundleArtifactNames(args.targets);

  const artifacts = await collectBundleArtifacts(args.targets, bundles);

  if (artifacts.length === 0) {
    throw new Error("No desktop bundle artifacts were found.");
  }

  for (const artifact of artifacts) {
    console.log(`artifact ${artifact.name} ${artifact.size} bytes`);
  }

  if (!args.upload) {
    await rm(generatedReleaseConfigPath, {force: true});
    return;
  }

  ensureSignatures(artifacts);

  const context = await getReleaseContext();
  const release = await ensureDraftRelease(context, {
    allowPublished: process.env.ALLOW_PUBLISHED_RELEASE_UPLOAD === "1",
  });

  for (const artifact of artifacts) {
    console.log(`upload ${artifact.name}`);
    await uploadAsset(context, release.id, artifact.path, artifact.name);
  }

  await rm(generatedReleaseConfigPath, {force: true});
}

function shouldUseLinuxDeployFallback(bundles) {
  return process.platform === "linux" && bundles.length === 1 && bundles[0] === "appimage";
}

async function buildAppImageWithLinuxDeploy(target) {
  const appImageDir = path.join(bundleRootForTarget(target), "appimage");
  const appDir = path.join(appImageDir, `${appName}.AppDir`);
  const linuxdeploy = path.join(process.env.XDG_CACHE_HOME || path.join(process.env.HOME || "", ".cache"), "tauri", "linuxdeploy-x86_64.AppImage");

  if (!existsSync(appDir)) {
    throw new Error(`Tauri did not create an AppDir at ${appDir}`);
  }

  if (!existsSync(linuxdeploy)) {
    throw new Error(`linuxdeploy was not found at ${linuxdeploy}`);
  }

  await chmod(linuxdeploy, 0o755);
  await run(linuxdeploy, ["--appdir", appDir, "--output", "appimage"], {
    cwd: appImageDir,
    env: {
      ...process.env,
      APPIMAGE_EXTRACT_AND_RUN: "1",
    },
  });

  const packageJson = await loadPackageJson();
  const generated = path.join(appImageDir, `${appName}-x86_64.AppImage`);
  const expected = path.join(appImageDir, `${appName}_${packageJson.version}_amd64.AppImage`);

  if (!existsSync(generated)) {
    throw new Error(`linuxdeploy did not create ${generated}`);
  }

  await rm(expected, {force: true});
  await rename(generated, expected);
  await signArtifact(expected);
}

async function signArtifact(filePath) {
  const args = ["tauri", "signer", "sign", filePath];

  if (process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    args.splice(3, 0, "--private-key-path", process.env.TAURI_SIGNING_PRIVATE_KEY_PATH);
  } else if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
    throw new Error("Missing TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH");
  }

  if (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    args.splice(args.length - 1, 0, "--password", process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD);
  }

  await run("pnpm", args);
}

async function normalizeBundleArtifactNames(targets) {
  const packageJson = await loadPackageJson();
  await normalizeReleaseAssetNames(targets, packageJson.version);

  if (process.platform !== "darwin") {
    return;
  }

  const buildTargets = targets.length > 0 ? targets : [""];

  for (const target of buildTargets) {
    await normalizeMacUpdaterArtifact(target, packageJson.version);
  }
}

async function normalizeMacUpdaterArtifact(target, version) {
  const arch = macArtifactArch(target);
  const macosDir = path.join(bundleRootForTarget(target), "macos");
  const source = path.join(macosDir, `${productName}.app.tar.gz`);
  const destination = path.join(macosDir, `${appName}_${version}_${arch}.app.tar.gz`);

  await renameIfPresent(source, destination);
  await renameIfPresent(`${source}.sig`, `${destination}.sig`);
}

async function normalizeReleaseAssetNames(targets, version) {
  const roots = targets.length > 0 ? targets.map(bundleRootForTarget) : [bundleRootForTarget()];

  for (const root of roots) {
    await renameReleaseAssets(root, version);
  }
}

async function renameReleaseAssets(dir, version) {
  let entries;

  try {
    entries = await readdir(dir, {withFileTypes: true});
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await renameReleaseAssets(fullPath, version);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const normalizedName = normalizedReleaseAssetName(entry.name, version);
    if (!normalizedName || normalizedName === entry.name) {
      continue;
    }

    await renameIfPresent(fullPath, path.join(dir, normalizedName));
  }
}

function normalizedReleaseAssetName(fileName, version) {
  const signatureSuffix = fileName.endsWith(".sig") ? ".sig" : "";
  const baseName = signatureSuffix ? fileName.slice(0, -signatureSuffix.length) : fileName;
  const productNamePrefixes = [
    productName,
    productName.replaceAll(" ", "."),
  ];

  for (const productNamePrefix of productNamePrefixes) {
    const underscoredPrefix = `${productNamePrefix}_${version}_`;
    if (baseName.startsWith(underscoredPrefix)) {
      return `${appName}_${version}_${baseName.slice(underscoredPrefix.length)}${signatureSuffix}`;
    }
  }

  for (const productNamePrefix of productNamePrefixes) {
    const rpmMatch = baseName.match(new RegExp(`^${escapeRegExp(productNamePrefix)}-${escapeRegExp(version)}-\\d+\\.(.+)\\.rpm$`));
    if (rpmMatch) {
      return `${appName}_${version}_${rpmMatch[1]}.rpm${signatureSuffix}`;
    }
  }

  return "";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function macArtifactArch(target) {
  if (target === "aarch64-apple-darwin") {
    return "aarch64";
  }

  if (target === "x86_64-apple-darwin") {
    return "x64";
  }

  if (process.arch === "arm64") {
    return "aarch64";
  }

  if (process.arch === "x64") {
    return "x64";
  }

  return process.arch;
}

async function renameIfPresent(source, destination) {
  if (!existsSync(source) || source === destination) {
    return;
  }

  await rm(destination, {force: true});
  await rename(source, destination);
}

function ensureSignatures(artifacts) {
  const names = new Set(artifacts.map(artifact => artifact.name));
  const missing = artifacts
    .filter(artifact => needsUpdaterSignature(artifact.name))
    .map(artifact => `${artifact.name}.sig`)
    .filter(signatureName => !names.has(signatureName));

  if (missing.length === 0) {
    return;
  }

  throw new Error(`Missing updater signature artifacts: ${missing.join(", ")}`);
}

function needsUpdaterSignature(fileName) {
  return (
    fileName.endsWith(".AppImage")
    || fileName.endsWith(".app.tar.gz")
    || fileName.endsWith(".exe")
    || fileName.endsWith(".msi")
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
