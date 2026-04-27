import { spawn } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { resolveAppPath } from "../app-path"
import { connectCli } from "../lib/rpc"

type WindowMode = "default" | "reuse" | "new"

type Args = {
  cwd: string
  mode: WindowMode
  blocking: boolean
  verbose: boolean
}

function parseArgs(argv: string[]): Args {
  let pathArg: string | undefined
  let mode: WindowMode = "default"
  let blocking = false
  let verbose = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--blocking") blocking = true
    else if (arg === "--verbose" || arg === "-v") verbose = true
    else if (arg === "--reuse-window" || arg === "-r") mode = "reuse"
    else if (arg === "--new-window" || arg === "-n") mode = "new"
    else if (!arg.startsWith("-") && pathArg == null) pathArg = arg
    else {
      console.error(`zen: unknown flag "${arg}"`)
      console.error(
        `valid: zen [path] [-r|--reuse-window] [-n|--new-window] [--blocking] [--verbose]`,
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

  return { cwd, mode, blocking, verbose }
}

export async function runOpen(argv: string[]) {
  const { cwd, mode, blocking, verbose } = parseArgs(argv)
  const log = verbose
    ? (...args: unknown[]) => console.error("[zen]", ...args)
    : () => {}

  log("opening workspace at:", cwd, "mode:", mode)

  const conn = await connectCli()
  if (conn) {
    try {
      await conn.rpc.cli.openWorkspace({ cwd, mode })
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

  const electronArgs: string[] = [
    `--zen-cwd=${cwd}`,
    `--zen-window-mode=${mode}`,
    `--zen-width=775`,
  ]

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
