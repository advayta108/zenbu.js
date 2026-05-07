import { spawn } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import path, { resolve as resolvePath } from "node:path"

type OpenArgs = {
  projectDir: string
  blocking: boolean
  verbose: boolean
}

function parseArgs(argv: string[]): OpenArgs {
  let pathArg: string | undefined
  let blocking = false
  let verbose = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--blocking") blocking = true
    else if (arg === "--verbose" || arg === "-v") verbose = true
    else if (!arg.startsWith("-") && pathArg == null) pathArg = arg
    else {
      console.error(`zen: unknown flag "${arg}"`)
      console.error(
        `valid: zen [path] [--blocking] [--verbose]`,
      )
      process.exit(1)
    }
  }

  const projectDir = pathArg
    ? resolvePath(process.cwd(), pathArg)
    : process.cwd()

  if (!existsSync(projectDir)) {
    console.error(`zen: path "${pathArg}" does not exist`)
    process.exit(1)
  }
  try {
    if (!statSync(projectDir).isDirectory()) {
      console.error(`zen: path "${pathArg}" is not a directory`)
      process.exit(1)
    }
  } catch {
    console.error(`zen: cannot stat "${pathArg}"`)
    process.exit(1)
  }

  return { projectDir, blocking, verbose }
}

function resolveLocalElectron(projectDir: string): string {
  const candidates = [
    path.join(projectDir, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
    path.join(projectDir, "node_modules", ".bin", "electron"),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    `Electron is not installed in ${projectDir}. Run \`pnpm add -D electron\` in the app.`,
  )
}

function resolveSetupGate(projectDir: string): string {
  const setupGate = path.join(
    projectDir,
    "node_modules",
    "@zenbujs",
    "core",
    "dist",
    "setup-gate.mjs",
  )
  if (!existsSync(setupGate)) {
    throw new Error(
      `@zenbujs/core setup-gate not found at ${setupGate}. Run \`zen install\` in the app.`,
    )
  }
  return setupGate
}

export async function runOpen(argv: string[]) {
  const { projectDir, blocking, verbose } = parseArgs(argv)
  if (verbose) console.error("[zen] launching:", projectDir)
  const electron = resolveLocalElectron(projectDir)
  const setupGate = resolveSetupGate(projectDir)
  const electronArgs = [setupGate, `--project=${projectDir}`]

  if (blocking) {
    const child = spawn(electron, electronArgs, { cwd: projectDir, stdio: "inherit" })
    process.on("SIGINT", () => child.kill("SIGINT"))
    process.on("SIGTERM", () => child.kill("SIGTERM"))
    child.on("exit", (code, signal) => {
      process.exit(code ?? (signal ? 1 : 0))
    })
  } else {
    const child = spawn(electron, electronArgs, {
      cwd: projectDir,
      detached: true,
      stdio: "ignore",
    })
    child.unref()
  }
}
