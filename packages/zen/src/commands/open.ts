import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { resolveAppPath } from "../app-path"
import { connectCli } from "../lib/rpc"
import { readRuntimeConfig } from "../lib/runtime"

const DB_CONFIG_JSON = join(homedir(), ".zenbu", ".internal", "db.json")

type Args = {
  agent?: string
  blocking: boolean
  resume: boolean
  verbose: boolean
}

function parseArgs(argv: string[]): Args {
  let agent: string | undefined
  let blocking = false
  let resume = false
  let verbose = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--blocking") blocking = true
    else if (arg === "--resume") resume = true
    else if (arg === "--verbose" || arg === "-v") verbose = true
    else if (arg === "--agent" && i + 1 < argv.length) agent = argv[++i]
    else if (arg.startsWith("--agent=")) agent = arg.slice("--agent=".length)
    else if (!arg.startsWith("-") && agent == null) agent = arg
    else {
      console.error(`zen: unknown flag "${arg}"`)
      console.error(`valid: --agent <name>, --resume, --blocking, --verbose`)
      process.exit(1)
    }
  }
  return { agent, blocking, resume, verbose }
}

function readDbPath(): string | null {
  try {
    if (!existsSync(DB_CONFIG_JSON)) return null
    const data = JSON.parse(readFileSync(DB_CONFIG_JSON, "utf-8"))
    return data.dbPath ?? null
  } catch {
    return null
  }
}

type AgentRow = {
  id: string
  name: string
  configId: string
  status: string
  lastUserMessageAt?: number | null
}

/**
 * Cold-path fallback for reading the most-recently-used agent without a
 * running app — parses `root.json` off disk. When the app is running we
 * prefer `cli.listAgents()` over RPC.
 */
function readAgentsFromDb(dbPath: string): AgentRow[] {
  try {
    const rootPath = join(dbPath, "root.json")
    if (!existsSync(rootPath)) return []
    const root = JSON.parse(readFileSync(rootPath, "utf-8"))
    return root?.plugin?.kernel?.agents ?? []
  } catch {
    return []
  }
}

function pickLastAgent(agents: AgentRow[]): string | undefined {
  if (agents.length === 0) return undefined
  const sorted = [...agents]
    .filter((a) => a.lastUserMessageAt != null)
    .sort((a, b) => b.lastUserMessageAt! - a.lastUserMessageAt!)
  return sorted[0]?.id
}

async function promptAgentSelection(
  agents: AgentRow[],
): Promise<AgentRow | null> {
  if (agents.length === 0) {
    console.log("No agents found.")
    return null
  }
  console.log("\nAvailable agents:\n")
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i]!
    console.log(`  ${i + 1}) ${a.name} (${a.configId})`)
  }
  console.log()
  process.stdout.write("Select agent number: ")
  const input = await new Promise<string>((resolve) => {
    let data = ""
    process.stdin.setEncoding("utf-8")
    process.stdin.once("data", (chunk) => {
      data += chunk
      resolve(data.trim())
    })
  })
  const idx = parseInt(input, 10) - 1
  if (isNaN(idx) || idx < 0 || idx >= agents.length) {
    console.error("Invalid selection.")
    return null
  }
  return agents[idx]!
}

export async function runOpen(argv: string[]) {
  const { agent, blocking, resume, verbose } = parseArgs(argv)
  const log = verbose
    ? (...args: unknown[]) => console.error("[zen]", ...args)
    : () => {}
  const cwd = process.cwd()

  log("parsed args:", { agent, blocking, resume })

  if (resume) {
    const conn = await connectCli()
    if (!conn) {
      console.error("Zenbu is not running. Start it first.")
      process.exit(1)
    }
    try {
      const { agents } = await conn.rpc.cli.listAgents()
      const selected = await promptAgentSelection(agents)
      if (!selected) process.exit(1)
      console.log(`\nOpening ${selected.name}...`)
      await conn.rpc.cli.createWindow({ agentId: selected.id })
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err))
      process.exit(1)
    } finally {
      conn.close()
    }
    return
  }

  const conn = await connectCli()
  if (conn) {
    try {
      const lastAgentId = agent
        ? undefined
        : pickLastAgent((await conn.rpc.cli.listAgents()).agents)
      await conn.rpc.cli.createWindow({ agent, agentId: lastAgentId, cwd })
      return
    } catch (err) {
      log("rpc createWindow failed, falling through to spawn:", err)
    } finally {
      conn.close()
    }
  }

  const bin = resolveAppPath()
  if (!existsSync(bin)) {
    console.error(`Zenbu binary not found at ${bin}.`)
    console.error(
      `Install Zenbu.app to /Applications, or set ZENBU_APP_PATH to the binary.`,
    )
    process.exit(1)
  }

  const electronArgs: string[] = []
  if (agent) {
    electronArgs.push(`--zen-agent=${agent}`)
  } else {
    const dbPath = readRuntimeConfig()?.dbPath ?? readDbPath()
    const lastAgentId = dbPath ? pickLastAgent(readAgentsFromDb(dbPath)) : undefined
    if (lastAgentId) electronArgs.push(`--zen-agent-id=${lastAgentId}`)
  }
  electronArgs.push(`--zen-cwd=${cwd}`)
  electronArgs.push(`--zen-width=775`)

  if (blocking) {
    const child = spawn(bin, electronArgs, { stdio: "inherit" })
    process.on("SIGINT", () => child.kill("SIGINT"))
    process.on("SIGTERM", () => child.kill("SIGTERM"))
    child.on("exit", (code, signal) => {
      process.exit(code ?? (signal ? 1 : 0))
    })
  } else {
    const child = spawn(bin, electronArgs, {
      detached: true,
      stdio: "ignore",
    })
    child.unref()
  }
}
