import { spawn } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { resolveAppPath } from "../app-path"
import { connectCli } from "../lib/rpc"
import { addDb, loadRegistry } from "../../../init/shared/db-registry"

type WindowMode = "default" | "reuse" | "new"

type Args = {
  cwd: string
  mode: WindowMode
  blocking: boolean
  verbose: boolean
  dbPath: string | null
}

function parseArgs(argv: string[]): Args {
  let pathArg: string | undefined
  let mode: WindowMode = "default"
  let blocking = false
  let verbose = false
  let dbPath: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--blocking") blocking = true
    else if (arg === "--verbose" || arg === "-v") verbose = true
    else if (arg === "--reuse-window" || arg === "-r") mode = "reuse"
    else if (arg === "--new-window" || arg === "-n") mode = "new"
    else if (arg === "--db" || arg === "-d") {
      const next = argv[i + 1]
      if (!next || next.startsWith("-")) {
        console.error(`zen: ${arg} requires a path`)
        process.exit(1)
      }
      dbPath = resolvePath(process.cwd(), next)
      i++
    } else if (arg.startsWith("--db=")) {
      dbPath = resolvePath(process.cwd(), arg.slice("--db=".length))
    } else if (!arg.startsWith("-") && pathArg == null) pathArg = arg
    else {
      console.error(`zen: unknown flag "${arg}"`)
      console.error(
        `valid: zen [path] [-r|--reuse-window] [-n|--new-window] [-d|--db <path>] [--blocking] [--verbose]`,
      )
      process.exit(1)
    }
  }

  const cwd = pathArg
    ? resolvePath(process.cwd(), pathArg)
    : process.cwd()

  if (!existsSync(cwd)) {
    console.error(`zen: path "${pathArg}" does not exist`)
    process.exit(1)
  }
  try {
    if (!statSync(cwd).isDirectory()) {
      console.error(`zen: path "${pathArg}" is not a directory`)
      process.exit(1)
    }
  } catch {
    console.error(`zen: cannot stat "${pathArg}"`)
    process.exit(1)
  }

  return { cwd, mode, blocking, verbose, dbPath }
}

export async function runOpen(argv: string[]) {
  const { cwd, mode, blocking, verbose, dbPath } = parseArgs(argv)
  const log = verbose
    ? (...args: unknown[]) => console.error("[zen]", ...args)
    : () => {}

  log("opening workspace at:", cwd, "mode:", mode)

  // Resolve the requested DB path: explicit flag → registry default → null
  // (let the main process fall back to cwd/.zenbu/db).
  let resolvedDbPath: string | null = dbPath
  if (!resolvedDbPath) {
    try {
      const reg = await loadRegistry()
      resolvedDbPath = reg.defaultDbPath
    } catch {
      resolvedDbPath = null
    }
  }

  const conn = await connectCli()
  if (conn) {
    try {
      if (
        resolvedDbPath &&
        conn.config.dbPath &&
        conn.config.dbPath !== resolvedDbPath
      ) {
        console.error(
          `zen: app is already running with DB at ${conn.config.dbPath}.`,
        )
        console.error(
          `     Quit it (or omit --db) before switching to ${resolvedDbPath}.`,
        )
        process.exit(1)
      }
      await conn.rpc.cli.openWorkspace({ cwd, mode })
      if (resolvedDbPath) {
        addDb(resolvedDbPath).catch(() => {})
      }
      return
    } catch (err) {
      log("rpc openWorkspace failed, falling through to spawn:", err)
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

  if (resolvedDbPath) {
    try {
      await addDb(resolvedDbPath)
    } catch (err) {
      log("failed to record db path in registry:", err)
    }
  }

  const electronArgs: string[] = [
    `--zen-cwd=${cwd}`,
    `--zen-window-mode=${mode}`,
    `--zen-width=775`,
  ]
  if (resolvedDbPath) {
    electronArgs.push(`--zen-db-path=${resolvedDbPath}`)
  }

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
