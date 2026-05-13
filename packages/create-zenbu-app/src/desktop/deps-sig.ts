import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export type PmType = "pnpm" | "npm" | "yarn" | "bun";

export interface PmSpec {
  type: PmType;
  version: string;
}

export function lockfileFor(type: PmType): string {
  switch (type) {
    case "pnpm":
      return "pnpm-lock.yaml";
    case "npm":
      return "package-lock.json";
    case "yarn":
      return "yarn.lock";
    case "bun":
      return "bun.lock";
  }
}

/**
 * Mirror of `packages/core/src/shared/pm-install.ts#depsSignature`, with
 * `electronVersion` accepted explicitly because we run from Node (not
 * Electron) and `process.versions.electron` is undefined here.
 *
 * Must stay byte-for-byte equivalent to the launcher's recipe so the
 * pre-seeded `<appsDir>/.zenbu/deps-sig` matches what `ensureDepsInstalled`
 * recomputes on first launch and the install gate skips.
 */
export async function depsSignature(opts: {
  appsDir: string;
  pm: PmSpec;
  electronVersion: string;
  arch?: NodeJS.Architecture;
  platform?: NodeJS.Platform;
}): Promise<string> {
  const hash = crypto.createHash("sha256");
  await fileHash(hash, path.join(opts.appsDir, "package.json"));
  await fileHash(hash, path.join(opts.appsDir, lockfileFor(opts.pm.type)));
  hash.update(`${opts.pm.type}@${opts.pm.version}`);
  hash.update("\0");
  hash.update(opts.electronVersion);
  hash.update("\0");
  hash.update(opts.platform ?? process.platform);
  hash.update("\0");
  hash.update(opts.arch ?? process.arch);
  return hash.digest("hex");
}

async function fileHash(hash: crypto.Hash, filePath: string): Promise<void> {
  hash.update(filePath);
  hash.update("\0");
  try {
    hash.update(await fsp.readFile(filePath));
  } catch {}
  hash.update("\0");
}

export async function writeDepsSig(
  appsDir: string,
  sig: string,
): Promise<void> {
  const sigPath = path.join(appsDir, ".zenbu", "deps-sig");
  await fsp.mkdir(path.dirname(sigPath), { recursive: true });
  await fsp.writeFile(sigPath, sig);
}

export function depsSigPath(appsDir: string): string {
  return path.join(appsDir, ".zenbu", "deps-sig");
}

export function readDepsSigSync(appsDir: string): string | null {
  try {
    return fs.readFileSync(depsSigPath(appsDir), "utf8");
  } catch {
    return null;
  }
}
