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
//   --yes / -y           Accept the default for every prompt (project = cwd,
//                        all config options at their declared default).
//   --no-install         Skip the post-copy install step.
//   --no-git             Skip the git init prompt entirely. Git init is also
//                        auto-skipped when an ancestor of the scaffold dir
//                        already has a `.git/` directory.
//   --plugin             Scaffold a plugin (not an app). Picks the plugin
//                        template, skips app-only prompts (Tailwind), and
//                        skips build-config seeding.
//   --depends-on NAME=PATH
//                        (Plugin mode only.) Declare a type-time dependency
//                        on another plugin. Repeatable. `NAME` is the
//                        upstream plugin's `name`. `PATH` points at either
//                        a `zenbu.plugin.ts` (single plugin) or a
//                        `zenbu.config.ts` (where `NAME` disambiguates).
//   --no-add-to-host     Skip the prompt that offers to append the new
//                        plugin to each upstream host's `plugins:[]` array.

import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import * as p from "@clack/prompts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR = path.resolve(__dirname, "..", "templates")

interface DependsOn {
  name: string
  /** Absolute path to the upstream's zenbu.plugin.ts or zenbu.config.ts. */
  from: string
}

const rawArgv = process.argv.slice(2)
const flagsSet = new Set<string>()
const positional: string[] = []
const dependsOn: DependsOn[] = []

/**
 * Parse flags. `--depends-on NAME=PATH` is consumed positionally because it
 * carries a value; everything else is a boolean flag or a positional arg.
 */
for (let i = 0; i < rawArgv.length; i++) {
  const arg = rawArgv[i]!
  if (arg === "--depends-on" || arg === "--dependsOn") {
    const value = rawArgv[++i]
    if (!value) {
      console.error("create-zenbu-app: --depends-on requires NAME=PATH")
      process.exit(1)
    }
    dependsOn.push(parseDependsOn(value))
  } else if (arg.startsWith("--depends-on=") || arg.startsWith("--dependsOn=")) {
    dependsOn.push(parseDependsOn(arg.slice(arg.indexOf("=") + 1)))
  } else if (arg.startsWith("-")) {
    flagsSet.add(arg)
  } else {
    positional.push(arg)
  }
}

const yes = flagsSet.has("--yes") || flagsSet.has("-y")
const noInstall = flagsSet.has("--no-install")
const noGit = flagsSet.has("--no-git")
const pluginMode = flagsSet.has("--plugin")
const noAddToHost = flagsSet.has("--no-add-to-host")

if (dependsOn.length > 0 && !pluginMode) {
  console.error("create-zenbu-app: --depends-on is only valid with --plugin")
  process.exit(1)
}

function parseDependsOn(raw: string): DependsOn {
  const eq = raw.indexOf("=")
  if (eq < 0) {
    console.error(
      `create-zenbu-app: --depends-on must be of the form NAME=PATH (got "${raw}")`,
    )
    process.exit(1)
  }
  const name = raw.slice(0, eq).trim()
  const rel = raw.slice(eq + 1).trim()
  if (!name) {
    console.error("create-zenbu-app: --depends-on NAME may not be empty")
    process.exit(1)
  }
  if (!rel) {
    console.error("create-zenbu-app: --depends-on PATH may not be empty")
    process.exit(1)
  }
  const abs = path.isAbsolute(rel) ? rel : path.resolve(process.cwd(), rel)
  if (!fs.existsSync(abs)) {
    console.error(`create-zenbu-app: --depends-on path does not exist: ${abs}`)
    process.exit(1)
  }
  return { name, from: abs }
}

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

type TemplateCtx = Record<string, string>

function renderTemplate(value: string, ctx: TemplateCtx): string {
  return value.replace(/\{\{(\w+)\}\}/g, (full, key: string) => {
    return Object.prototype.hasOwnProperty.call(ctx, key) ? ctx[key]! : full
  })
}

/**
 * Copy a template directory tree to `dest`. Both file *contents* and
 * file/directory *names* go through `renderTemplate`, so a template can
 * place a file at e.g. `src/main/services/{{projectName}}.ts.tmpl` and have
 * it land at `src/main/services/<projectName>.ts`. `.tmpl` is stripped.
 */
