#!/usr/bin/env node
// create-zenbu-app — scaffold a new Zenbu app from the bundled template.
//
// Run via:
//   npm  create zenbu-app  <dir>
//   pnpm create zenbu-app  <dir>
//   yarn create zenbu-app  <dir>
//   bunx create-zenbu-app  <dir>
//
// Behavior: copy the template, expand `{{projectName}}` in `.tmpl` files,
// rename `_gitignore` -> `.gitignore`, detect which package manager invoked
// us, seed the new `zenbu.config.ts`'s `build.packageManager` block with
// that PM + its installed version, run `<pm> install` for the user, then
// `git init` + initial commit if no `.git` exists.
//
// The auto-install can be opted out with `--no-install`.

import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE_DIR = path.resolve(__dirname, "..", "template")

const argv = process.argv.slice(2)
const flagsSet = new Set(argv.filter((a) => a.startsWith("-")))
const positional = argv.filter((a) => !a.startsWith("-"))
const yes = flagsSet.has("--yes") || flagsSet.has("-y")
const noInstall = flagsSet.has("--no-install")

// Internal/dev-only: when set to an absolute path of a local `@zenbujs/core`
// checkout, the scaffold rewrites `@zenbujs/core` to `link:<path>` before the
// initial git commit. Not advertised to end users.
const ZENBU_LOCAL_CORE = process.env.ZENBU_LOCAL_CORE

// =============================================================================
//                          package manager detection
// =============================================================================

type PmType = "pnpm" | "npm" | "yarn" | "bun"

interface DetectedPm {
  type: PmType
  version: string
  /** True when we fell back to a default (no actual detection succeeded). */
  fallback: boolean
}

/**
 * Detect the PM that invoked `create-zenbu-app`. Order:
 *   1. `process.versions.bun` → bun (covers `bunx create-zenbu-app`).
 *   2. `npm_config_user_agent` → "<pm>/<version> ..." (set by all of npm,
 *      pnpm, yarn classic, yarn berry).
 *   3. Shell out to `<detected-name> --version` if user_agent only carries
 *      the bare name without a parseable version.
 *   4. Fallback to pnpm with a hardcoded sane default.
 */
function detectPackageManager(): DetectedPm {
  if (process.versions.bun) {
    return { type: "bun", version: process.versions.bun, fallback: false }
  }
  const ua = process.env.npm_config_user_agent
  if (ua) {
    const first = ua.split(" ")[0]
    if (first) {
      const slash = first.indexOf("/")
      const name = (slash >= 0 ? first.slice(0, slash) : first).toLowerCase()
      const version = slash >= 0 ? first.slice(slash + 1) : ""
      if (name === "pnpm" || name === "npm" || name === "yarn" || name === "bun") {
        if (version && /^\d/.test(version)) {
          return { type: name, version, fallback: false }
        }
        const probed = probeVersion(name)
        if (probed) return { type: name, version: probed, fallback: false }
      }
    }
  }
  return { type: "pnpm", version: "10.33.0", fallback: true }
}

function probeVersion(pm: PmType): string | null {
  const res = spawnSync(pm, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  if (res.status !== 0) return null
  const out = (res.stdout ?? "").trim()
  // pnpm/npm just print the version. yarn classic prints "1.22.22"; yarn
  // berry prints "4.6.0". bun prints "1.3.12".
  const match = out.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/)
  return match ? match[0] : null
}

// =============================================================================
//                          template rendering helpers
// =============================================================================

function renderTemplate(value: string, projectName: string): string {
  return value.replace(/\{\{projectName\}\}/g, projectName)
}

function copyDirSync(src: string, dest: string, projectName: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destName = entry.name.endsWith(".tmpl")
      ? entry.name.slice(0, -".tmpl".length)
      : entry.name
    const destPath = path.join(dest, destName)
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath, projectName)
    } else {
      const content = fs.readFileSync(srcPath, "utf8")
      fs.writeFileSync(destPath, renderTemplate(content, projectName))
    }
  }
}

/**
 * Replace the `// {{packageManager}}` marker in the scaffolded
 * `zenbu.config.ts` with a real `packageManager: { ... }` line. Idempotent
 * — running this twice yields the same file.
 */
function seedPackageManager(projectDir: string, pm: DetectedPm): void {
  const configPath = path.join(projectDir, "zenbu.config.ts")
  if (!fs.existsSync(configPath)) return
  const original = fs.readFileSync(configPath, "utf8")
  const literal = `packageManager: { type: "${pm.type}", version: "${pm.version}" },`
  const replaced = original.replace(/\/\/\s*\{\{packageManager\}\}/, literal)
  if (replaced !== original) {
    fs.writeFileSync(configPath, replaced)
  }
}

