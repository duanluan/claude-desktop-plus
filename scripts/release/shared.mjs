import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

export const appName = "claude-desktop-plus";
export const productName = "Claude Desktop Plus";
export const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const tauriDir = path.join(repoRoot, "src-tauri");
export const releaseConfigPath = path.join(tauriDir, "tauri.release.conf.json");
export const generatedReleaseConfigPath = path.join(tauriDir, "tauri.release.generated.conf.json");
export const updaterPubkeyPath = path.join(tauriDir, "updater.pubkey");
export const releaseRepository = "duanluan/claude-desktop-plus";

let cachedGitHubToken = "";

export async function loadPackageJson() {
  return JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
}

export async function getReleaseContext() {
  const packageJson = await loadPackageJson();
  const version = packageJson.version;
  const tag = process.env.RELEASE_TAG || process.env.CM_TAG || `v${version}`;
  const repository = process.env.RELEASE_REPO || process.env.CLAUDE_DESKTOP_PLUS_RELEASE_REPO || releaseRepository;
  const [owner, repo] = repository.split("/");

  if (!owner || !repo) {
    throw new Error(`Invalid release repository: ${repository}`);
  }

  if (tag !== `v${version}` && process.env.ALLOW_RELEASE_TAG_MISMATCH !== "1") {
    throw new Error(`Release tag ${tag} does not match package.json version v${version}`);
  }

  return {
    owner,
    packageJson,
    repo,
    repository,
    tag,
    version,
  };
}

export function getGitHubToken() {
  const token = process.env.CLAUDE_DESKTOP_PLUS_RELEASE_TOKEN
    || process.env.GH_TOKEN
    || process.env.GITHUB_TOKEN
    || getGitHubCliToken();

  if (!token) {
    throw new Error("Missing CLAUDE_DESKTOP_PLUS_RELEASE_TOKEN, GH_TOKEN, or GITHUB_TOKEN");
  }

  return token;
}

function getGitHubCliToken() {
  if (cachedGitHubToken) {
    return cachedGitHubToken;
  }

  const result = spawnSync("gh", ["auth", "token"], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return "";
  }

  cachedGitHubToken = result.stdout.trim();
  return cachedGitHubToken;
}

