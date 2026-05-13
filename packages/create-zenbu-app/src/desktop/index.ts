import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureElectronApp } from "./electron-cache.js";
import {
  resolveLauncherSource,
  synthesizeBundle,
} from "./bundle.js";
import { depsSignature, writeDepsSig, type PmSpec } from "./deps-sig.js";
import type { DesktopLogger } from "./log.js";

export interface DesktopRunOpts {
  /** Display name (e.g. "My Notes"). */
  displayName: string;
  /** Slug used for paths and bundle id (e.g. "my-notes"). */
  slug: string;
  /** App version, defaults to the project package.json#version. */
  version: string;
  /** Optional explicit electron version range (default: read from project pkg). */
  electronVersionRange?: string;
  /** Optional icon (.icns or .png) path. */
  iconSource?: string;
  /** Pre-seeded apps dir (e.g. ~/.zenbu/apps/<slug>). */
  appsDir: string;
  /** Package manager that just installed deps in `appsDir`. */
  packageManager: PmSpec;
  /** Override destination (default `/Applications/<DisplayName>.app`). */
  destApp?: string;
  /** Project dir from where to resolve the launcher source (`@zenbujs/core`). */
  resolveFrom: string;
  log: DesktopLogger;
  force?: boolean;
  dryRun?: boolean;
  /** Skip writing `<appsDir>/.zenbu/deps-sig`. Useful when `--no-install`. */
  skipDepsSig?: boolean;
}

export interface DesktopRunResult {
  destApp: string;
  electronVersion: string;
  appsDir: string;
  launchCommand: string;
}

/**
 * Default destination when `destApp` not provided. We prefer `/Applications`
 * but fall back to `~/Applications` when /Applications isn't writable
 * (e.g. without admin rights or on locked-down setups).
 */
function defaultDestApp(displayName: string): string {
  const sysApps = "/Applications";
  try {
    fs.accessSync(sysApps, fs.constants.W_OK);
    return path.join(sysApps, `${displayName}.app`);
  } catch {
    const userApps = path.join(os.homedir(), "Applications");
    return path.join(userApps, `${displayName}.app`);
  }
}

export async function buildDesktopApp(
  opts: DesktopRunOpts,
): Promise<DesktopRunResult> {
  const {
    displayName,
    slug,
    version,
    electronVersionRange,
    iconSource,
    appsDir,
    packageManager,
    resolveFrom,
    log,
    force = false,
    dryRun = false,
    skipDepsSig = false,
  } = opts;
  const destApp = opts.destApp ?? defaultDestApp(displayName);

  const versionRange =
    electronVersionRange ??
    (await readElectronRangeFromAppsDir(appsDir)) ??
    "latest";

  log.info(`displayName=${displayName} slug=${slug} version=${version}`);
  log.info(`appsDir=${appsDir}`);
  log.info(`destApp=${destApp}`);
  log.info(`electronVersionRange=${versionRange}`);

  const cache = await log.withStep(
    `ensure electron cache (${versionRange})`,
    () => ensureElectronApp({ versionRange, log }),
  );

  const launcherSource = resolveLauncherSource(resolveFrom);
  log.info(`launcher source: ${launcherSource}`);

  await synthesizeBundle({
    cachedElectronApp: cache.electronAppPath,
    destApp,
    displayName,
    slug,
    version,
    iconSource,
    packageManager,
    appsDir,
    launcherSource,
    log,
    dryRun,
    force,
  });

  if (!skipDepsSig && !dryRun) {
    await log.withStep(`write <appsDir>/.zenbu/deps-sig`, async () => {
      const sig = await depsSignature({
        appsDir,
        pm: packageManager,
        electronVersion: cache.version,
      });
      await writeDepsSig(appsDir, sig);
      log.info(`deps-sig=${sig.slice(0, 16)}…`);
    });
  } else if (skipDepsSig) {
    log.info(`skipping deps-sig (--no-install or skipDepsSig=true)`);
  }

  return {
    destApp,
    electronVersion: cache.version,
    appsDir,
    launchCommand: `open -a "${destApp}"`,
  };
}

async function readElectronRangeFromAppsDir(
  appsDir: string,
): Promise<string | null> {
  try {
    const raw = await fsp.readFile(path.join(appsDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as {
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const v =
      pkg.devDependencies?.electron ?? pkg.dependencies?.electron ?? null;
    return v;
  } catch {
    return null;
  }
}

export { ensureElectronApp } from "./electron-cache.js";
export { synthesizeBundle, resolveLauncherSource } from "./bundle.js";
export { depsSignature, writeDepsSig } from "./deps-sig.js";
export { prepareIcon } from "./icon.js";
export { createLogger, type DesktopLogger } from "./log.js";
