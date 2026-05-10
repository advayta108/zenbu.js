import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  isYarnBerry,
  provisionToolchain,
  type ProvisionedToolchain,
} from "../src/cli/lib/toolchain"
import type { PackageManagerSpec } from "../src/cli/lib/build-config"

/**
 * End-to-end checks for the package-manager bundling pipeline.
 *
 * For each (PM, version) pair we:
 *   1. Build a one-off sandbox under `os.tmpdir()` containing a fake `HOME`,
 *      isolated XDG dirs, a toolchain download cache, the staging dir, and
 *      a tiny project that pulls in a native dep.
 *   2. Call `provisionToolchain` against the sandboxed cache so binaries
 *      never land in `~/.zenbu/cache/toolchain` on the developer's machine.
 *   3. Run the SAME install command shape the launcher will run at first
 *      launch, with a fully-isolated env (`HOME`, `npm_config_*`,
 *      `PNPM_HOME`, `YARN_CACHE_FOLDER`, `BUN_INSTALL`, ...) plus the
 *      electron-header env vars (`npm_config_runtime`, `npm_config_target`,
 *      `npm_config_disturl`, `npm_config_arch`).
 *   4. Assert the install succeeded AND the native dep landed in
 *      node_modules with a usable `.node` artifact (built or prebuilt).
 *   5. `rm -rf` the sandbox in `afterEach` regardless of pass/fail. The
 *      sandbox stays around when the env var ZENBU_KEEP_PM_SANDBOX is set,
 *      for debugging.
 *
 * These tests are network-dependent and do real installs (~5s per case).
 * They live in core's test suite so a regression in `provisionToolchain`,
 * the launcher's per-PM CLI flag plumbing, or the toolchain.ts URL
 * patterns is caught BEFORE shipping a broken `.app`.
 */

const ELECTRON_TARGET = "33.0.0"
// 33.0.0 chosen because better-sqlite3@^11.5 ships a prebuild for that ABI on
// darwin-arm64/x64, which means the test exercises the electron-headers env
// vars without falling back to a from-source build (which would require
// node-gyp + python + clang on the dev's machine).

const TEST_PACKAGE = {
  name: "better-sqlite3",
  version: "^11.5.0",
}

const MATRIX: ReadonlyArray<{ label: string; spec: PackageManagerSpec }> = [
  { label: "pnpm@10.33.0", spec: { type: "pnpm", version: "10.33.0" } },
  { label: "pnpm@9.15.4", spec: { type: "pnpm", version: "9.15.4" } },
  { label: "pnpm@8.15.9", spec: { type: "pnpm", version: "8.15.9" } },
  { label: "npm@10.9.2", spec: { type: "npm", version: "10.9.2" } },
  { label: "npm@9.9.4", spec: { type: "npm", version: "9.9.4" } },
  { label: "yarn@1.22.22", spec: { type: "yarn", version: "1.22.22" } },
  { label: "yarn@4.6.0", spec: { type: "yarn", version: "4.6.0" } },
  { label: "bun@1.3.12", spec: { type: "bun", version: "1.3.12" } },
]

// =============================================================================
//                              sandbox + cleanup
// =============================================================================

interface Sandbox {
  root: string
  cache: string
  home: string
  xdg: string
  toolchain: string
  project: string
}

async function makeSandbox(label: string): Promise<Sandbox> {
  const root = await fsp.mkdtemp(
    path.join(os.tmpdir(), `zenbu-pm-test-${label.replace(/[^\w.-]/g, "_")}-`),
  )
  const cache = path.join(root, "cache")
  const home = path.join(root, "home")
  const xdg = path.join(root, "xdg")
  const toolchain = path.join(root, "toolchain")
  const project = path.join(root, "project")
  for (const d of [
    cache,
    home,
    xdg,
    toolchain,
    project,
    path.join(xdg, "data"),
    path.join(xdg, "cache"),
    path.join(xdg, "config"),
  ]) {
    await fsp.mkdir(d, { recursive: true })
  }
  return { root, cache, home, xdg, toolchain, project }
}

async function destroySandbox(sandbox: Sandbox): Promise<void> {
  if (process.env.ZENBU_KEEP_PM_SANDBOX) return
  await fsp.rm(sandbox.root, { recursive: true, force: true })
}

