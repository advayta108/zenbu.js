import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { prepareIcon } from "./icon.js";
import type { DesktopLogger } from "./log.js";
import type { PmSpec } from "./deps-sig.js";

export interface SynthesizeBundleOpts {
  /** Cached vanilla Electron.app to clone-copy from. */
  cachedElectronApp: string;
  /** Final installed bundle path (e.g. `/Applications/<Name>.app`). */
  destApp: string;
  /** Display name shown in Finder, dock, menu bar. */
  displayName: string;
  /** Slug used for `CFBundleIdentifier` and `app-config.name`. */
  slug: string;
  /** App version (matches user project package.json#version). */
  version: string;
  /** Bundle id, defaults to `dev.zenbu.<slug>`. */
  bundleId?: string;
  /** Optional user icon (.icns or .png). When omitted, keep electron.icns. */
  iconSource?: string;
  /** Package manager that pre-seeded `<appsDir>/node_modules`. */
  packageManager: PmSpec;
  /** Pre-seeded apps dir (`~/.zenbu/apps/<slug>`). */
  appsDir: string;
  /** Path to `@zenbujs/core/dist/launcher.mjs` to bake into the bundle. */
  launcherSource: string;
  log: DesktopLogger;
  dryRun?: boolean;
  force?: boolean;
}

export interface AppConfig {
  name: string;
  packageManager: PmSpec;
  version: string;
  local: true;
}

interface PlistOp {
  /** Plist key path (PlistBuddy syntax: `:Foo:Bar`). */
  key: string;
  /** plutil type: string, bool, integer, dict, etc. */
  type: "string" | "bool" | "integer";
  value: string | boolean | number;
}

const ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
`;

export async function synthesizeBundle(
  opts: SynthesizeBundleOpts,
): Promise<void> {
  const {
    cachedElectronApp,
    destApp,
    displayName,
    slug,
    version,
    bundleId = `dev.zenbu.${slug}`,
    iconSource,
    packageManager,
    appsDir,
    launcherSource,
    log,
    dryRun = false,
    force = false,
  } = opts;

  if (!fs.existsSync(cachedElectronApp)) {
    throw new Error(
      `cached Electron.app missing: ${cachedElectronApp}. Did the cache step fail?`,
    );
  }

  if (fs.existsSync(destApp)) {
    if (!force) {
      throw new Error(
        `${destApp} already exists. Re-run with --force to overwrite.`,
      );
    }
    if (dryRun) {
      log.info(`[dry-run] would rm -rf ${destApp}`);
    } else {
      log.info(`removing existing ${destApp}`);
      await fsp.rm(destApp, { recursive: true, force: true });
    }
  }

  await ensureParentDir(destApp, dryRun, log);

  await log.withStep(`clone-copy ${cachedElectronApp} -> ${destApp}`, async () => {
    if (dryRun) return;
    cloneCopy(cachedElectronApp, destApp, log);
  });

  const macosDir = path.join(destApp, "Contents", "MacOS");
  const oldExe = path.join(macosDir, "Electron");
  const newExe = path.join(macosDir, displayName);
  await log.withStep(`rename executable -> ${displayName}`, async () => {
    if (dryRun) return;
    if (fs.existsSync(oldExe)) {
      await fsp.rename(oldExe, newExe);
    } else if (!fs.existsSync(newExe)) {
      throw new Error(
        `expected ${oldExe} or ${newExe} to exist after clone-copy`,
      );
    }
  });

  const infoPlist = path.join(destApp, "Contents", "Info.plist");
  await log.withStep(`patch Info.plist`, async () => {
    if (dryRun) return;
    const ops: PlistOp[] = [
      { key: "CFBundleName", type: "string", value: displayName },
      { key: "CFBundleDisplayName", type: "string", value: displayName },
      { key: "CFBundleExecutable", type: "string", value: displayName },
      { key: "CFBundleIdentifier", type: "string", value: bundleId },
      { key: "CFBundleIconFile", type: "string", value: "icon.icns" },
      { key: "CFBundleVersion", type: "string", value: version },
      { key: "CFBundleShortVersionString", type: "string", value: version },
      { key: "NSHighResolutionCapable", type: "bool", value: true },
      { key: "LSMinimumSystemVersion", type: "string", value: "12.0" },
      { key: "NSSupportsAutomaticGraphicsSwitching", type: "bool", value: true },
      { key: "NSRequiresAquaSystemAppearance", type: "bool", value: false },
      { key: "NSPrincipalClass", type: "string", value: "AtomApplication" },
    ];
    for (const op of ops) {
      plutilReplace(infoPlist, op, log);
    }
    // Strip the integrity table for default_app.asar — once we drop our
    // `app/` folder the default asar is never loaded, but stripping the
    // entry side-steps any future Electron version that eagerly verifies.
    plutilRemove(infoPlist, ":ElectronAsarIntegrity", log);
  });

  const resourcesDir = path.join(destApp, "Contents", "Resources");
  const iconDest = path.join(resourcesDir, "icon.icns");
  await log.withStep(`install icon -> ${iconDest}`, async () => {
    if (dryRun) return;
    if (iconSource) {
      await prepareIcon({ source: iconSource, dest: iconDest, log });
    } else {
      const fallback = path.join(resourcesDir, "electron.icns");
      if (fs.existsSync(fallback)) {
        await fsp.copyFile(fallback, iconDest);
      } else {
        log.info(`no icon source and no electron.icns fallback; skipping`);
      }
    }
  });

  const bundleAppDir = path.join(resourcesDir, "app");
  await log.withStep(`write Resources/app/{package.json,launcher.mjs,app-config.json,host.json}`, async () => {
    if (dryRun) return;
    await fsp.mkdir(bundleAppDir, { recursive: true });

    const bundlePkg = {
      name: slug,
      version,
      main: "launcher.mjs",
      type: "module",
    };
    await fsp.writeFile(
      path.join(bundleAppDir, "package.json"),
      JSON.stringify(bundlePkg, null, 2) + "\n",
    );

    if (!fs.existsSync(launcherSource)) {
      throw new Error(`launcher source missing: ${launcherSource}`);
    }
    await fsp.copyFile(
      launcherSource,
      path.join(bundleAppDir, "launcher.mjs"),
    );

    const appConfig: AppConfig = {
      name: slug,
      packageManager,
      version,
      local: true,
    };
    await fsp.writeFile(
      path.join(bundleAppDir, "app-config.json"),
      JSON.stringify(appConfig, null, 2) + "\n",
    );

    await fsp.writeFile(
      path.join(bundleAppDir, "host.json"),
      JSON.stringify({ version }, null, 2) + "\n",
    );

    log.info(`appsDir baked into name = ${slug} (resolves to ${appsDir})`);
  });

  const entitlementsPath = path.join(
    os.tmpdir(),
    `czda-entitlements-${process.pid}-${Date.now()}.plist`,
  );
  await log.withStep(`ad-hoc codesign --deep`, async () => {
    if (dryRun) return;
    await fsp.writeFile(entitlementsPath, ENTITLEMENTS);
    try {
      const r = spawnSync(
        "codesign",
        [
          "--force",
          "--deep",
          "--sign",
          "-",
          "--entitlements",
          entitlementsPath,
          destApp,
        ],
        { stdio: "pipe", encoding: "utf8" },
      );
      if (r.status !== 0) {
        throw new Error(
          `codesign failed (${r.status}): ${r.stderr?.slice(0, 1000) ?? ""}`,
        );
      }
      log.info(r.stderr?.trim() || "codesign ok");
    } finally {
      await fsp.unlink(entitlementsPath).catch(() => {});
    }
  });

  await log.withStep(`xattr -dr com.apple.quarantine`, async () => {
    if (dryRun) return;
    spawnSync("xattr", ["-dr", "com.apple.quarantine", destApp], {
      stdio: "ignore",
    });
  });

  await log.withStep(`verify (codesign + plutil)`, async () => {
    if (dryRun) return;
    const cs = spawnSync(
      "codesign",
      ["--verify", "--deep", "--strict", destApp],
      { stdio: "pipe", encoding: "utf8" },
    );
    if (cs.status !== 0) {
      throw new Error(
        `codesign verify failed (${cs.status}): ${cs.stderr?.slice(0, 1000) ?? ""}`,
      );
    }
    const pl = spawnSync("plutil", ["-lint", infoPlist], {
      stdio: "pipe",
      encoding: "utf8",
    });
    if (pl.status !== 0) {
      throw new Error(
        `plutil -lint failed (${pl.status}): ${pl.stderr?.slice(0, 500) ?? ""} ${pl.stdout?.slice(0, 500) ?? ""}`,
      );
    }
  });
}

function cloneCopy(src: string, dest: string, log: DesktopLogger): void {
  // `cp -c` on APFS uses copy-on-write (clonefile); falls back gracefully
  // on non-APFS volumes when -c isn't supported.
  const r = spawnSync("cp", ["-c", "-R", src, dest], {
    stdio: "pipe",
    encoding: "utf8",
  });
  if (r.status === 0) return;
  log.info(`cp -c failed, falling back to cp -R: ${r.stderr?.trim() ?? ""}`);
  const r2 = spawnSync("cp", ["-R", src, dest], {
    stdio: "pipe",
    encoding: "utf8",
  });
  if (r2.status !== 0) {
    throw new Error(
      `cp failed (${r2.status}): ${r2.stderr?.slice(0, 1000) ?? ""}`,
    );
  }
}

async function ensureParentDir(
  destApp: string,
  dryRun: boolean,
  log: DesktopLogger,
): Promise<void> {
  const parent = path.dirname(destApp);
  if (fs.existsSync(parent)) return;
  if (dryRun) {
    log.info(`[dry-run] would mkdir -p ${parent}`);
    return;
  }
  await fsp.mkdir(parent, { recursive: true });
}

function plutilReplace(
  infoPlist: string,
  op: PlistOp,
  log: DesktopLogger,
): void {
  // plutil -replace fails if the key doesn't exist. Try replace first, on
  // failure insert.
  const value = String(op.value);
  const replace = spawnSync(
    "plutil",
    ["-replace", op.key, `-${op.type}`, value, infoPlist],
    { stdio: "pipe", encoding: "utf8" },
  );
  if (replace.status === 0) return;
  const insert = spawnSync(
    "plutil",
    ["-insert", op.key, `-${op.type}`, value, infoPlist],
    { stdio: "pipe", encoding: "utf8" },
  );
  if (insert.status !== 0) {
    throw new Error(
      `plutil -insert ${op.key} failed (${insert.status}): ${insert.stderr?.slice(0, 500) ?? ""}`,
    );
  }
  log.info(`plutil inserted ${op.key}=${value}`);
}

function plutilRemove(
  infoPlist: string,
  keyPath: string,
  log: DesktopLogger,
): void {
  const r = spawnSync("plutil", ["-remove", keyPath, infoPlist], {
    stdio: "pipe",
    encoding: "utf8",
  });
  if (r.status === 0) {
    log.info(`plutil removed ${keyPath}`);
    return;
  }
  // Missing key isn't an error for our purposes.
  log.info(`plutil -remove ${keyPath}: ${r.stderr?.trim() ?? "(no key)"}`);
}

/**
 * Resolve the path to `@zenbujs/core/dist/launcher.mjs` from any cwd. We
 * use `package.json` as the resolution anchor because that subpath is
 * exported (see packages/core/package.json `exports`).
 */
export function resolveLauncherSource(fromDir: string): string {
  const req = createRequire(path.join(fromDir, "noop.js"));
  let pkgPath: string;
  try {
    pkgPath = req.resolve("@zenbujs/core/package.json");
  } catch (err) {
    throw new Error(
      `failed to resolve @zenbujs/core from ${fromDir}: ${(err as Error).message}. ` +
        `Make sure create-zenbu-app's dependency on @zenbujs/core is installed.`,
    );
  }
  const launcher = path.join(path.dirname(pkgPath), "dist", "launcher.mjs");
  if (!fs.existsSync(launcher)) {
    throw new Error(
      `@zenbujs/core launcher not found at ${launcher}. The package may be a stub or unbuilt.`,
    );
  }
  return launcher;
}