export async function readReleaseNotes(tag) {
  const notesPath = path.join(repoRoot, ".github", "release-notes", `${tag}.md`);

  try {
    return await readFile(notesPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Release notes not found: ${path.relative(repoRoot, notesPath)}`);
    }

    throw error;
  }
}

export async function githubRequest(requestPath, options = {}) {
  const token = getGitHubToken();
  const url = requestPath.startsWith("http") ? requestPath : `https://api.github.com${requestPath}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    ...options.headers,
  };

  let body = options.body;
  const isWebStream = typeof ReadableStream !== "undefined" && body instanceof ReadableStream;
  if (body && typeof body === "object" && !Buffer.isBuffer(body) && !(body instanceof ArrayBuffer) && !isWebStream) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }

  let response;
  let lastError;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      response = await fetch(url, {
        ...options,
        body,
        headers,
      });
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 5) {
        await sleep(attempt * 1000);
      }
    }
  }

  if (!response) {
    throw new Error(`GitHub API ${options.method || "GET"} ${url} failed: ${lastError?.message || lastError}`);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${options.method || "GET"} ${url} failed with ${response.status}: ${text}`);
  }

  if (response.status === 204) {
    return null;
  }

  if (headers.Accept === "application/octet-stream") {
    return response.text();
  }

  return response.json();
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

export async function getReleaseByTag(owner, repo, tag) {
  const releaseName = `${appName} ${tag}`;
  const exactMatches = [];
  const draftNameMatches = [];

  for (let page = 1; page <= 10; page += 1) {
    const releases = await githubRequest(`/repos/${owner}/${repo}/releases?per_page=100&page=${page}`);

    for (const release of releases) {
      if (release.tag_name === tag) {
        exactMatches.push(release);
        continue;
      }

      if (release.draft && release.name === releaseName) {
        draftNameMatches.push(release);
      }
    }

    if (releases.length < 100) {
      return selectRelease([...exactMatches, ...draftNameMatches]);
    }
  }

  throw new Error(`Release lookup exceeded page limit for ${tag}`);
}

function selectRelease(releases) {
  if (releases.length === 0) {
    return null;
  }

  return releases.toSorted((left, right) => {
    const assetDelta = (right.assets || []).length - (left.assets || []).length;
    if (assetDelta !== 0) {
      return assetDelta;
    }

    return new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
  })[0];
}

export async function ensureDraftRelease(context, options = {}) {
  const name = options.name || `${appName} ${context.tag}`;
  const body = options.body ?? await readReleaseNotes(context.tag);
  const existing = await getReleaseByTag(context.owner, context.repo, context.tag);

  if (existing) {
    if (!existing.draft && !options.allowPublished) {
      throw new Error(`Release ${context.tag} is already public. Set ALLOW_PUBLISHED_RELEASE_UPLOAD=1 to change it.`);
    }

    return githubRequest(`/repos/${context.owner}/${context.repo}/releases/${existing.id}`, {
      body: {
        body,
        draft: existing.draft,
        name,
        prerelease: false,
        tag_name: context.tag,
        target_commitish: process.env.RELEASE_COMMITISH || "main",
      },
      method: "PATCH",
    });
  }

  return githubRequest(`/repos/${context.owner}/${context.repo}/releases`, {
    body: {
      body,
      draft: true,
      name,
      prerelease: false,
      tag_name: context.tag,
      target_commitish: process.env.RELEASE_COMMITISH || "main",
    },
    method: "POST",
  });
}

export async function listReleaseAssets(owner, repo, releaseId) {
  const assets = [];

  for (let page = 1; page <= 10; page += 1) {
    const items = await githubRequest(`/repos/${owner}/${repo}/releases/${releaseId}/assets?per_page=100&page=${page}`);
    assets.push(...items);

    if (items.length < 100) {
      return assets;
    }
  }

  throw new Error(`Asset lookup exceeded page limit for release ${releaseId}`);
}

export async function deleteAsset(owner, repo, assetId) {
  await githubRequest(`/repos/${owner}/${repo}/releases/assets/${assetId}`, {
    method: "DELETE",
  });
}

export function contentTypeForAsset(fileName) {
  if (fileName.endsWith(".json")) {
    return "application/json";
  }
  if (fileName.endsWith(".AppImage")) {
    return "application/octet-stream";
  }
  if (fileName.endsWith(".deb")) {
    return "application/vnd.debian.binary-package";
  }
  if (fileName.endsWith(".rpm")) {
    return "application/x-rpm";
  }
  if (fileName.endsWith(".dmg")) {
    return "application/x-apple-diskimage";
  }
  if (fileName.endsWith(".msi")) {
    return "application/x-msi";
  }
  if (fileName.endsWith(".exe")) {
    return "application/vnd.microsoft.portable-executable";
  }
  if (fileName.endsWith(".tar.gz")) {
    return "application/gzip";
  }
  if (fileName === "SHA256SUMS" || fileName.endsWith(".sha256")) {
    return "text/plain";
  }

  return "application/octet-stream";
}

export async function uploadAsset(context, releaseId, filePath, assetName = path.basename(filePath)) {
  const assets = await listReleaseAssets(context.owner, context.repo, releaseId);
  const existing = assets.find(asset => asset.name === assetName);

  if (existing) {
    await deleteAsset(context.owner, context.repo, existing.id);
  }

  const fileBuffer = await readFile(filePath);
  const uploadUrl = `https://uploads.github.com/repos/${context.owner}/${context.repo}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`;

  return githubRequest(uploadUrl, {
    body: fileBuffer,
    headers: {
      "Content-Length": String(fileBuffer.length),
      "Content-Type": contentTypeForAsset(assetName),
    },
    method: "POST",
  });
}

export async function downloadAssetText(asset) {
  return githubRequest(asset.url, {
    headers: {
      Accept: "application/octet-stream",
    },
  });
}