function copyDirSync(src: string, dest: string, ctx: TemplateCtx): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    let destName = entry.name.endsWith(".tmpl")
      ? entry.name.slice(0, -".tmpl".length)
      : entry.name
    destName = renderTemplate(destName, ctx)
    const destPath = path.join(dest, destName)
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath, ctx)
    } else {
      const content = fs.readFileSync(srcPath, "utf8")
      fs.writeFileSync(destPath, renderTemplate(content, ctx))
    }
  }
}

function toPascalCase(s: string): string {
  return s
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")
}

function relPosix(fromDir: string, toFile: string): string {
  let r = path.relative(fromDir, toFile).split(path.sep).join("/")
  if (!r.startsWith(".")) r = "./" + r
  return r
}

/**
 * Render a plugin's `dependsOn` literal for the scaffolded `zenbu.plugin.ts`.
 * Returns either an empty string (no deps → field omitted) or a leading-`\n`
 * fragment that slots in after the `services:` line, e.g.
 *
 *   \n  dependsOn: [\n    { name: "app", from: "../../zenbu.config.ts" },\n  ],
 *
 * Each `from` is rewritten relative to `pluginDir` so the generated file is
 * stable across moves of the surrounding workspace.
 */
function renderDependsOn(pluginDir: string, deps: DependsOn[]): string {
  if (deps.length === 0) return ""
  const lines: string[] = []
  lines.push("")
  lines.push("  dependsOn: [")
  for (const d of deps) {
    const fromRel = relPosix(pluginDir, d.from)
    lines.push(`    { name: ${JSON.stringify(d.name)}, from: ${JSON.stringify(fromRel)} },`)
  }
  lines.push("  ],")
  return lines.join("\n")
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

/**
 * Pin `@zenbujs/core` to a local checkout. For apps the dep lives in
 * `dependencies`; for plugins it's in `devDependencies` (plugins peer on
 * core).
 */
function rewireToLocalCore(
  projectDir: string,
  corePath: string,
  isPlugin: boolean,
): void {
  const pkgPath = path.join(projectDir, "package.json")
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const bucket = isPlugin ? "devDependencies" : "dependencies"
  pkg[bucket] = pkg[bucket] ?? {}
  pkg[bucket]["@zenbujs/core"] = `link:${corePath}`
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n")
}

/** Walk upward from `fromDir` looking for an ancestor with a `.git` dir. */
function findGitRoot(fromDir: string): string | null {
  let dir = path.resolve(fromDir)
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
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

// =============================================================================
//                       Host zenbu.config.ts mutation
// =============================================================================

/**
 * Append a path-form plugin entry to the host's `plugins: [ ... ]` array.
 * Idempotent — if the entry is already there, returns "already-present" and
 * doesn't rewrite. Returns "unsafe-shape" when the file's `plugins: [...]`
 * doesn't look like the scaffolded shape (spread syntax, missing array, etc.)
 * — caller logs a warning and prints the entry to add manually.
 */
type HostEditResult = "added" | "already-present" | "unsafe-shape" | "missing-file"

function appendPluginToHostConfig(
  hostConfigPath: string,
  entry: string,
): HostEditResult {
  if (!fs.existsSync(hostConfigPath)) return "missing-file"
  const raw = fs.readFileSync(hostConfigPath, "utf8")
  // Find `plugins:` followed by `[`. We tolerate whitespace and a comment
  // between them.
  const pluginsMatch = raw.match(/\bplugins\s*:\s*\[/)
  if (!pluginsMatch) return "unsafe-shape"
  const openIdx = pluginsMatch.index! + pluginsMatch[0].length - 1
  // Walk balanced brackets to find the matching `]`. Skips over strings and
  // single-line + block comments so we don't get tricked by `]` inside them.
  let depth = 1
  let i = openIdx + 1
  while (i < raw.length && depth > 0) {
    const ch = raw[i]!
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch
      i++
      while (i < raw.length && raw[i] !== quote) {
        if (raw[i] === "\\") i++
        i++
      }
      i++
      continue
    }
    if (ch === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++
      continue
    }
    if (ch === "/" && raw[i + 1] === "*") {
      i += 2
      while (i < raw.length - 1 && !(raw[i] === "*" && raw[i + 1] === "/")) i++
      i += 2
      continue
    }
    if (ch === "[") depth++
    else if (ch === "]") depth--
    i++
  }
  if (depth !== 0) return "unsafe-shape"
  const closeIdx = i - 1
  const arrayBody = raw.slice(openIdx + 1, closeIdx)
  if (/\.\.\./.test(arrayBody)) return "unsafe-shape"
  // Already present (string match against the literal we'd add)?
  if (arrayBody.includes(JSON.stringify(entry))) return "already-present"
  // Determine indent for the new line: take the indent of the first non-empty
  // line inside the array, or default to two spaces of project + plugins indent.
  const lines = arrayBody.split("\n")
  let indent = "    "
  for (const line of lines) {
    if (line.trim().length === 0) continue
    const m = line.match(/^[ \t]+/)
    if (m) {
      indent = m[0]
      break
    }
  }
  // Find the closing `]`'s line indent so the appended item lines up.
  const beforeClose = raw.slice(0, closeIdx)
  const lastLineStart = beforeClose.lastIndexOf("\n") + 1
  const closeLineIndent = beforeClose.slice(lastLineStart).match(/^[ \t]*/)![0]
  // Slice in: keep everything up to (and including) the last item / opening
  // bracket, then add the new line, then the rest.
  // We append directly before the closing `]`. If the last visible content
  // before `]` doesn't end with a comma, add one.
  let head = raw.slice(0, closeIdx).replace(/\s*$/, "")
  if (head.length > 0 && !head.endsWith(",") && !head.endsWith("[")) {
    head += ","
  }
  const insertion = `\n${indent}${JSON.stringify(entry)},\n${closeLineIndent}`
  const next = head + insertion + raw.slice(closeIdx)
  if (next === raw) return "already-present"
  fs.writeFileSync(hostConfigPath, next)
  return "added"
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

/** Run `<pm> exec zen link [extraArgs...]` in `cwd`. */
function runZenLink(
  cwd: string,
  pm: DetectedPm,
  extraArgs: string[] = [],
): boolean {
  const args = ["exec", "zen", "link", ...extraArgs]
  // yarn classic uses different exec semantics; bun/pnpm/npm all support
  // `exec` to run a local binary. For yarn classic we fall back to direct
  // `yarn zen link` which yarn rewrites to the bin lookup.
  const cmd =
    pm.type === "yarn" && pm.version.startsWith("1.") ? pm.type : pm.type
  const finalArgs =
    pm.type === "yarn" && pm.version.startsWith("1.")
      ? ["zen", "link", ...extraArgs]
      : args
  const res = spawnSync(cmd, finalArgs, { cwd, stdio: "inherit" })
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
  p.intro(pluginMode ? "create-zenbu-app (plugin)" : "create-zenbu-app")

  let projectName: string
  if (positional[0]) {
    projectName = positional[0]
  } else if (yes) {
    projectName = "."
  } else {
    projectName = await promptProjectName()
  }

  const projectDir = path.resolve(process.cwd(), projectName)
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

  // Plugin mode short-circuits all CONFIG_OPTIONS prompts (those are
  // app-only: Tailwind etc. don't apply to plugins). It also uses a
  // different template and skips build-config seeding.
  let templateDir: string
  let slug: string
  if (pluginMode) {
    slug = "plugin"
    templateDir = path.join(TEMPLATES_DIR, "plugin")
  } else {
    const answers = yes ? defaultAnswers() : await promptOptions()
    slug = resolveSlug(answers)
    templateDir = path.join(TEMPLATES_DIR, slug)
  }
  if (!fs.existsSync(templateDir)) {
    bail(`No template found for configuration "${slug}".`)
  }

  const pm = detectPackageManager()

  p.log.step(
    `Scaffolding Zenbu ${pluginMode ? "plugin" : "app"} in "${displayName}" (template: ${slug})`,
  )
  if (pm.fallback) {
    p.log.info(
      `couldn't detect invoking package manager; defaulting to ${pm.type}@${pm.version}.`,
    )
  } else {
    p.log.info(`detected ${pm.type}@${pm.version} as the invoking package manager`)
  }

  const ctx: TemplateCtx = pluginMode
    ? {
        projectName: displayName,
        className: toPascalCase(displayName),
        dependsOn: renderDependsOn(projectDir, dependsOn),
      }
    : { projectName: displayName }

  copyDirSync(templateDir, projectDir, ctx)

  const gi = path.join(projectDir, "_gitignore")
  if (fs.existsSync(gi)) {
    fs.renameSync(gi, path.join(projectDir, ".gitignore"))
  }

  if (!pluginMode) {
    seedPackageManager(projectDir, pm)
  }

  if (ZENBU_LOCAL_CORE) {
    const corePath = path.resolve(ZENBU_LOCAL_CORE)
    rewireToLocalCore(projectDir, corePath, pluginMode)
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

  // Plugin mode: optionally add this plugin to each upstream host's
  // `plugins:[]`. Prompted interactively (default yes) unless `--yes` or
  // `--no-add-to-host` short-circuit. Only zenbu.config.ts deps are
  // candidates; standalone zenbu.plugin.ts dependencies are not hosts.
  const hostsToLink = new Set<string>()
  if (pluginMode && !noAddToHost) {
    for (const dep of dependsOn) {
      const base = path.basename(dep.from)
      const isConfig = base.startsWith("zenbu.config.")
      if (!isConfig) continue
      const hostDir = path.dirname(dep.from)
      const pluginManifestRel = relPosix(
        hostDir,
        path.join(projectDir, "zenbu.plugin.ts"),
      )
      let accept = yes
      if (!yes) {
        const result = await p.confirm({
          message: `Add "${pluginManifestRel}" to ${path.relative(process.cwd(), dep.from) || dep.from} plugins:?`,
          initialValue: true,
        })
        if (p.isCancel(result)) bail("Scaffolding cancelled.")
        accept = !!result
      }
      if (!accept) continue
      const outcome = appendPluginToHostConfig(dep.from, pluginManifestRel)
      switch (outcome) {
        case "added":
          p.log.success(`wired into ${dep.from}`)
          hostsToLink.add(hostDir)
          break
        case "already-present":
          p.log.info(`already listed in ${dep.from}`)
          hostsToLink.add(hostDir)
          break
        case "missing-file":
          p.log.warn(`host config not found: ${dep.from}`)
          break
        case "unsafe-shape":
          p.log.warn(
            `${dep.from}: couldn't safely edit plugins:[]. Add this manually:\n    ${JSON.stringify(pluginManifestRel)},`,
          )
          break
      }
    }
  }

  // Run `zen link` after install so types are wired up.
  if (installed) {
    if (pluginMode) {
      // Prefer host link (each host's composite picks up the new plugin
      // in the same call). Fall back to standalone plugin link if no host
      // got edited.
      if (hostsToLink.size > 0) {
        for (const hostDir of hostsToLink) {
          p.log.step(`running zen link in ${hostDir}`)
          const ok = runZenLink(hostDir, pm)
          if (!ok) p.log.warn(`zen link failed in ${hostDir}`)
        }
      } else {
        p.log.step(`running zen link --plugin .`)
        const ok = runZenLink(projectDir, pm, ["--plugin", "."])
        if (!ok) p.log.warn(`zen link --plugin . failed`)
      }
    } else {
      p.log.step(`running ${pm.type} run link`)
      const res = spawnSync(pm.type, ["run", "link"], {
        cwd: projectDir,
        stdio: "inherit",
      })
      if (res.status !== 0) {
        p.log.warn(
          `${pm.type} run link failed; you can retry manually after the scaffold completes.`,
        )
      }
    }
  }

  // Git init: skipped automatically when an ancestor already owns a repo
  // (common when scaffolding a plugin inside an existing host repo). When
  // no ancestor repo exists, prompt (default yes); suppressed by --no-git;
  // auto-confirmed by --yes.
  if (!noGit) {
    const ancestorRepo = findGitRoot(projectDir)
    if (ancestorRepo) {
      p.log.info(`inside existing repo at ${ancestorRepo} — skipping git init`)
    } else {
      let doInit = yes
      if (!yes) {
        const result = await p.confirm({
          message: "Initialize a git repo here?",
          initialValue: true,
        })
        if (p.isCancel(result)) bail("Scaffolding cancelled.")
        doInit = !!result
      }
      if (doInit) {
        gitInitWithInitialCommit(projectDir)
      }
    }
  }

  const cdHint = projectName === "." ? "" : `cd ${displayName} && `
  const next = pluginMode
    ? installed
      ? `${cdHint}${pm.type} run typecheck`
      : `${cdHint}${pm.type} install`
    : installed
      ? `${cdHint}${pm.type} dev`
      : `${cdHint}${pm.type} install\n  ${cdHint}${pm.type} dev`
  p.outro(`Done. Next:\n\n  ${next}\n`)
}

main().catch((err) => {
  console.error("\nError:", (err as Error)?.message ?? err)
  process.exit(1)
})
