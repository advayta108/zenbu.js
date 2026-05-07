import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const internalDir = path.join(os.homedir(), ".zenbu", ".internal");
const pathsJson = path.join(internalDir, "paths.json");

function userCacheRoot(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches");
  }
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  }
  return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
}

function computePaths() {
  const cacheRoot = path.join(userCacheRoot(), "Zenbu");
  const binDir = path.join(cacheRoot, "bin");
  return {
    cacheRoot,
    binDir,
    bunInstall: path.join(cacheRoot, "bun"),
    bunPath: path.join(binDir, "bun"),
    pnpmHome: path.join(cacheRoot, "pnpm"),
    pnpmPath: path.join(binDir, "pnpm"),
    gitPath: path.join(binDir, "git"),
    writtenAt: Date.now(),
  };
}

export function bootstrapEnv() {
  const paths = computePaths();

  try {
    fs.mkdirSync(paths.binDir, { recursive: true });
  } catch {}

  const toolchainReady =
    fs.existsSync(paths.bunPath) && fs.existsSync(paths.pnpmPath);

  if (toolchainReady) {
    process.env.BUN_INSTALL ??= paths.bunInstall;
    process.env.PNPM_HOME ??= paths.pnpmHome;
  }

  const pathParts = toolchainReady
    ? [paths.binDir, process.env.PATH ?? ""]
    : [process.env.PATH ?? ""];
  const seen = new Set<string>();
  process.env.PATH = pathParts
    .flatMap((part) => part.split(path.delimiter))
    .filter((part) => {
      if (!part || seen.has(part)) return false;
      seen.add(part);
      return true;
    })
    .join(path.delimiter);

  try {
    fs.mkdirSync(internalDir, { recursive: true });
    fs.writeFileSync(pathsJson, JSON.stringify(paths, null, 2));
  } catch {}

  return { paths, needsToolchainDownload: !toolchainReady };
}
