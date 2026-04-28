import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, resolve as pathResolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

const BUN_BIN = `${homedir()}/Library/Caches/Zenbu/bin/bun`

const RPC_MODULE = pathResolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "lib",
  "rpc.ts",
)

/**
 * Run arbitrary TypeScript with an open RPC connection to the running app.
 * `rpc`, `events`, and `close` are exposed as top-level consts in the user
 * code's scope. The connection is always closed on completion.
 *
 * Usage:
 *   zen exec -e 'console.log(await rpc.cli.listAgents())'
 *   zen exec ./my-script.ts
 */
function printUsage() {
  console.log(`
Usage:
  zen exec -e '<ts code>'         Run inline TypeScript with rpc/events pre-opened
  zen exec <file.ts> [...args]    Run a TS file with rpc/events pre-opened

Available in scope:
  rpc                             typed RouterProxy<ServiceRouter>
  events                          EventProxy<PluginEvents>
  close()                         close the connection early (auto-closed at end)

Examples:
  zen exec -e 'console.log(await rpc.cli.ping())'
  zen exec -e 'console.log(await rpc["zp-min"].ping("hi"))'
  zen exec -e 'const a = await rpc.cli.listAgents(); console.log(a.agents.length)'
`)
}

export async function runExec(argv: string[]) {
  const eIdx = argv.findIndex((a) => a === "-e" || a === "--eval")
  let userCode: string | null = null
  let filePath: string | null = null
  let fileArgs: string[] = []

  if (eIdx >= 0) {
    const src = argv[eIdx + 1]
    if (!src) {
      printUsage()
      process.exit(1)
    }
    userCode = src
  } else {
    const first = argv.find((a) => !a.startsWith("-"))
    if (!first) {
      printUsage()
      process.exit(1)
    }
    filePath = pathResolve(first)
    if (!existsSync(filePath)) {
      console.error(`file not found: ${filePath}`)
      process.exit(1)
    }
    const idx = argv.indexOf(first)
    fileArgs = argv.slice(idx + 1)
  }

  const prelude = `
import { connectCli } from ${JSON.stringify(RPC_MODULE)}
const conn = await connectCli()
if (!conn) {
  console.error("[zen exec] app not running — start Zenbu first")
  process.exit(1)
}
const rpc = conn.rpc
const events = conn.events
const close = conn.close
try {
`
  const postlude = `
} catch (err) {
  console.error(err)
  process.exitCode = 1
} finally {
  close()
}
`

  const source = userCode
    ? prelude + userCode + postlude
    : prelude +
      `await import(${JSON.stringify(filePath)})` +
      postlude

  const child = spawn(BUN_BIN, ["--eval", source, ...fileArgs], {
    stdio: "inherit",
    env: process.env,
  })
  child.on("exit", (code) => process.exit(code ?? 0))
  child.on("error", (err) => {
    console.error(`[zen exec] spawn failed:`, err.message)
    process.exit(1)
  })
}
