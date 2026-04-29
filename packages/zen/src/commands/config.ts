import fsp from "node:fs/promises"
import path from "node:path"
import { loadRegistry } from "../../../init/shared/db-registry"
import { readRuntimeConfig } from "../lib/runtime"

/**
 * Cold-path read/write into the active DB's `root.json`. Source of truth for
 * the active DB:
 *   1. `runtime.json.dbPath` if the app is currently running
 *   2. `registry.defaultDbPath`
 *   3. error — no DB configured yet, run `zen db default <path>` first.
 *
 * Eventually consistent with the running DbService: writes from here will be
 * picked up on next evaluation but concurrent writes from the service could
 * lose. Prefer running this when the app is quit for deterministic semantics.
 */
async function resolveDbDir(): Promise<string> {
  const running = readRuntimeConfig()
  if (running?.dbPath) return running.dbPath
  const reg = await loadRegistry()
  if (reg.defaultDbPath) return reg.defaultDbPath
  console.error(
    "zen config: no DB configured yet. Run `zen db default <path>` or launch with `zen --db <path>`.",
  )
  process.exit(1)
}

async function readRoot(rootJson: string): Promise<any> {
  try {
    const text = await fsp.readFile(rootJson, "utf-8")
    return JSON.parse(text)
  } catch {
    return { plugin: { "zen-cli": {} } }
  }
}

async function writeRoot(rootJson: string, root: any): Promise<void> {
  await fsp.mkdir(path.dirname(rootJson), { recursive: true })
  await fsp.writeFile(rootJson, JSON.stringify(root, null, 2))
}

function getSection(root: any): Record<string, unknown> {
  root.plugin ??= {}
  root.plugin["zen-cli"] ??= {}
  return root.plugin["zen-cli"]
}

function printUsage() {
  console.log(`
Usage: zen config <get|set> <key> [value]

Examples:
  zen config get appPath
  zen config set appPath /Applications/Zenbu.app/Contents/MacOS/Zenbu
`)
}

export async function runConfig(argv: string[]) {
  const [op, key, value, ...rest] = argv
  if (!op || (op !== "get" && op !== "set")) {
    printUsage()
    process.exit(op ? 1 : 0)
  }
  if (!key) {
    printUsage()
    process.exit(1)
  }

  const dbDir = await resolveDbDir()
  const rootJson = path.join(dbDir, "root.json")
  const root = await readRoot(rootJson)
  const section = getSection(root)

  if (op === "get") {
    const v = section[key]
    if (v === undefined) process.exit(1)
    if (typeof v === "string") console.log(v)
    else console.log(JSON.stringify(v))
    return
  }

  if (value === undefined) {
    console.error("zen config set requires a value")
    process.exit(1)
  }
  const full = [value, ...rest].join(" ")
  section[key] = full
  await writeRoot(rootJson, root)
  console.log(`${key} = ${full}`)
}
