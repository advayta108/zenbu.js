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
  zen db generate [...]       Diff your schema against the last snapshot and
                              write a new migration (delegates to the embedded
                              migration generator). Common flags:
                                --config <path>   db.config.ts (auto-detected)
                                --name <tag>      custom migration name
                                --custom          generate editable migrate()
                                --amend           replace the last migration
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
 * Delegate to the embedded migration generator. Translates `db.config.ts`
 * into the underlying engine's expected default name (`kyju.config.ts`)
 * when no `--config` is passed and only the user-facing name exists.
 */
async function runGenerate(argv: string[]): Promise<void> {
  const { run: runEmbedded } = await import("@zenbu/kyju/cli")
  const hasConfigFlag = argv.some((a) => a === "--config" || a.startsWith("--config="))
  const finalArgs = ["generate", ...argv]
  if (!hasConfigFlag) {
    const candidates = ["db.config.ts", "db.config.js", "db.config.mjs"]
    for (const name of candidates) {
      const candidate = resolvePath(process.cwd(), name)
      try {
        const fs = await import("node:fs")
        if (fs.existsSync(candidate)) {
          finalArgs.push("--config", candidate)
          break
        }
      } catch {}
    }
  }
  await runEmbedded(finalArgs)
}
