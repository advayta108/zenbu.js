import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { join, dirname, relative, resolve, isAbsolute } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { connectCli } from "../lib/rpc"
import { addPluginToLocalConfig } from "../lib/config"
import { runLink } from "./link"

const BUN_BIN = join(homedir(), "Library", "Caches", "Zenbu", "bin", "bun")

const RECIPES = ["db", "shortcut", "advice", "view"] as const
type Recipe = (typeof RECIPES)[number]

const PRESETS: Record<string, Recipe[]> = {
  mega: ["db", "shortcut", "advice", "view"],
}

type Opts = { name: string; dir: string; appDir: string; recipes: Recipe[] }

/**
 * Walk up from `from` until we hit a dir that has both `zenbu.plugin.json`
 * and a `config.json` whose `plugins` is an array — the host-app signature.
 */
function findHostApp(from: string): string | null {
  let dir = resolve(from)
  while (true) {
    const manifest = join(dir, "zenbu.plugin.json")
    const config = join(dir, "config.json")
    if (existsSync(manifest) && existsSync(config)) {
      try {
        const parsed = JSON.parse(readFileSync(config, "utf8"))
        if (Array.isArray(parsed?.plugins)) return dir
      } catch {}
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function toPascal(name: string): string {
  return name
    .split(/[-_]/)
    .map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : p))
    .join("")
}

function toCamel(name: string): string {
  const pascal = toPascal(name)
  return pascal[0]!.toLowerCase() + pascal.slice(1)
}

function interpolate(source: string, vars: Record<string, string>): string {
  return source.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`)
}

function templatesRoot(): string {
  // bin.ts is at packages/zen/src/bin.ts; templates sit at packages/zen/templates/plugin
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, "..", "..", "templates", "plugin")
}

/**
 * Recursively copy every `.tmpl` file from srcRoot into destRoot, stripping
 * the `.tmpl` suffix and interpolating `{{vars}}`. The base service stub
 * (`src/services/service.ts`) is renamed to `src/services/<plugin-name>.ts`.
 */
function copyLayer(srcRoot: string, destRoot: string, vars: Record<string, string>) {
  if (!existsSync(srcRoot)) return

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry)
      const rel = relative(srcRoot, abs)
      if (statSync(abs).isDirectory()) {
        mkdirSync(join(destRoot, rel), { recursive: true })
        walk(abs)
        continue
      }

      let destRel = rel.endsWith(".tmpl") ? rel.slice(0, -".tmpl".length) : rel
      destRel = destRel.replace(
        /src\/services\/service\.ts$/,
        `src/services/${vars.name}.ts`,
      )
      const destPath = join(destRoot, destRel)
      mkdirSync(dirname(destPath), { recursive: true })
      const raw = readFileSync(abs, "utf8")
      writeFileSync(destPath, interpolate(raw, vars))
    }
  }

  walk(srcRoot)
}

function runBunScript(cwd: string, script: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(BUN_BIN, [script], { cwd, stdio: "inherit" })
    child.on("exit", (code) => resolve(code ?? 1))
    child.on("error", (err) => {
      console.error(`[zen init] failed to spawn bun:`, err.message)
      resolve(1)
    })
  })
}

function parseRecipeList(value: string): Recipe[] {
  const result: Recipe[] = []
  for (const raw of value.split(",")) {
    const r = raw.trim() as Recipe
    if (!r) continue
    if (!RECIPES.includes(r)) {
      throw new Error(`unknown recipe "${r}" (valid: ${RECIPES.join(", ")})`)
    }
    if (!result.includes(r)) result.push(r)
  }
  return result
}

function parseArgs(argv: string[]): Opts | null {
  let name: string | null = null
  let dir: string | null = null
  let appDir: string | null = null
  const recipes = new Set<Recipe>()

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--dir" && i + 1 < argv.length) dir = argv[++i]!
    else if (arg.startsWith("--dir=")) dir = arg.slice("--dir=".length)
    else if (arg === "--app" && i + 1 < argv.length) appDir = argv[++i]!
    else if (arg.startsWith("--app=")) appDir = arg.slice("--app=".length)
    else if (arg === "--with" && i + 1 < argv.length)
      parseRecipeList(argv[++i]!).forEach((r) => recipes.add(r))
    else if (arg.startsWith("--with="))
      parseRecipeList(arg.slice("--with=".length)).forEach((r) => recipes.add(r))
    else if (arg === "--preset" && i + 1 < argv.length) {
      const p = argv[++i]!
      if (!PRESETS[p]) throw new Error(`unknown preset "${p}" (valid: ${Object.keys(PRESETS).join(", ")})`)
      PRESETS[p]!.forEach((r) => recipes.add(r))
    } else if (arg.startsWith("--preset=")) {
      const p = arg.slice("--preset=".length)
      if (!PRESETS[p]) throw new Error(`unknown preset "${p}"`)
      PRESETS[p]!.forEach((r) => recipes.add(r))
    } else if (!arg.startsWith("-") && !name) name = arg
  }

  if (!name) return null
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    console.error(`plugin name must match /^[a-z][a-z0-9-]*$/ (got: ${name})`)
    return null
  }
  const targetDir = dir ? resolve(dir) : join(process.cwd(), name)
  // Resolve the host app the new plugin will link into. Explicit `--app`
  // wins; otherwise walk up from the target dir's parent (the plugin doesn't
  // exist yet, but its parent is where we want to start the search).
  const resolvedApp = appDir
    ? (isAbsolute(appDir) ? appDir : resolve(process.cwd(), appDir))
    : findHostApp(dirname(targetDir))
  if (!resolvedApp) {
    console.error(
      `zen init: could not detect a host app from ${dirname(targetDir)}.`,
    )
    console.error(
      `         Pass --app <path> or run from inside an app directory`,
    )
    console.error(
      `         (one with both zenbu.plugin.json and config.json#plugins).`,
    )
    return null
  }
  return {
    name,
    dir: targetDir,
    appDir: resolvedApp,
    recipes: [...recipes],
  }
}

