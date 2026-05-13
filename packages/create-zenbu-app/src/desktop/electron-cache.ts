import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { spawnSync } from "node:child_process";
import type { DesktopLogger } from "./log.js";

/**
 * Layout under `~/.zenbu/electron/`:
 *
 *   versions/<major>/<exact-version>/Electron.app
 *   versions/<major>/.current        -> "<exact-version>" (text marker)
 *   .locks/<major>.lock              -> flock target during download
 *   .downloads/<exact>.zip           -> intermediate, deleted on success
 */
const ROOT = path.join(os.homedir(), ".zenbu", "electron");

export interface EnsureElectronAppOpts {
  /**
   * Either an exact version (`"42.1.3"`) or a semver-range string
   * (`"^42.0.0"`). When a range, we resolve the latest published version
   * matching the range from the npm registry.
   */
  versionRange: string;
  log: DesktopLogger;
  /** Override download URL prefix (for testing). */
  downloadBase?: string;
}

export interface EnsureElectronAppResult {
  electronAppPath: string;
  version: string;
  major: number;
}

export async function ensureElectronApp(
  opts: EnsureElectronAppOpts,
): Promise<EnsureElectronAppResult> {
  const { log } = opts;
  const exact = await resolveExactVersion(opts.versionRange, log);
  const major = parseInt(exact.split(".")[0]!, 10);
  if (!Number.isFinite(major)) {
    throw new Error(`failed to parse major from electron version "${exact}"`);
  }

  const versionDir = path.join(ROOT, "versions", String(major), exact);
  const electronAppPath = path.join(versionDir, "Electron.app");

  if (fs.existsSync(path.join(electronAppPath, "Contents", "MacOS"))) {
    log.info(`cache hit: ${electronAppPath}`);
    return { electronAppPath, version: exact, major };
  }

  await fsp.mkdir(path.join(ROOT, ".locks"), { recursive: true });
  await fsp.mkdir(path.join(ROOT, ".downloads"), { recursive: true });
  const lockFile = path.join(ROOT, ".locks", `${major}-${exact}.lock`);

  await withLock(lockFile, async () => {
    if (fs.existsSync(path.join(electronAppPath, "Contents", "MacOS"))) {
      log.info(`cache hit (post-lock): ${electronAppPath}`);
      return;
    }
    await downloadAndExtract({
      version: exact,
      versionDir,
      log,
      downloadBase: opts.downloadBase,
    });
  });

  if (!fs.existsSync(path.join(electronAppPath, "Contents", "MacOS"))) {
    throw new Error(
      `electron cache install failed: ${electronAppPath} missing after extract`,
    );
  }

  return { electronAppPath, version: exact, major };
}

interface DownloadOpts {
  version: string;
  versionDir: string;
  log: DesktopLogger;
  downloadBase?: string;
}

async function downloadAndExtract(opts: DownloadOpts): Promise<void> {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const filename = `electron-v${opts.version}-darwin-${arch}.zip`;
  const url =
    (opts.downloadBase ??
      "https://github.com/electron/electron/releases/download") +
    `/v${opts.version}/${filename}`;
  const zipPath = path.join(ROOT, ".downloads", filename);

  opts.log.info(`downloading ${url}`);
  await downloadFile(url, zipPath, opts.log);

  await fsp.mkdir(opts.versionDir, { recursive: true });
  opts.log.info(`extracting -> ${opts.versionDir}`);
  // `ditto` is the canonical macOS unzip tool; preserves resource forks +
  // symlinks inside the framework. `-x -k` = extract, pkzip format.
  const r = spawnSync("ditto", ["-x", "-k", zipPath, opts.versionDir], {
    stdio: "pipe",
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(
      `ditto failed (${r.status}): ${r.stderr?.slice(0, 1000) ?? ""}`,
    );
  }
  await fsp.unlink(zipPath).catch(() => {});
}

async function downloadFile(
  url: string,
  dest: string,
  log: DesktopLogger,
  redirectsLeft = 5,
): Promise<void> {
  const tmp = `${dest}.part`;
  const downloaded = await new Promise<boolean>((resolve, reject) => {
    const req = https.get(url, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`download ${url}: too many redirects`));
          return;
        }
        downloadFile(res.headers.location, dest, log, redirectsLeft - 1).then(
          () => resolve(false),
          reject,
        );
        return;
      }
      if (code !== 200) {
        res.resume();
        reject(new Error(`download ${url} -> HTTP ${code}`));
        return;
      }
      const total = parseInt(
        (res.headers["content-length"] as string) ?? "0",
        10,
      );
      let received = 0;
      let lastPct = -1;
      const file = fs.createWriteStream(tmp);
      res.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (total > 0) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPct && pct % 10 === 0) {
            log.info(`  ${pct}% (${received}/${total})`);
            lastPct = pct;
          }
        }
      });
      res.pipe(file);
      file.on("finish", () => {
        file.close((err) => (err ? reject(err) : resolve(true)));
      });
      file.on("error", reject);
    });
    req.on("error", reject);
  });
  if (downloaded) {
    await fsp.rename(tmp, dest);
  }
}

