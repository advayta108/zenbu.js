import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { findManifest, readManifest } from "../lib/manifest"
import { connectCli } from "../lib/rpc"

const BUN_BIN = join(homedir(), "Library", "Caches", "Zenbu", "bin", "bun")

type Opts = { dir?: string; skipRelaunch: boolean; reason: string | null }

function parseArgs(argv: string[]): Opts {
  const opts: Opts = { dir: undefined, skipRelaunch: false, reason: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--dir" && i + 1 < argv.length) opts.dir = argv[++i]
    else if (arg.startsWith("--dir=")) opts.dir = arg.slice("--dir=".length)
    else if (arg === "--reason" && i + 1 < argv.length) opts.reason = argv[++i]!
    else if (arg.startsWith("--reason=")) opts.reason = arg.slice("--reason=".length)
    else if (arg === "--no-relaunch-prompt") opts.skipRelaunch = true
    else if (!arg.startsWith("-") && !opts.dir) opts.dir = arg
  }
  return opts
}

function runBunScript(cwd: string, script: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(BUN_BIN, [script], { cwd, stdio: "inherit" })
    child.on("exit", (code) => resolve(code ?? 1))
    child.on("error", (err) => {
      console.error(`[zen setup] failed to spawn bun:`, err.message)
      resolve(1)
    })
  })
}

export async function runSetup(argv: string[]) {
  const { dir, skipRelaunch, reason } = parseArgs(argv)
  const startDir = dir ? dir : process.cwd()

  const manifestPath = findManifest(startDir)
  if (!manifestPath) {
    console.error(`No zenbu.plugin.json found from ${startDir}`)
    process.exit(1)
  }
  const pluginRoot = dirname(manifestPath)
  const manifest = readManifest(manifestPath)
  const setupScript = manifest.setup?.script
    ? join(pluginRoot, manifest.setup.script)
    : join(pluginRoot, "setup.ts")

  if (!existsSync(setupScript)) {
    console.error(`setup script not found at ${setupScript}`)
    process.exit(1)
  }

  if (!existsSync(BUN_BIN)) {
    console.error(`bundled bun not found at ${BUN_BIN}`)
    console.error(`Launch Zenbu.app once to bootstrap the toolchain.`)
    process.exit(1)
  }

  console.log(`[zen setup] ${manifest.name}: running ${manifest.setup?.script ?? "setup.ts"}`)
  const code = await runBunScript(pluginRoot, setupScript)
  if (code !== 0) {
    console.error(`[zen setup] setup exited with code ${code}`)
    process.exit(code)
  }
  console.log(`[zen setup] setup complete`)

  if (skipRelaunch) return

  // If the app is running and this plugin is already loaded, ask the UI to
  // relaunch — dynohot can't hot-reload node_modules that setup.ts just
  // rewrote.
  const conn = await connectCli()
  if (!conn) {
    console.log(`[zen setup] app not running; launch Zenbu to load the plugin.`)
    return
  }
  try {
    const decision = await conn.rpc.cli.requestRelaunch(
      manifest.name,
      reason ?? "ran setup.ts",
    )
    console.log(`[zen setup] relaunch ${decision}`)
    if (decision === "reject") {
      console.log(`[zen setup] new deps won't be active until you relaunch.`)
    }
  } catch (err) {
    // Transport dies from app.relaunch — that's the relaunch happening.
    const msg = err instanceof Error ? err.message : String(err)
    if (/close|disconnect|timeout/i.test(msg)) {
      console.log(`[zen setup] relaunch accept (transport closed)`)
    } else {
      console.error(`[zen setup] relaunch request failed:`, msg)
    }
  } finally {
    conn.close()
  }
}
