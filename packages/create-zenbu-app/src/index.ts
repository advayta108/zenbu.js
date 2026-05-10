#!/usr/bin/env node
// create-zenbu-app — scaffold a new Zenbu app from a bundled template.
//
// Run via:
//   npm  create zenbu-app  [dir]
//   pnpm create zenbu-app  [dir]
//   yarn create zenbu-app  [dir]
//   bunx create-zenbu-app  [dir]
//
// Behavior: pick a template variant (e.g. with/without Tailwind) either via
// interactive prompts or `--yes` (take defaults), copy the template, expand
// `{{projectName}}` in `.tmpl` files, rename `_gitignore` -> `.gitignore`,
// detect which package manager invoked us, seed the new `zenbu.config.ts`'s
// `build.packageManager` block with that PM + its installed version, run
// `<pm> install` for the user, then `git init` + initial commit if no
// `.git` exists.
//
// Flags:
//   --yes / -y    Accept the default for every prompt (project = cwd, all
//                 config options at their declared default).
//   --no-install  Skip the post-copy install step.

import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import * as p from "@clack/prompts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR = path.resolve(__dirname, "..", "templates")

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
//                              config options
// =============================================================================
//
// Each entry describes one user-facing scaffolding choice. To add a new
// option:
//   1. Append a `ConfigOption` to `CONFIG_OPTIONS`.
//   2. Add the corresponding template copies under `templates/<slug>/`.
//
// `--yes` short-circuits every `ask()` and uses the declared `default`.

interface ConfigOption<T> {
  id: string
  default: T
  ask: () => Promise<T | symbol>
  /** Contributes a fragment (or `null`) to the resolved template slug. */
  slug: (value: T) => string | null
}

const CONFIG_OPTIONS: ConfigOption<boolean>[] = [
  {
    id: "tailwind",
    default: true,
    ask: () =>
      p.confirm({ message: "Use Tailwind CSS?", initialValue: true }) as Promise<
        boolean | symbol
      >,
    slug: (v) => (v ? "tailwind" : null),
  },
]

interface ResolvedAnswers {
  [optionId: string]: unknown
}

function resolveSlug(answers: ResolvedAnswers): string {
  const parts: string[] = []
  for (const opt of CONFIG_OPTIONS) {
    const value = answers[opt.id] as never
    const fragment = opt.slug(value)
    if (fragment) parts.push(fragment)
  }
  return parts.length > 0 ? parts.join("-") : "vanilla"
}

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

/**
 * Run `<pm> run link` so the scaffold's typegen output (under `types/`) is
 * present before the initial git commit. Without this, the user's first
 * `pnpm dev` would generate those files and leave the working tree dirty.
 */
function runLink(projectDir: string, pm: DetectedPm): boolean {
  const res = spawnSync(pm.type, ["run", "link"], {
    cwd: projectDir,
    stdio: "inherit",
  })
  return res.status === 0
}

// =============================================================================
//                              prompts
// =============================================================================

function bail(reason: string): never {
  p.cancel(reason)
  process.exit(1)
}

function validateProjectName(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim()
  if (!trimmed) return "Project name is required."
  if (trimmed === ".") return undefined
  if (/[\\/]/.test(trimmed)) return "Project name cannot contain slashes."
  if (/\s/.test(trimmed)) return "Project name cannot contain whitespace."
  // Mirror npm's rough rules: lowercase-friendly, no leading dot/underscore.
  if (/^[._]/.test(trimmed)) return "Project name cannot start with '.' or '_'."
  return undefined
}

async function promptProjectName(): Promise<string> {
  const result = await p.text({
    message: "Project name?",
    placeholder: "my-zenbu-app",
    defaultValue: "my-zenbu-app",
    validate: validateProjectName,
  })
  if (p.isCancel(result)) bail("Scaffolding cancelled.")
  return result as string
}