type Manifest = {
  name: string
  services: string[]
  schema?: string
  migrations?: string
  setup?: { script: string; version: number }
}

function buildManifest(name: string, recipes: Recipe[]): Manifest {
  const m: Manifest = {
    name,
    services: ["src/services/*.ts"],
    setup: { script: "./setup.ts", version: 1 },
  }
  if (recipes.includes("db")) {
    m.schema = "./src/schema.ts"
    m.migrations = "./kyju"
  }
  return m
}

function buildPackageJson(name: string, recipes: Recipe[]): object {
  const deps: Record<string, string> = {
    effect: "^3.21.0",
    nanoid: "^5.1.9",
    zod: "^4",
  }
  const devDeps: Record<string, string> = {}
  if (recipes.includes("advice") || recipes.includes("view")) {
    deps.react = "^19.2.4"
    deps["react-dom"] = "^19.2.4"
    devDeps["@types/react"] = "^19.0.0"
    devDeps["@types/react-dom"] = "^19.0.0"
  }
  if (recipes.includes("view")) {
    devDeps.vite = "^5.4.0"
    devDeps["@vitejs/plugin-react"] = "^4.3.0"
  }
  return {
    name,
    version: "0.0.1",
    private: true,
    type: "module",
    dependencies: deps,
    ...(Object.keys(devDeps).length > 0 ? { devDependencies: devDeps } : {}),
  }
}

function printUsage() {
  console.log(`
Usage:
  zen init <plugin-name> [--dir <path>] [--app <path>] [--with <recipes>] [--preset <name>]

Recipes (composable, comma-separated):
  db        — kyju schema section (root.plugin.<name>.*) + migrations barrel
  shortcut  — service that registers a keyboard shortcut
  advice    — service that wraps/replaces a component in an existing view
  view      — Vite-served React page, registered as a view in the orchestrator

Presets:
  mega      — all recipes

Host app:
  --app <path>  Path to the host app (the dir with zenbu.plugin.json + config.json).
                Defaults to walking up from --dir / cwd until one is found.

Examples:
  zen init my-plugin
  zen init my-plugin --app ../some-app
  zen init my-plugin --with shortcut
  zen init my-plugin --with db,shortcut
  zen init my-plugin --preset mega
`)
}

