#!/usr/bin/env node
// create-zenbu-app — scaffold a new Zenbu app from the bundled template.
//
// Run via:
//   npm  create zenbu-app <dir>
//   pnpm create zenbu-app <dir>
//   npx  create-zenbu-app  <dir>
//
// Behavior is intentionally minimal: copy the template, expand `{{projectName}}`
// in `.tmpl` files, rename `_gitignore` -> `.gitignore`, run `git init` +
// initial commit if no `.git` exists, and tell the user to run
// `pnpm install && pnpm dev` themselves.
//
// We do NOT run `pnpm install` (let the user do it with their own pnpm), and
// we do NOT provision any toolchain locally — that work has moved to build
// time (see `zen build:electron` in `@zenbujs/core`).

import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// `template/` ships at the package root (sibling of `dist/`); the published
// `package.json#files` keeps both. From `dist/index.mjs`, that's `..`.
const TEMPLATE_DIR = path.resolve(__dirname, "..", "template")

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith("-")))
const positional = argv.filter((a) => !a.startsWith("-"))
const yes = flags.has("--yes") || flags.has("-y")

// Internal/dev-only: when set to an absolute path of a local `@zenbujs/core`
// checkout, the scaffold rewrites `@zenbujs/core` to `link:<path>` before the
// initial git commit. Not advertised to end users; used by the framework's
// own e2e tests and `init-local.sh`.
const ZENBU_LOCAL_CORE = process.env.ZENBU_LOCAL_CORE

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

  // Ensure the initial commit succeeds even if the user has no global git
  // identity configured. Real commits will use whatever they later set up;
  // this only seeds the bootstrap commit. User-provided env vars win.
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

  console.log(`\nScaffolding Zenbu app in "${displayName}"...\n`)

  copyDirSync(TEMPLATE_DIR, projectDir, displayName)

  const gi = path.join(projectDir, "_gitignore")
  if (fs.existsSync(gi)) {
    fs.renameSync(gi, path.join(projectDir, ".gitignore"))
  }

  if (ZENBU_LOCAL_CORE) {
    const corePath = path.resolve(ZENBU_LOCAL_CORE)
    rewireToLocalCore(projectDir, corePath)
    console.log(`  → linked @zenbujs/core -> ${corePath}`)
  }

  if (!fs.existsSync(path.join(projectDir, ".git"))) {
    gitInitWithInitialCommit(projectDir)
  }

  const cdHint = projectName === "." ? "" : `cd ${displayName} && `
  console.log(`Done. Next:\n\n  ${cdHint}pnpm install\n  pnpm dev\n`)
  console.log(`Note: Zenbu currently requires pnpm 10+.\n`)
}

try {
  main()
} catch (err) {
  console.error("\nError:", (err as Error)?.message ?? err)
  process.exit(1)
}
