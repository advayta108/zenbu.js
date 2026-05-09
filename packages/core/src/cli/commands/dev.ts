import { spawn } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import path, { resolve as resolvePath } from "node:path"

type DevArgs = {
  projectDir: string
  detach: boolean
  verbose: boolean
}

/**
 * `zen dev` — launch the local app under Electron with the setup-gate as the
 * main entry. This is the entrypoint of `pnpm dev` in scaffolded apps. The
 * command is intentionally hookable: future versions can layer doctor checks,
 * environment validation, or a managed dev-server here without touching the
 * user's `package.json` scripts.
 *
 * Defaults to a foreground/blocking child so Ctrl+C in the terminal kills the
 * Electron process and `pnpm dev` exits cleanly. Pass `--detach` to spawn it
 * in the background instead (returns immediately, Electron lives until quit).
 */
function parseArgs(argv: string[]): DevArgs {
  let pathArg: string | undefined
  let detach = false
  let verbose = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--detach") detach = true
    else if (arg === "--verbose" || arg === "-v") verbose = true
    else if (!arg.startsWith("-") && pathArg == null) pathArg = arg
    else {
      console.error(`zen dev: unknown flag "${arg}"`)
      console.error(`valid: zen dev [path] [--detach] [--verbose]`)
      process.exit(1)
    }
  }

  const projectDir = pathArg
    ? resolvePath(process.cwd(), pathArg)
    : process.cwd()

  if (!existsSync(projectDir)) {
    console.error(`zen dev: path "${pathArg}" does not exist`)
    process.exit(1)
  }
  try {
    if (!statSync(projectDir).isDirectory()) {
      console.error(`zen dev: path "${pathArg}" is not a directory`)
      process.exit(1)
    }
  } catch {
    console.error(`zen dev: cannot stat "${pathArg}"`)
    process.exit(1)
  }

  return { projectDir, detach, verbose }
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
    `Electron is not installed in ${projectDir}. Run \`pnpm install\` in the app.`,
  )
}

function ensureSetupGate(projectDir: string): void {
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
      `@zenbujs/core setup-gate not found at ${setupGate}. Run \`pnpm install\` in the app.`,
    )
  }
}

export async function runDev(argv: string[]) {
  const { projectDir, detach, verbose } = parseArgs(argv)
  if (verbose) console.error("[zen dev] launching:", projectDir)
  const electron = resolveLocalElectron(projectDir)
  ensureSetupGate(projectDir)
  // Pass the project directory as the app path. Electron then resolves
  // `package.json#main` from there (which points at
  // `node_modules/@zenbujs/core/dist/setup-gate.mjs`). Passing the
  // setup-gate path directly would make Electron treat its parent dir as
  // the app and break `app.getAppPath()` semantics inside setup-gate.
  const electronArgs = [projectDir, `--project=${projectDir}`]

  if (detach) {
    const child = spawn(electron, electronArgs, {
      cwd: projectDir,
      detached: true,
      stdio: "ignore",
    })
    child.unref()
    return
  }

  const child = spawn(electron, electronArgs, { cwd: projectDir, stdio: "inherit" })
  process.on("SIGINT", () => child.kill("SIGINT"))
  process.on("SIGTERM", () => child.kill("SIGTERM"))
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0))
  })
}