async function promptOptions(): Promise<ResolvedAnswers> {
  const answers: ResolvedAnswers = {}
  for (const opt of CONFIG_OPTIONS) {
    const value = await opt.ask()
    if (p.isCancel(value)) bail("Scaffolding cancelled.")
    answers[opt.id] = value
  }
  return answers
}

function defaultAnswers(): ResolvedAnswers {
  const answers: ResolvedAnswers = {}
  for (const opt of CONFIG_OPTIONS) {
    answers[opt.id] = opt.default
  }
  return answers
}

// =============================================================================
//                                    main
// =============================================================================

async function main(): Promise<void> {
  p.intro("create-zenbu-app")

  let projectName: string
  if (positional[0]) {
    projectName = positional[0]
  } else if (yes) {
    projectName = "."
  } else {
    projectName = await promptProjectName()
  }

  const projectDir = path.resolve(process.cwd(), projectName)
  // Always use the basename for templated `{{projectName}}` substitution so
  // path-style args like `/tmp/foo` don't leak `/` into `package.json#name`
  // (which npm rejects) or the electron-builder appId.
  const displayName = path.basename(projectDir)

  if (fs.existsSync(projectDir)) {
    const entries = fs.readdirSync(projectDir).filter((e) => e !== ".git")
    const isDot = projectName === "." || projectDir === process.cwd()
    const allowedExisting =
      isDot && fs.existsSync(path.join(projectDir, "package.json"))
    if (entries.length > 0 && !allowedExisting) {
      bail(`Directory "${projectName}" already exists and is not empty.`)
    }
  }

  const answers = yes ? defaultAnswers() : await promptOptions()
  const slug = resolveSlug(answers)
  const templateDir = path.join(TEMPLATES_DIR, slug)
  if (!fs.existsSync(templateDir)) {
    bail(`No template found for configuration "${slug}".`)
  }

  const pm = detectPackageManager()

  p.log.step(`Scaffolding Zenbu app in "${displayName}" (template: ${slug})`)
  if (pm.fallback) {
    p.log.info(
      `couldn't detect invoking package manager; defaulting to ${pm.type}@${pm.version}.`,
    )
  } else {
    p.log.info(`detected ${pm.type}@${pm.version} as the invoking package manager`)
  }

  copyDirSync(templateDir, projectDir, displayName)

  const gi = path.join(projectDir, "_gitignore")
  if (fs.existsSync(gi)) {
    fs.renameSync(gi, path.join(projectDir, ".gitignore"))
  }

  seedPackageManager(projectDir, pm)

  if (ZENBU_LOCAL_CORE) {
    const corePath = path.resolve(ZENBU_LOCAL_CORE)
    rewireToLocalCore(projectDir, corePath)
    p.log.info(`linked @zenbujs/core -> ${corePath}`)
  }

  let installed = false
  if (!noInstall) {
    p.log.step(`running ${pm.type} install`)
    installed = runInstall(projectDir, pm)
    if (!installed) {
      p.log.warn(
        `${pm.type} install failed; you can retry manually after the scaffold completes.`,
      )
    }
  }

  // Run `<pm> run link` after install so the generated `types/` files (which
  // are tracked, not gitignored) land in the initial commit. Skipping when
  // install failed since link needs deps resolved.
  if (installed) {
    p.log.step(`running ${pm.type} run link`)
    const linked = runLink(projectDir, pm)
    if (!linked) {
      p.log.warn(
        `${pm.type} run link failed; you can retry manually after the scaffold completes.`,
      )
    }
  }

  if (!fs.existsSync(path.join(projectDir, ".git"))) {
    gitInitWithInitialCommit(projectDir)
  }

  const cdHint = projectName === "." ? "" : `cd ${displayName} && `
  const next = installed
    ? `${cdHint}${pm.type} dev`
    : `${cdHint}${pm.type} install\n  ${cdHint}${pm.type} dev`
  p.outro(`Done. Next:\n\n  ${next}\n`)
}

main().catch((err) => {
  console.error("\nError:", (err as Error)?.message ?? err)
  process.exit(1)
})