function rewireToLocalCore(projectDir: string, corePath: string): void {
  const pkgPath = path.join(projectDir, "package.json")
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>
  }
  pkg.dependencies = pkg.dependencies ?? {}
  pkg.dependencies["@zenbujs/core"] = `link:${corePath}`
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n")
}

function gitInitWithInitialCommit(projectDir: string): void {
  const initRes = spawnSync("git", ["init", "-b", "main"], {
    cwd: projectDir,
    stdio: "ignore",
  })
  if (initRes.status !== 0) return

  spawnSync("git", ["add", "-A"], { cwd: projectDir, stdio: "ignore" })

  const commitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "create-zenbu-app",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "create-zenbu-app@local",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "create-zenbu-app",
    GIT_COMMITTER_EMAIL:
      process.env.GIT_COMMITTER_EMAIL || "create-zenbu-app@local",
  }
  spawnSync(
    "git",
    ["commit", "-m", "chore: scaffold via create-zenbu-app"],
    { cwd: projectDir, stdio: "ignore", env: commitEnv },
  )
}

/**
 * Run `<pm> install` in the freshly-scaffolded project so the user can go
 * straight to `pnpm dev`/`bun dev`/etc. without the extra step. We run with
 * the user's globally-installed PM (which is what they used to invoke us in
 * the first place), so this won't hit the bundled toolchain — that only
 * matters at the .app's first launch on the consumer's machine.
 */
function runInstall(projectDir: string, pm: DetectedPm): boolean {
  const res = spawnSync(pm.type, ["install"], {
    cwd: projectDir,
    stdio: "inherit",
  })
  return res.status === 0
}

// =============================================================================
//                                    main
// =============================================================================

function main(): void {
  const projectName = positional[0] ?? "."
  if (projectName === "." && !yes) {
    console.error(
      "Usage: npm create zenbu-app <project-name>\n" +
        "       (use --yes to scaffold into the current directory)",
    )
    process.exit(1)
  }

  const projectDir = path.resolve(process.cwd(), projectName)
  const displayName =
    projectName === "." ? path.basename(projectDir) : projectName

  if (fs.existsSync(projectDir)) {
    const entries = fs.readdirSync(projectDir).filter((e) => e !== ".git")
    const allowedExisting =
      projectName === "." &&
      fs.existsSync(path.join(projectDir, "package.json"))
    if (entries.length > 0 && !allowedExisting) {
      console.error(
        `Error: directory "${projectName}" already exists and is not empty.`,
      )
      process.exit(1)
    }
  }

  const pm = detectPackageManager()

  console.log(`\nScaffolding Zenbu app in "${displayName}"...`)
  if (pm.fallback) {
    console.log(
      `  → couldn't detect invoking package manager; defaulting to ${pm.type}@${pm.version}.`,
    )
  } else {
    console.log(`  → detected ${pm.type}@${pm.version} as the invoking package manager`)
  }
  console.log("")

  copyDirSync(TEMPLATE_DIR, projectDir, displayName)

  const gi = path.join(projectDir, "_gitignore")
  if (fs.existsSync(gi)) {
    fs.renameSync(gi, path.join(projectDir, ".gitignore"))
  }

  seedPackageManager(projectDir, pm)

  if (ZENBU_LOCAL_CORE) {
    const corePath = path.resolve(ZENBU_LOCAL_CORE)
    rewireToLocalCore(projectDir, corePath)
    console.log(`  → linked @zenbujs/core -> ${corePath}`)
  }

  let installed = false
  if (!noInstall) {
    console.log(`  → running ${pm.type} install\n`)
    installed = runInstall(projectDir, pm)
    if (!installed) {
      console.warn(
        `  → ${pm.type} install failed; you can retry manually after the scaffold completes.\n`,
      )
    }
  }

  if (!fs.existsSync(path.join(projectDir, ".git"))) {
    gitInitWithInitialCommit(projectDir)
  }

  const cdHint = projectName === "." ? "" : `cd ${displayName} && `
  if (installed) {
    console.log(`Done. Next:\n\n  ${cdHint}${pm.type} dev\n`)
  } else {
    console.log(
      `Done. Next:\n\n  ${cdHint}${pm.type} install\n  ${pm.type} dev\n`,
    )
  }
}

try {
  main()
} catch (err) {
  console.error("\nError:", (err as Error)?.message ?? err)
  process.exit(1)
}