// =============================================================================
//                              project + env
// =============================================================================

async function seedProject(
  projectDir: string,
  spec: PackageManagerSpec,
): Promise<void> {
  // pnpm 10 disables build-script execution by default; without an explicit
  // allowlist the better-sqlite3 postinstall (which downloads/builds the
  // native binary) silently no-ops. The other PMs ignore this field so it's
  // safe to write unconditionally.
  const pkg = {
    name: "zenbu-pm-test",
    version: "0.0.0",
    private: true,
    dependencies: { [TEST_PACKAGE.name]: TEST_PACKAGE.version },
    pnpm: { onlyBuiltDependencies: [TEST_PACKAGE.name] },
  }
  await fsp.writeFile(
    path.join(projectDir, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n",
  )

  // Yarn berry defaults to PnP, which requires patched module resolution.
  // For the test we want a regular `node_modules/<dep>/build/Release/...`
  // layout (matches what every other PM produces), so force the
  // node-modules linker via a project-local `.yarnrc.yml`.
  if (spec.type === "yarn" && isYarnBerry(spec.version)) {
    await fsp.writeFile(
      path.join(projectDir, ".yarnrc.yml"),
      "nodeLinker: node-modules\nenableTelemetry: false\n",
    )
  }
}

function buildEnv(sandbox: Sandbox): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
    XDG_DATA_HOME: path.join(sandbox.xdg, "data"),
    XDG_CACHE_HOME: path.join(sandbox.xdg, "cache"),
    XDG_CONFIG_HOME: path.join(sandbox.xdg, "config"),
    npm_config_cache: path.join(sandbox.home, ".npm"),
    npm_config_prefix: path.join(sandbox.home, ".npm-global"),
    npm_config_userconfig: path.join(sandbox.home, ".npmrc"),
    npm_config_globalconfig: path.join(sandbox.home, ".npmrc-global"),
    PNPM_HOME: path.join(sandbox.home, ".pnpm"),
    YARN_CACHE_FOLDER: path.join(sandbox.home, ".yarn-cache"),
    BUN_INSTALL: path.join(sandbox.home, ".bun"),
    CI: "true",
    npm_config_runtime: "electron",
    npm_config_target: ELECTRON_TARGET,
    npm_config_disturl: "https://electronjs.org/headers",
    npm_config_arch: process.arch,
  }
}

// =============================================================================
//                              install dispatch
// =============================================================================

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function spawnP(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8")
    })
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8")
    })
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr + String(err) }))
  })
}

/**
 * Run the install command shape this PM/version ships with from the
 * launcher. Mirrors `runInstall` in `src/launcher.ts` exactly — if the
 * launcher's flags drift from these, this test file should drift with it.
 */
async function runInstallForTest(
  spec: PackageManagerSpec,
  toolchain: ProvisionedToolchain,
  sandbox: Sandbox,
): Promise<RunResult> {
  const env = buildEnv(sandbox)
  const stagingDir = sandbox.toolchain
  const bun = toolchain.bun

  switch (spec.type) {
    case "pnpm": {
      const entry = path.join(stagingDir, "pnpm", "bin", "pnpm.cjs")
      return spawnP(
        bun,
        [entry, "install", "--reporter=append-only"],
        sandbox.project,
        env,
      )
    }
    case "npm": {
      const entry = path.join(stagingDir, "npm", "bin", "npm-cli.js")
      return spawnP(
        bun,
        [entry, "install", "--no-audit", "--no-fund", "--no-progress"],
        sandbox.project,
        env,
      )
    }
    case "yarn": {
      if (isYarnBerry(spec.version)) {
        const entry = path.join(stagingDir, "yarn.cjs")
        return spawnP(bun, [entry, "install"], sandbox.project, {
          ...env,
          YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
        })
      }
      const entry = path.join(stagingDir, "yarn", "bin", "yarn.js")
      // yarn 1.x's response.socket.authorized check chokes under bun (the
      // field isn't populated). A tiny `.yarnrc` with strict-ssl off
      // sidesteps this without weakening the actual TLS handshake. Match
      // the launcher's workaround exactly.
      const rcPath = path.join(sandbox.toolchain, "yarn-classic-bun.yarnrc")
      await fsp.writeFile(rcPath, "strict-ssl false\n")
      return spawnP(
        bun,
        [
          entry,
          "install",
          "--non-interactive",
          "--no-progress",
          "--network-timeout",
          "600000",
          "--use-yarnrc",
          rcPath,
          "--registry",
          "https://registry.npmjs.org/",
        ],
        sandbox.project,
        env,
      )
    }
    case "bun": {
      return spawnP(bun, ["install", "--no-progress"], sandbox.project, env)
    }
  }
}