export async function runInit(argv: string[]) {
  let opts: Opts | null
  try {
    opts = parseArgs(argv)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
  if (!opts) {
    printUsage()
    process.exit(1)
  }

  const { name, dir, appDir, recipes } = opts
  if (existsSync(dir)) {
    console.error(`target directory already exists: ${dir}`)
    process.exit(1)
  }
  if (!existsSync(BUN_BIN)) {
    console.error(`bundled bun not found at ${BUN_BIN}`)
    console.error(`Launch Zenbu.app once to bootstrap the toolchain.`)
    process.exit(1)
  }

  mkdirSync(dir, { recursive: true })

  const vars: Record<string, string> = {
    name,
    PascalName: toPascal(name),
    camelName: toCamel(name),
    homedir: homedir(),
    appDir,
    recipesFlag: recipes.length > 0 ? ` --with ${recipes.join(",")}` : "",
    recipesList:
      recipes.length > 0
        ? `\nRecipes enabled: ${recipes.join(", ")}.`
        : "\nNo recipes — the minimum plugin with a single service.",
  }

  const templates = templatesRoot()
  console.log(
    `[zen init] scaffolding ${name} at ${dir}${recipes.length > 0 ? ` with recipes: ${recipes.join(",")}` : ""}`,
  )

  // Base layer first
  copyLayer(join(templates, "base"), dir, vars)

  // Then each recipe layer, in declaration order
  for (const recipe of recipes) {
    copyLayer(join(templates, "recipes", recipe), dir, vars)
  }

  // Programmatic manifest + package.json (vary per recipe selection)
  writeFileSync(
    join(dir, "zenbu.plugin.json"),
    JSON.stringify(buildManifest(name, recipes), null, 2) + "\n",
  )
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(buildPackageJson(name, recipes), null, 2) + "\n",
  )

  console.log(`[zen init] installing deps via bundled bun`)
  const code = await runBunScript(dir, join(dir, "setup.ts"))
  if (code !== 0) {
    console.error(`[zen init] setup exited with code ${code}`)
    process.exit(code)
  }

  const manifestPath = join(dir, "zenbu.plugin.json")
  const conn = await connectCli()
  if (conn) {
    try {
      await (conn.rpc as any).installer.addPluginToConfig(manifestPath)
      console.log(`[zen init] registered ${name} in ~/.zenbu/config`)
    } catch (err) {
      console.error(
        `[zen init] failed to register via RPC:`,
        err instanceof Error ? err.message : String(err),
      )
    } finally {
      conn.close()
    }
  } else {
    addPluginToLocalConfig(manifestPath)
    console.log(`[zen init] registered ${name} in ~/.zenbu/config (offline)`)
  }

  console.log(`[zen init] regenerating registry types`)
  try {
    await runLink([manifestPath])
  } catch (err) {
    console.error(
      `[zen init] zen link failed:`,
      err instanceof Error ? err.message : String(err),
    )
  }

  console.log(`
${name} ready at ${dir}
${recipes.length > 0 ? `Recipes: ${recipes.join(", ")}\n` : ""}
Next:
  • Edit src/services/${name}.ts — it hot-reloads as you save.${
    recipes.includes("db")
      ? `\n  • Edit src/schema.ts then run \`zen kyju generate\`.`
      : ""
  }${
    recipes.includes("shortcut")
      ? `\n  • Edit src/services/shortcuts.ts to change the binding/scope.`
      : ""
  }${
    recipes.includes("advice")
      ? `\n  • Edit src/services/advice.ts to target a different component.`
      : ""
  }${
    recipes.includes("view")
      ? `\n  • Edit src/view/App.tsx — your view is served by its own Vite dev server.`
      : ""
  }
  • Run \`zen link\` any time you add/remove services or schemas.
`)
}
