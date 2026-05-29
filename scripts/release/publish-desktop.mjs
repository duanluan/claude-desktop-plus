import {
  appName,
  deleteAsset,
  downloadAssetBuffer,
  downloadAssetText,
  ensureDraftRelease,
  getReleaseByTag,
  getReleaseContext,
  githubRequest,
  listReleaseAssets,
  readReleaseNotes,
  releaseAssetUrl,
  sha256Bytes,
  uploadAsset,
  writeTempJson,
  writeTempText,
} from "./shared.mjs";

function parseArgs(argv) {
  const args = {
    draft: false,
    dryRun: false,
    keepSignatures: false,
    platforms: ["linux", "windows", "darwin"],
    yes: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];

    if (item === "--yes") {
      args.yes = true;
      continue;
    }

    if (item === "--draft") {
      args.draft = true;
      continue;
    }

    if (item === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (item === "--keep-signatures") {
      args.keepSignatures = true;
      continue;
    }

    if (item === "--platforms") {
      args.platforms = parsePlatforms(argv[index + 1]);
      index += 1;
      continue;
    }

    if (item.startsWith("--platforms=")) {
      args.platforms = parsePlatforms(item.slice("--platforms=".length));
      continue;
    }

    throw new Error(`Unknown argument: ${item}`);
  }

  return args;
}

function parsePlatforms(value) {
  if (!value) {
    throw new Error("Missing platform list.");
  }

  const aliases = {
    all: ["linux", "windows", "darwin"],
    mac: ["darwin"],
    macos: ["darwin"],
  };
  const platforms = [];

  for (const rawItem of value.split(",")) {
    const item = rawItem.trim().toLowerCase();
    const resolved = aliases[item] || [item];

    for (const platform of resolved) {
      if (!["linux", "windows", "darwin"].includes(platform)) {
        throw new Error(`Unsupported platform: ${platform}`);
      }

      if (!platforms.includes(platform)) {
        platforms.push(platform);
      }
    }
  }

  if (platforms.length === 0) {
    throw new Error("Platform list cannot be empty.");
  }

  return platforms;
}

function findAsset(assets, pattern) {
  return assets.find(asset => pattern.test(asset.name));
}

async function readSignature(assets, asset, key, existingLatest) {
  const signature = assets.find(item => item.name === `${asset.name}.sig`);

  if (signature) {
    return (await downloadAssetText(signature)).trim();
  }

  const existingSignature = existingPlatformSignature(existingLatest, key, asset);
  if (existingSignature) {
    return existingSignature;
  }

  throw new Error(`Missing signature asset for ${asset.name}`);
}

async function addPlatform(platforms, assets, context, key, pattern, existingLatest) {
  const asset = findAsset(assets, pattern);

  if (!asset) {
    return false;
  }

  platforms[key] = {
    signature: await readSignature(assets, asset, key, existingLatest),
    url: releaseAssetUrl(context, asset.name),
  };

  return true;
}

async function createLatestJson(context, assets, notes, selectedPlatforms) {
  const platforms = {};
  const existingLatest = await readExistingLatestJson(assets);

  if (selectedPlatforms.includes("linux")) {
    const linuxAppImage = await addPlatform(platforms, assets, context, "linux-x86_64", releaseAssetPattern(context, "amd64.AppImage"), existingLatest);
    if (!linuxAppImage) {
      throw new Error("Missing Linux updater bundle: expected AppImage.");
    }

    platforms["linux-x86_64-appimage"] = platforms["linux-x86_64"];
  }

  if (selectedPlatforms.includes("windows")) {
    const windowsNsis = await addPlatform(platforms, assets, context, "windows-x86_64", releaseAssetPattern(context, "x64-setup.exe"), existingLatest);
    if (!windowsNsis) {
      throw new Error("Missing updater platform: windows-x86_64");
    }

    platforms["windows-x86_64-nsis"] = platforms["windows-x86_64"];
    await addPlatform(platforms, assets, context, "windows-x86_64-msi", releaseAssetPattern(context, "x64_en-US.msi"), existingLatest);
  }

  if (selectedPlatforms.includes("darwin")) {
    const macArm = await addPlatform(platforms, assets, context, "darwin-aarch64", releaseAssetPattern(context, "aarch64.app.tar.gz"), existingLatest);
    if (!macArm) {
      throw new Error("Missing updater platform: darwin-aarch64");
    }

    platforms["darwin-aarch64-app"] = platforms["darwin-aarch64"];

    const macX64 = await addPlatform(platforms, assets, context, "darwin-x86_64", releaseAssetPattern(context, "x64.app.tar.gz"), existingLatest);
    if (!macX64) {
      throw new Error("Missing updater platform: darwin-x86_64");
    }

    platforms["darwin-x86_64-app"] = platforms["darwin-x86_64"];
  }

  return {
    notes,
    platforms,
    pub_date: new Date().toISOString(),
    version: context.version,
  };
}

