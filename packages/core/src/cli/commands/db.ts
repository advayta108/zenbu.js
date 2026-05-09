import fs from "node:fs"
import path from "node:path"
import { resolve as resolvePath } from "node:path"
import {
  addDb,
  loadRegistry,
  removeDb,
  setDefault,
  type DbEntry,
} from "../lib/db-registry"
import { readRuntimeConfig } from "../lib/runtime"
import { c, pickOne, readLine, relTime, tildify } from "../lib/picker"

const ADD_NEW_VALUE = "__add_new__" as const
type DefaultValue = string | typeof ADD_NEW_VALUE

function printUsage(exitCode = 0): never {
  console.log(`
Usage:
  zen db                      Interactive picker for the default DB
  zen db list                 List known DB paths
  zen db add <path>           Register a path (mkdir -p) without launching
  zen db default [<path>]     Set the default DB (interactive when omitted)
  zen db remove [<path>]      Drop a path from the registry (interactive when omitted)
  zen db generate [...]       Diff a schema against the last snapshot and
                              write a new migration. Default: walks up from
                              cwd to the host's zenbu.config.ts, then picks
                              the plugin whose dir contains cwd. Flags:
                                --schema <path>       schema file (bypasses
                                                      plugin discovery; must
                                                      be paired with --migrations)
                                --migrations <path>   migrations output dir
                                                      (paired with --schema)
                                --name <tag>          custom migration name
                                --custom              generate editable migrate()
                                --amend               replace the last migration
`)
  process.exit(exitCode)
}

function annotate(
  e: DbEntry,
  defaultPath: string | null,
  activePath: string | null,
): { tags: string[]; rawTags: string[] } {
  const tags: string[] = []
  const rawTags: string[] = []
  if (e.path === defaultPath) {
    tags.push(c.green("default"))
    rawTags.push("default")
  }
  if (activePath && e.path === activePath) {
    tags.push(c.cyan("running"))
    rawTags.push("running")
  }
  return { tags, rawTags }
}

async function runList(): Promise<void> {
  const reg = await loadRegistry()
  const running = readRuntimeConfig()
  const activePath = running?.dbPath ?? null

  if (reg.dbs.length === 0) {
    console.log("No DBs registered yet. Run `zen db add <path>` or `zen --db <path>`.")
    return
  }

  const sorted = [...reg.dbs].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  const rows = sorted.map((e) => {
    const { tags } = annotate(e, reg.defaultDbPath, activePath)
    return {
      path: tildify(e.path),
      time: relTime(e.lastUsedAt),
      tags: tags.join(" "),
    }
  })
  const pathW = Math.max(...rows.map((r) => r.path.length), "path".length)
  const timeW = Math.max(...rows.map((r) => r.time.length), "last used".length)

  console.log("")
  console.log(
    `  ${c.dim("path".padEnd(pathW))}  ${c.dim("last used".padEnd(timeW))}`,
  )
  for (const r of rows) {
    console.log(
      `  ${r.path.padEnd(pathW)}  ${c.dim(r.time.padEnd(timeW))}  ${r.tags}`,
    )
  }
  console.log("")
}

async function runAdd(argv: string[]): Promise<void> {
  const target = argv[0]
  if (!target) {
    console.error("zen db add: missing <path>")
    process.exit(1)
  }
  const abs = resolvePath(process.cwd(), target)
  await addDb(abs)
  console.log(`added ${tildify(abs)}`)
}