export async function downloadAssetBuffer(asset) {
  const token = getGitHubToken();
  const response = await fetch(asset.url, {
    headers: {
      Accept: "application/octet-stream",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub asset download failed with ${response.status}: ${text}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function releaseAssetUrl(context, assetName) {
  return `https://github.com/${context.owner}/${context.repo}/releases/download/${context.tag}/${encodeURIComponent(assetName)}`;
}

export async function writeTempJson(prefix, fileName, payload) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  const filePath = path.join(dir, fileName);
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  return filePath;
}

export async function writeTempText(prefix, fileName, text) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  const filePath = path.join(dir, fileName);
  await writeFile(filePath, text);
  return filePath;
}

export async function writeGeneratedReleaseConfig() {
  const pubkey = await resolveUpdaterPubkey();
  if (!pubkey) {
    throw new Error("Missing updater public key. Set TAURI_UPDATER_PUBKEY or commit src-tauri/updater.pubkey.");
  }

  const base = JSON.parse(await readFile(releaseConfigPath, "utf8"));
  const generated = {
    ...base,
    bundle: {
      createUpdaterArtifacts: true,
    },
    plugins: {
      ...(base.plugins || {}),
      updater: {
        pubkey,
        endpoints: [
          "https://github.com/duanluan/claude-desktop-plus/releases/latest/download/latest.json",
        ],
        windows: {
          installMode: "passive",
        },
      },
    },
  };

  await writeFile(generatedReleaseConfigPath, `${JSON.stringify(generated, null, 2)}\n`);
  return generatedReleaseConfigPath;
}

export async function resolveUpdaterPubkey() {
  const envPubkey = process.env.TAURI_UPDATER_PUBKEY?.trim();
  if (envPubkey) {
    return normalizeUpdaterPubkey(envPubkey);
  }

  try {
    return normalizeUpdaterPubkey(await readFile(updaterPubkeyPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

export function normalizeUpdaterPubkey(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const compact = trimmed.replace(/\s+/g, "");
  if (decodeWrappedPubkey(compact)) {
    return compact;
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const comment = lines.find(line => line.startsWith("untrusted comment:")) || "untrusted comment: minisign public key";
  const key = lines.find(line => line && !line.startsWith("untrusted comment:"));

  if (!key || !isBase64Like(key)) {
    return "";
  }

  return Buffer.from(`${comment}\n${key}\n`, "utf8").toString("base64");
}

function decodeWrappedPubkey(value) {
  if (!isBase64Like(value)) {
    return "";
  }

  const decoded = Buffer.from(value, "base64").toString("utf8");
  if (decoded.includes("\uFFFD")) {
    return "";
  }

  const lines = decoded
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  return lines.some(line => line.startsWith("untrusted comment:"))
    && lines.some(line => line && !line.startsWith("untrusted comment:"))
    ? decoded
    : "";
}

function isBase64Like(value) {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0;
}

export function bundleRootForTarget(target) {
  const cargoTargetDir = process.env.CARGO_TARGET_DIR ? path.resolve(repoRoot, process.env.CARGO_TARGET_DIR) : "";

  if (cargoTargetDir) {
    if (target) {
      return path.join(cargoTargetDir, target, "release", "bundle");
    }

    return path.join(cargoTargetDir, "release", "bundle");
  }

  if (target) {
    return path.join(tauriDir, "target", target, "release", "bundle");
  }

  return path.join(tauriDir, "target", "release", "bundle");
}

export async function cleanBundleRoots(targets) {
  const roots = targets.length > 0 ? targets.map(bundleRootForTarget) : [bundleRootForTarget()];

  for (const root of roots) {
    await rm(root, {force: true, recursive: true});
  }
}

export async function collectBundleArtifacts(targets, bundles = []) {
  const roots = targets.length > 0 ? targets.map(bundleRootForTarget) : [bundleRootForTarget()];
  const artifacts = [];
  const names = new Set();
  const allowedSuffixes = bundleSuffixes(bundles);

  for (const root of roots) {
    await collectFiles(root, artifacts, allowedSuffixes);
  }

  for (const artifact of artifacts) {
    if (names.has(artifact.name)) {
      throw new Error(`Duplicate release asset name found: ${artifact.name}`);
    }

    names.add(artifact.name);
  }

  return artifacts.sort((left, right) => left.name.localeCompare(right.name));
}

function bundleSuffixes(bundles) {
  if (bundles.length === 0) {
    return null;
  }

  const suffixes = new Set();

  for (const bundle of bundles) {
    switch (bundle) {
      case "appimage":
        suffixes.add(".AppImage");
        suffixes.add(".AppImage.sig");
        break;
      case "app":
        suffixes.add(".app.tar.gz");
        suffixes.add(".app.tar.gz.sig");
        break;
      case "deb":
        suffixes.add(".deb");
        suffixes.add(".deb.sig");
        break;
      case "dmg":
        suffixes.add(".dmg");
        suffixes.add(".dmg.sig");
        break;
      case "msi":
        suffixes.add(".msi");
        suffixes.add(".msi.sig");
        break;
      case "nsis":
        suffixes.add(".exe");
        suffixes.add(".exe.sig");
        break;
      case "rpm":
        suffixes.add(".rpm");
        suffixes.add(".rpm.sig");
        break;
      default:
        throw new Error(`Unsupported bundle target: ${bundle}`);
    }
  }

  return suffixes;
}

async function collectFiles(dir, artifacts, allowedSuffixes) {
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
      await collectFiles(fullPath, artifacts, allowedSuffixes);
      continue;
    }

    if (!entry.isFile() || !isReleaseAsset(entry.name, allowedSuffixes)) {
      continue;
    }

    artifacts.push({
      name: entry.name,
      path: fullPath,
      size: (await stat(fullPath)).size,
    });
  }
}

function isReleaseAsset(fileName, allowedSuffixes) {
  const suffixes = allowedSuffixes ?? [
    ".AppImage",
    ".deb",
    ".dmg",
    ".exe",
    ".msi",
    ".rpm",
    ".sig",
    ".tar.gz",
  ];

  return [...suffixes].some(suffix => fileName.endsWith(suffix));
}
