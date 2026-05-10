/**
 * Single source of truth for reading the .app's "host version" — the
 * concrete semver string `zen build:electron` baked into
 * `<bundle>/host.json` from the developer's `package.json#version` at
 * build time. Frozen into the .app so subsequent `git pull`s of the
 * source can't change it.
 *
 * Imported by both:
 *   - `packages/core/src/launcher.ts` (tsdown inlines this into
 *     `dist/launcher.mjs`; the launcher cannot `import "@zenbujs/core"`)
 *   - `packages/core/src/services/updater.ts` (resolved through normal
 *     `@zenbujs/core/...` resolution at runtime)
 *
 * The file lives at the bundle root (`<APP_PATH>/host.json`, where
 * `APP_PATH = app.getAppPath()`), separate from `app-config.json` so
 * its single purpose stays obvious.
 */

import fs from "node:fs";
import path from "node:path";

export const HOST_VERSION_FILENAME = "host.json";

export interface HostVersionFile {
  version: string;
}

export interface ReadHostVersionResult {
  version: string;
  /** Absolute path of the file we read (useful for error messages). */
  path: string;
}

/**
 * Read `<appPath>/host.json` and return its `version` field. Throws an
 * informative error if the file is missing, unreadable, malformed, or
 * the `version` field is missing/empty. Callers in dev mode should
 * check for the file's existence first (or use `tryReadHostVersion`).
 */
export function readHostVersion(appPath: string): ReadHostVersionResult {
  const filePath = path.join(appPath, HOST_VERSION_FILENAME);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new Error(
        `[host-version] missing ${filePath}. ` +
          `Was this .app built with a recent \`zen build:electron\`? ` +
          `The build step is responsible for writing host.json.`,
      );
    }
    throw new Error(
      `[host-version] failed to read ${filePath}: ${e.message ?? String(e)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[host-version] ${filePath} is not valid JSON: ` +
        `${(err as Error).message}`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { version?: unknown }).version !== "string" ||
    (parsed as { version: string }).version.trim().length === 0
  ) {
    throw new Error(
      `[host-version] ${filePath} is missing a non-empty \`version\` string.`,
    );
  }
  return {
    version: (parsed as { version: string }).version.trim(),
    path: filePath,
  };
}

/** Non-throwing variant. Returns `null` when the file is absent or invalid. */
export function tryReadHostVersion(
  appPath: string,
): ReadHostVersionResult | null {
  try {
    return readHostVersion(appPath);
  } catch {
    return null;
  }
}

/** Inverse of `readHostVersion` — used by `zen build:electron`. */
export function writeHostVersion(appPath: string, version: string): string {
  const filePath = path.join(appPath, HOST_VERSION_FILENAME);
  const body: HostVersionFile = { version };
  fs.writeFileSync(filePath, JSON.stringify(body, null, 2) + "\n");
  return filePath;
}