async function pickDefault(): Promise<void> {
  const reg = await loadRegistry()
  const running = readRuntimeConfig()
  const activePath = running?.dbPath ?? null

  const sorted = [...reg.dbs].sort((a, b) => b.lastUsedAt - a.lastUsedAt)

  type Opt = { value: DefaultValue; label: string; detail?: string }
  const options: Opt[] = sorted.map((e) => {
    const { rawTags } = annotate(e, reg.defaultDbPath, activePath)
    return {
      value: e.path,
      label: tildify(e.path),
      detail: [relTime(e.lastUsedAt), ...rawTags].filter(Boolean).join(" · "),
    }
  })
  options.push({
    value: ADD_NEW_VALUE,
    label: c.magenta("+ Add a new path…"),
  })

  const initialIdx = Math.max(
    0,
    sorted.findIndex((e) => e.path === reg.defaultDbPath),
  )

  const idx = await pickOne("Choose default DB:", options, initialIdx)
  if (idx === null) {
    console.log("aborted")
    return
  }

  const chosen = options[idx]!.value
  let target: string
  if (chosen === ADD_NEW_VALUE) {
    const input = await readLine("New DB path: ")
    if (!input) {
      console.log("aborted")
      return
    }
    target = resolvePath(process.cwd(), input.replace(/^~/, process.env.HOME ?? "~"))
  } else {
    target = chosen
  }

  await setDefault(target)
  console.log(`default = ${tildify(target)}`)
  if (activePath && activePath !== target) {
    console.log(
      c.yellow(
        `note: app is currently running on ${tildify(
          activePath,
        )}; quit and relaunch to pick up the new default.`,
      ),
    )
  }
}

async function runDefault(argv: string[]): Promise<void> {
  if (argv.length === 0) {
    await pickDefault()
    return
  }
  const abs = resolvePath(process.cwd(), argv[0]!)
  await setDefault(abs)
  console.log(`default = ${tildify(abs)}`)
  const running = readRuntimeConfig()
  if (running?.dbPath && running.dbPath !== abs) {
    console.log(
      c.yellow(
        `note: app is currently running on ${tildify(
          running.dbPath,
        )}; quit and relaunch to pick up the new default.`,
      ),
    )
  }
}

async function runRemove(argv: string[]): Promise<void> {
  let abs: string | null = null
  if (argv.length > 0) {
    abs = resolvePath(process.cwd(), argv[0]!)
  } else {
    const reg = await loadRegistry()
    if (reg.dbs.length === 0) {
      console.log("registry is empty")
      return
    }
    const options = reg.dbs.map((e) => ({
      value: e.path,
      label: tildify(e.path),
      detail: relTime(e.lastUsedAt),
    }))
    const idx = await pickOne("Remove which DB?", options, 0)
    if (idx === null) {
      console.log("aborted")
      return
    }
    abs = options[idx]!.value
  }

  const before = await loadRegistry()
  if (!before.dbs.some((e) => e.path === abs)) {
    console.error(`zen db remove: ${tildify(abs)} not in registry`)
    process.exit(1)
  }
  await removeDb(abs)
  console.log(`removed ${tildify(abs)}`)
}

export async function runDb(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv
  if (!sub) {
    await pickDefault()
    return
  }
  if (sub === "help" || sub === "--help" || sub === "-h") {
    printUsage()
  }
  switch (sub) {
    case "list":
    case "ls":
      await runList()
      return
    case "add":
      await runAdd(rest)
      return
    case "default":
      await runDefault(rest)
      return
    case "remove":
    case "rm":
      await runRemove(rest)
      return
    case "generate":
    case "gen":
      await runGenerate(rest)
      return
    default:
      console.error(`zen db: unknown subcommand "${sub}"`)
      printUsage(1)
  }
}

/**
 * Drive the embedded migration generator. Two input modes:
 *
 *   • Manifest mode (default for plugins). Walks up from cwd to the
 *     nearest `zenbu.plugin.json` and reads `schema` + `migrations` from
 *     it — same paths `discoverSections` consumes at runtime, so there's
 *     one source of truth per plugin.
 *
 *   • Direct mode (`--schema <path> --migrations <path>`). Skips manifest
 *     discovery entirely. Used for schemas that aren't a zenbu plugin —
 *     notably `@zenbujs/core`'s framework schema, which is invoked through
 *     a `db:generate` script in `packages/core/package.json`. Composable
 *     for any future internal section without growing privileged flags
 *     into the CLI.
 *
 * Resolution: direct mode (--schema + --migrations) bypasses everything;
 * otherwise the cwd is matched against the plugins declared in the host
 * project's `zenbu.config.ts`, picking the plugin whose `dir` contains the
 * cwd. Mixing direct + plugin discovery is an error.
 */