// =============================================================================
//                                 assertions
// =============================================================================

function walkHasNodeBinary(dir: string): boolean {
  if (!fs.existsSync(dir)) return false
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (walkHasNodeBinary(full)) return true
    } else if (entry.name.endsWith(".node")) {
      return true
    }
  }
  return false
}

function hasNativeArtifact(projectDir: string): boolean {
  const depDir = path.join(projectDir, "node_modules", TEST_PACKAGE.name)
  if (!fs.existsSync(depDir)) return false
  return (
    walkHasNodeBinary(path.join(depDir, "build", "Release")) ||
    walkHasNodeBinary(path.join(depDir, "prebuilds"))
  )
}

// =============================================================================
//                                  the tests
// =============================================================================

describe("package manager bundling end-to-end", () => {
  let activeSandbox: Sandbox | null = null

  beforeAll(() => {
    if (process.platform !== "darwin") {
      console.warn(
        `[package-managers.test] skipping suite: provisionToolchain is darwin-only (got ${process.platform})`,
      )
    }
  })

  afterEach(async () => {
    if (activeSandbox) {
      await destroySandbox(activeSandbox)
      activeSandbox = null
    }
  })

  it.runIf(process.platform === "darwin").each(MATRIX)(
    "$label: provisions, installs, and produces a usable native binary",
    async ({ spec }) => {
      const sandbox = await makeSandbox(`${spec.type}-${spec.version}`)
      activeSandbox = sandbox

      await seedProject(sandbox.project, spec)

      const provisioned = await provisionToolchain(sandbox.toolchain, {
        packageManager: spec,
        cacheRoot: sandbox.cache,
      })

      // Sanity-check the staged toolchain layout matches what the launcher
      // expects to find inside `Resources/toolchain/...`.
      expect(fs.existsSync(provisioned.bun)).toBe(true)
      switch (spec.type) {
        case "pnpm":
          expect(
            fs.existsSync(path.join(sandbox.toolchain, "pnpm", "bin", "pnpm.cjs")),
          ).toBe(true)
          break
        case "npm":
          expect(
            fs.existsSync(path.join(sandbox.toolchain, "npm", "bin", "npm-cli.js")),
          ).toBe(true)
          break
        case "yarn":
          if (isYarnBerry(spec.version)) {
            expect(fs.existsSync(path.join(sandbox.toolchain, "yarn.cjs"))).toBe(true)
          } else {
            expect(
              fs.existsSync(path.join(sandbox.toolchain, "yarn", "bin", "yarn.js")),
            ).toBe(true)
          }
          break
        case "bun":
          // Single-binary collapse: the runtime bun IS the PM bun. Nothing
          // extra to check beyond `provisioned.bun` above.
          break
      }

      const result = await runInstallForTest(spec, provisioned, sandbox)
      if (result.code !== 0) {
        // Surface the install output in the failure message — without it a
        // test failure tells you nothing about WHY the PM exited non-zero.
        throw new Error(
          `${spec.type}@${spec.version} install exited with ${result.code}\n` +
            `--- stdout ---\n${result.stdout}\n` +
            `--- stderr ---\n${result.stderr}`,
        )
      }

      expect(hasNativeArtifact(sandbox.project)).toBe(true)

      // Sandbox HOME should be non-empty: proof the PM actually wrote its
      // cache/state into the sandbox rather than leaking onto the host.
      const homeEntries = fs.readdirSync(sandbox.home)
      expect(homeEntries.length).toBeGreaterThan(0)
    },
  )
})
