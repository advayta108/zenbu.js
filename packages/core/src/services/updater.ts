/**
 * Atomic, thin wrappers over `isomorphic-git` plus a single `install()`
 * primitive over `runInstall`. Each public method is one underlying
 * call; callers compose update flows themselves.
 *
 * `getAppContext()` is a read-only convenience that surfaces the
 * running .app's `app-config.json` + `host.json` so callers don't have
 * to re-parse them. It returns `null` in dev or when the bundle is
 * missing those files.
 */

import { app } from "electron"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as git from "isomorphic-git"
import type {
  FetchResult,
  ReadCommitResult,
  StatusRow,
} from "isomorphic-git"
import http from "isomorphic-git/http/node"

import { Service, runtime } from "../runtime"
import { createLogger } from "../shared/log"
import { tryReadHostVersion } from "../shared/host-version"
import {
  type PackageManagerSpec,
  depsSignature,
  readDepsSig,
  runInstall,
  writeDepsSig,
} from "../shared/pm-install"

const log = createLogger("updater")

const LEGACY_PACKAGE_MANAGER: PackageManagerSpec = {
  type: "pnpm",
  version: "10.33.0",
}

interface AppConfigJson {
  name: string
  mirrorUrl?: string
  branch?: string
  version?: string
  packageManager?: PackageManagerSpec
}

export interface AppContext {
  appsDir: string
  resourcesPath: string
  mirror: { url: string; branch: string }
  packageManager: PackageManagerSpec
  hostVersion: string
  appName: string
}

function isBundleMode(): boolean {
  return process.env.ZENBU_LAUNCHED_FROM_BUNDLE === "1"
}

function readAppConfig(appPath: string): AppConfigJson | null {
  const configPath = path.join(appPath, "app-config.json")
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as AppConfigJson
  } catch {
    return null
  }
}

function appsDirFor(name: string): string {
  if (process.env.ZENBU_APPS_DIR) return path.resolve(process.env.ZENBU_APPS_DIR)
  return path.join(os.homedir(), ".zenbu", "apps", name)
}

export class UpdaterService extends Service.create({ key: "updater" }) {
  evaluate(): void {
    log.verbose(
      `updater service ready (mode=${isBundleMode() ? "bundle" : "dev"})`,
    )
  }

  // ---------------------------------------------------------------------------
  // Read-only context
  // ---------------------------------------------------------------------------

  /**
   * Snapshot of the running .app's mirror + toolchain. Returns `null`
   * in dev (no bundle) or when `app-config.json` / `host.json` are
   * missing. No side effects.
   */
  async getAppContext(): Promise<AppContext | null> {
    if (!isBundleMode()) return null
    const appPath = app.getAppPath()
    const cfg = readAppConfig(appPath)
    if (!cfg || !cfg.mirrorUrl) return null
    const host = tryReadHostVersion(appPath)
    if (!host) return null
    return {
      appsDir: appsDirFor(cfg.name),
      resourcesPath: path.dirname(appPath),
      mirror: { url: cfg.mirrorUrl, branch: cfg.branch ?? "main" },
      packageManager: cfg.packageManager ?? LEGACY_PACKAGE_MANAGER,
      hostVersion: host.version,
      appName: cfg.name,
    }
  }

  // ---------------------------------------------------------------------------
  // Git wrappers (one underlying isomorphic-git call each)
  // ---------------------------------------------------------------------------

  async fetch(opts: {
    dir: string
    url: string
    ref?: string
    remote?: string
    depth?: number
    singleBranch?: boolean
    tags?: boolean
  }): Promise<FetchResult> {
    return git.fetch({ fs, http, ...opts })
  }

  async clone(opts: {
    dir: string
    url: string
    ref?: string
    depth?: number
    singleBranch?: boolean
  }): Promise<void> {
    await git.clone({ fs, http, ...opts })
  }

  async checkout(opts: {
    dir: string
    ref: string
    force?: boolean
  }): Promise<void> {
    await git.checkout({ fs, ...opts })
  }

  async resolveRef(opts: { dir: string; ref: string }): Promise<string> {
    return git.resolveRef({ fs, ...opts })
  }

  async statusMatrix(opts: {
    dir: string
    filepaths?: string[]
  }): Promise<StatusRow[]> {
    return git.statusMatrix({ fs, ...opts })
  }

  async log(opts: {
    dir: string
    ref?: string
    depth?: number
  }): Promise<ReadCommitResult[]> {
    return git.log({ fs, ...opts })
  }

  // ---------------------------------------------------------------------------
  // Install primitive
  // ---------------------------------------------------------------------------

  /**
   * Run `<pm> install` in `dir` using the bundled toolchain at
   * `resourcesPath`. Always runs; no signature gating. Compose with
   * `getDepsSignature` / `readDepsSignature` / `writeDepsSignature`
   * if you want a skip-when-clean gate.
   */
  async install(opts: {
    dir: string
    pm: PackageManagerSpec
    resourcesPath: string
  }): Promise<void> {
    await runInstall({
      appsDir: opts.dir,
      resourcesPath: opts.resourcesPath,
      pm: opts.pm,
    })
  }

  // ---------------------------------------------------------------------------
  // Deps signature helpers (composable gate primitives)
  // ---------------------------------------------------------------------------

  async getDepsSignature(opts: {
    dir: string
    pm: PackageManagerSpec
  }): Promise<string> {
    return depsSignature(opts.dir, opts.pm)
  }

  async readDepsSignature(opts: { dir: string }): Promise<string | null> {
    return readDepsSig(opts.dir)
  }

  async writeDepsSignature(opts: {
    dir: string
    sig: string
  }): Promise<void> {
    await writeDepsSig(opts.dir, opts.sig)
  }
}

runtime.register(UpdaterService, import.meta)