async function withLock<T>(
  lockFile: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Best-effort cross-process lock via O_EXCL. If acquired by another
  // process, poll for release with a 5-min ceiling.
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      try {
        return await fn();
      } finally {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(lockFile);
        } catch {}
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") throw err;
      // Stale lock cleanup: if older than 10 minutes, remove and retry.
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > 10 * 60_000) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {}
      await sleep(500);
    }
  }
  throw new Error(`timed out waiting for ${lockFile}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface RegistryDoc {
  versions: Record<string, unknown>;
  "dist-tags"?: Record<string, string>;
}

let registryCache: Promise<RegistryDoc> | null = null;

async function fetchRegistry(): Promise<RegistryDoc> {
  if (registryCache) return registryCache;
  registryCache = new Promise<RegistryDoc>((resolve, reject) => {
    https
      .get(
        "https://registry.npmjs.org/electron",
        { headers: { accept: "application/vnd.npm.install-v1+json" } },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`registry HTTP ${res.statusCode}`));
            return;
          }
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (body += c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(body) as RegistryDoc);
            } catch (err) {
              reject(err);
            }
          });
          res.on("error", reject);
        },
      )
      .on("error", reject);
  });
  return registryCache;
}

/**
 * Accepts an exact version, a caret range, or a bare major. Returns the
 * latest published electron version that satisfies it. Pure HTTP — no npm
 * CLI invocation.
 */
async function resolveExactVersion(
  range: string,
  log: DesktopLogger,
): Promise<string> {
  const trimmed = range.trim();

  // Exact match: x.y.z
  if (/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(trimmed)) {
    return trimmed;
  }

  log.info(`resolving electron ${trimmed} from registry`);
  const doc = await fetchRegistry();
  const all = Object.keys(doc.versions ?? {});

  // Bare major: "42"
  if (/^\d+$/.test(trimmed)) {
    const major = parseInt(trimmed, 10);
    return pickLatestStableMajor(all, major, trimmed);
  }

  // Caret: "^42.0.0" or "^42"
  const caret = trimmed.match(/^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (caret) {
    const major = parseInt(caret[1]!, 10);
    return pickLatestStableMajor(all, major, trimmed);
  }

  // Tilde: "~42.1.0"
  const tilde = trimmed.match(/^~(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (tilde) {
    const major = parseInt(tilde[1]!, 10);
    const minor = parseInt(tilde[2]!, 10);
    const matching = all.filter((v) => {
      const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-|$)/);
      if (!m) return false;
      return parseInt(m[1]!, 10) === major && parseInt(m[2]!, 10) === minor;
    });
    return pickHighest(matching, trimmed);
  }

  // "latest" dist tag
  if (trimmed === "latest") {
    const latest = doc["dist-tags"]?.latest;
    if (!latest) throw new Error("registry has no `latest` dist-tag");
    return latest;
  }

  throw new Error(
    `unsupported electron version spec: "${trimmed}". Use an exact version, "^MAJOR", "~MAJOR.MINOR", a bare major, or "latest".`,
  );
}

function pickLatestStableMajor(
  all: string[],
  major: number,
  raw: string,
): string {
  const stable = all.filter((v) => {
    const m = v.match(/^(\d+)\.\d+\.\d+$/);
    return m !== null && parseInt(m[1]!, 10) === major;
  });
  return pickHighest(stable, raw);
}

function pickHighest(versions: string[], raw: string): string {
  if (versions.length === 0) {
    throw new Error(`no electron version matched "${raw}"`);
  }
  const sorted = versions.sort(compareSemver);
  return sorted[sorted.length - 1]!;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}
