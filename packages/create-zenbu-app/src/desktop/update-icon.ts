import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { prepareIcon } from "./icon.js";
import { adhocCodesign, stripQuarantine } from "./bundle.js";
import type { DesktopLogger } from "./log.js";

export interface UpdateBundleIconOpts {
  /** Absolute path to the existing .app bundle. */
  destApp: string;
  /** Source icon, .png (square, ideally 1024x1024) or .icns. */
  iconSource: string;
  /**
   * If true, also poke the macOS icon services so Finder/Dock pick up the
   * new icon without a full re-login. Best-effort.
   */
  refreshIconServices?: boolean;
  log: DesktopLogger;
}

/**
 * Swap an existing bundle's `Contents/Resources/icon.icns`, then re-codesign
 * (ad-hoc, deep) so the bundle stays valid. Optionally nudges Launch
 * Services to re-read the icon.
 */
export async function updateBundleIcon(
  opts: UpdateBundleIconOpts,
): Promise<void> {
  const { destApp, iconSource, log, refreshIconServices = true } = opts;

  if (!fs.existsSync(destApp)) {
    throw new Error(`bundle does not exist: ${destApp}`);
  }
  if (!destApp.endsWith(".app")) {
    throw new Error(`expected an .app bundle, got: ${destApp}`);
  }
  if (!fs.existsSync(iconSource)) {
    throw new Error(`icon source does not exist: ${iconSource}`);
  }

  const iconDest = path.join(destApp, "Contents", "Resources", "icon.icns");
  await log.withStep(`replace icon -> ${iconDest}`, async () => {
    await prepareIcon({ source: iconSource, dest: iconDest, log });
  });

  await adhocCodesign({ destApp, log });
  await stripQuarantine({ destApp, log });

  if (refreshIconServices) {
    await log.withStep(`refresh Launch Services / Dock`, async () => {
      // 1. Bump bundle mtime so Finder notices the change.
      const now = new Date();
      try {
        await fsp.utimes(destApp, now, now);
      } catch (err) {
        log.info(`utimes failed: ${(err as Error).message}`);
      }

      // 2. Re-register the bundle with Launch Services.
      const lsregister =
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
      if (fs.existsSync(lsregister)) {
        const r = spawnSync(lsregister, ["-f", destApp], {
          stdio: "pipe",
          encoding: "utf8",
        });
        if (r.status !== 0) {
          log.info(`lsregister exit=${r.status} ${r.stderr?.trim() ?? ""}`);
        }
      }

      // 3. Clear icon cache for this user (best-effort, harmless if missing).
      const iconSvcCache = path.join(os.homedir(), "Library", "Caches", "com.apple.iconservices.store");
      try {
        if (fs.existsSync(iconSvcCache)) {
          await fsp.rm(iconSvcCache, { force: true });
        }
      } catch {}

      // 4. Restart the Dock so the new icon is shown immediately for any
      //    pinned/recent entries.
      spawnSync("killall", ["Dock"], { stdio: "ignore" });
      spawnSync("killall", ["Finder"], { stdio: "ignore" });
    });
  }
}