function findProjectDir(from: string): string | null {
  let dir = path.resolve(from)
  while (true) {
    for (const name of ["zenbu.config.ts", "zenbu.config.mts", "zenbu.config.js", "zenbu.config.mjs"]) {
      if (fs.existsSync(path.join(dir, name))) return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

type GenerateFlags = {
  schema: string | null
  migrationsOut: string | null
  name?: string
  custom: boolean
  amend: boolean
}

function parseGenerateArgs(argv: string[]): GenerateFlags {
  const out: GenerateFlags = {
    schema: null,
    migrationsOut: null,
    custom: false,
    amend: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--schema" && i + 1 < argv.length) out.schema = argv[++i]!
    else if (arg.startsWith("--schema=")) out.schema = arg.slice("--schema=".length)
    else if (arg === "--migrations" && i + 1 < argv.length) out.migrationsOut = argv[++i]!
    else if (arg.startsWith("--migrations=")) out.migrationsOut = arg.slice("--migrations=".length)
    else if (arg === "--name" && i + 1 < argv.length) out.name = argv[++i]!
    else if (arg.startsWith("--name=")) out.name = arg.slice("--name=".length)
    else if (arg === "--custom") out.custom = true
    else if (arg === "--amend") out.amend = true
  }
  return out
}

async function runGenerate(argv: string[]): Promise<void> {
  const flags = parseGenerateArgs(argv)
  const { generateMigration } = await import("@zenbu/kyju/cli")

  // Direct mode: --schema + --migrations bypasses plugin discovery entirely.
  if (flags.schema || flags.migrationsOut) {
    if (!flags.schema || !flags.migrationsOut) {
      console.error(
        "zen db generate: --schema and --migrations must be passed together.",
      )
      process.exit(1)
    }
    const schemaPath = resolvePath(process.cwd(), flags.schema)
    const outPath = resolvePath(process.cwd(), flags.migrationsOut)
    console.log(`Schema:  ${schemaPath}`)
    console.log(`Output:  ${outPath}`)
    await generateMigration({
      schemaPath,
      outPath,
      name: flags.name,
      custom: flags.custom,
      amend: flags.amend,
    })
    return
  }

  // Plugin-discovery mode: walk up to the host's zenbu.config.ts, load it,
  // and pick the plugin whose dir contains cwd.
  const projectDir = findProjectDir(process.cwd())
  if (!projectDir) {
    console.error(
      "zen db generate: no zenbu.config.ts found in cwd or any parent.",
    )
    console.error(
      "                 Run from inside a Zenbu project, or use",
    )
    console.error(
      "                 --schema <path> --migrations <path> directly.",
    )
    process.exit(1)
  }

  const { loadConfig } = await import("../lib/load-config")
  const { resolved } = await loadConfig(projectDir)

  const cwd = path.resolve(process.cwd())
  let bestMatch: { dir: string; depth: number; plugin: typeof resolved.plugins[number] } | null = null
  for (const plugin of resolved.plugins) {
    const rel = path.relative(plugin.dir, cwd)
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue
    const depth = plugin.dir.split(path.sep).length
    if (!bestMatch || depth > bestMatch.depth) {
      bestMatch = { dir: plugin.dir, depth, plugin }
    }
  }

  if (!bestMatch) {
    console.error(
      `zen db generate: cwd ${cwd} is not inside any plugin declared in ${path.relative(projectDir, resolved.configPath)}.`,
    )
    process.exit(1)
  }

  const plugin = bestMatch.plugin
  if (!plugin.schemaPath) {
    console.error(
      `zen db generate: plugin "${plugin.name}" is missing a \`schema\` field in its definePlugin({...}).`,
    )
    process.exit(1)
  }
  if (!plugin.migrationsPath) {
    console.error(
      `zen db generate: plugin "${plugin.name}" is missing a \`migrations\` field in its definePlugin({...}) ` +
        `(the directory the generator writes migrations into).`,
    )
    process.exit(1)
  }

  console.log(`Plugin: ${plugin.name}`)
  console.log(`Schema:  ${plugin.schemaPath}`)
  console.log(`Output:  ${plugin.migrationsPath}`)

  await generateMigration({
    schemaPath: plugin.schemaPath,
    outPath: plugin.migrationsPath,
    name: flags.name,
    custom: flags.custom,
    amend: flags.amend,
  })
}