async function readExistingLatestJson(assets) {
  const latest = assets.find(asset => asset.name === "latest.json");
  if (!latest) {
    return null;
  }

  try {
    return JSON.parse(await downloadAssetText(latest));
  } catch {
    return null;
  }
}

function existingPlatformSignature(existingLatest, key, asset) {
  const platform = existingLatest?.platforms?.[key];
  if (!platform?.signature || !platform?.url) {
    return "";
  }

  return releaseUrlAssetName(platform.url) === asset.name ? platform.signature : "";
}

function releaseUrlAssetName(url) {
  try {
    const pathname = new URL(url).pathname;
    return decodeURIComponent(pathname.slice(pathname.lastIndexOf("/") + 1));
  } catch {
    const item = String(url).split("/").pop() || "";
    return decodeURIComponent(item);
  }
}

function releaseAssetPattern(context, suffix) {
  return new RegExp(`^${escapeRegExp(appName)}_${escapeRegExp(context.version)}_${escapeRegExp(suffix)}$`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function uploadSha256Sums(context, release) {
  const assets = await listReleaseAssets(context.owner, context.repo, release.id);
  const checksumAssets = assets.filter(asset =>
    !asset.name.endsWith(".sig")
    && asset.name !== "latest.json"
    && asset.name !== "SHA256SUMS"
  );
  const lines = [];

  for (const asset of checksumAssets) {
    const bytes = await downloadAssetBuffer(asset);
    lines.push(`${sha256Bytes(bytes)}  ${asset.name}`);
  }

  const sumsPath = await writeTempText("claude-desktop-plus-release-", "SHA256SUMS", `${lines.sort().join("\n")}\n`);

  console.log("upload SHA256SUMS");
  await uploadAsset(context, release.id, sumsPath, "SHA256SUMS");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.draft && !args.dryRun && !args.yes) {
    throw new Error("Publishing requires --yes. Use --draft to only refresh latest.json.");
  }

  const context = await getReleaseContext();
  const notes = await readReleaseNotes(context.tag);

  if (!args.dryRun) {
    await ensureDraftRelease(context, {
      allowPublished: true,
      body: notes,
    });
  }

  const release = await getReleaseByTag(context.owner, context.repo, context.tag);
  if (!release) {
    throw new Error(`Release ${context.tag} was not found.`);
  }

  const assets = await listReleaseAssets(context.owner, context.repo, release.id);
  const latestJson = await createLatestJson(context, assets, notes, args.platforms);

  if (args.dryRun) {
    console.log(JSON.stringify({
      platforms: Object.keys(latestJson.platforms).sort(),
      release: context.tag,
      version: latestJson.version,
    }, null, 2));
    return;
  }

  const latestJsonPath = await writeTempJson("claude-desktop-plus-release-", "latest.json", latestJson);

  console.log("upload latest.json");
  await uploadAsset(context, release.id, latestJsonPath, "latest.json");
  await uploadSha256Sums(context, release);

  if (args.draft) {
    console.log(`draft refreshed ${context.tag}`);
    return;
  }

  if (!args.keepSignatures) {
    const refreshedAssets = await listReleaseAssets(context.owner, context.repo, release.id);
    const signatures = refreshedAssets.filter(asset => asset.name.endsWith(".sig"));

    for (const signature of signatures) {
      console.log(`delete ${signature.name}`);
      await deleteAsset(context.owner, context.repo, signature.id);
    }
  }

  await githubRequest(`/repos/${context.owner}/${context.repo}/releases/${release.id}`, {
    body: {
      body: notes,
      draft: false,
      name: `${appName} ${context.tag}`,
      prerelease: false,
    },
    method: "PATCH",
  });

  console.log(`published ${context.tag}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
