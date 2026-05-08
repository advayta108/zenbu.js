#!/usr/bin/env node
// zen CLI — bundled by tsdown. Subcommands are imported lazily so one command
// does not pull the full legacy command surface into process startup.

const SUBCOMMANDS = new Set([
  "kyju",
  "link",
  "doctor",
  "config",
  "setup",
  "init",
  "install",
  "exec",
  "profile",
  "db",
  "runtime",
  "setup-app",
  "launch",
  "dev",
  "build:source",
  "build:desktop",
  "publish:source",
  "publish:desktop",
  "help",
  "--help",
  "-h",
])

function printUsage() {
  console.log(`
zen — Zenbu CLI

Usage:
  zen [path] [--blocking] [--verbose]            Run app at path with local Electron
  zen launch [--blocking] [--runtime <ver>]      Legacy standalone launch
  zen runtime [install|list|remove] [version]    Legacy Electron runtime cache
  zen setup-app [--name "App"] [--runtime <ver>] Legacy native .app bundle
  zen link                                       Regenerate registry types
  zen doctor                                     Re-run kernel setup.ts
  zen setup [--dir <path>]                       Run a plugin's setup.ts
  zen config <get|set> <key> [value]             Read/write CLI config
  zen db [list|add|default|remove|generate] [...] Manage DB paths or generate migrations
  zen init <plugin-name> [--dir <path>]          Scaffold a new plugin
  zen install [path] [--force]                   Install app deps with managed pnpm
  zen exec -e '<ts>' | zen exec <file.ts>        Run TS with rpc/events pre-opened
  zen profile [--duration <ms>] [--out <path>]   CPU profile the kernel main process
  zen profile heap [--out <path>]                Heap snapshot of the kernel main process

  zen build:source                               Transform user TS to .zenbu/source/ (no network)
  zen build:desktop                              Bundle launcher + seed -> dist/<name>.app
  zen publish:source [init|push]                 Push staged source to the mirror repo
  zen publish:desktop                            Upload the .app to a GitHub release

Open flags:
  --blocking           Keep zen attached to the Electron process
  --verbose            Print launch details
`)
}

async function main() {
  const argv = process.argv.slice(2)
  const first = argv[0]
  // Anything that isn't a known subcommand falls through to `open` — which
  // accepts a `[path]` positional (`zen .`, `zen /some/dir`) plus its own
  // flags. `open` validates the path and rejects unknown flags itself.
  if (!first || !SUBCOMMANDS.has(first)) {
    const { runOpen } = await import("./commands/open")
    await runOpen(argv)
    return
  }
  const rest = argv.slice(1)
  switch (first) {
    case "kyju":
      {
        const { runKyju } = await import("./commands/kyju")
      await runKyju(rest)
      }
      return
    case "link":
      {
        const { runLink } = await import("./commands/link")
      await runLink(rest)
      }
      return
    case "doctor":
      {
        const { runDoctor } = await import("./commands/doctor")
      await runDoctor(rest)
      }
      return
    case "config":
      {
        const { runConfig } = await import("./commands/config")
      await runConfig(rest)
      }
      return
    case "setup":
      {
        const { runSetup } = await import("./commands/setup")
      await runSetup(rest)
      }
      return
    case "init":
      {
        const { runInit } = await import("./commands/init")
      await runInit(rest)
      }
      return
    case "install":
      {
        const { runInstall } = await import("./commands/install")
      await runInstall(rest)
      }
      return
    case "exec":
      {
        const { runExec } = await import("./commands/exec")
      await runExec(rest)
      }
      return
    case "profile":
      {
        const { runProfile } = await import("./commands/profile")
      await runProfile(rest)
      }
      return
    case "db":
      {
        const { runDb } = await import("./commands/db")
      await runDb(rest)
      }
      return
    case "runtime":
      {
        const { runRuntime } = await import("./commands/runtime")
      await runRuntime(rest)
      }
      return
    case "setup-app":
      {
        const { runSetupApp } = await import("./commands/setup-app")
      await runSetupApp(rest)
      }
      return
    case "launch":
      {
        const { runOpenStandalone } = await import("./commands/open-standalone")
      await runOpenStandalone(rest)
      }
      return
    case "dev":
      {
        const { runDev } = await import("./commands/dev")
      await runDev(rest)
      }
      return
    case "build:source":
      {
        const { runBuildSource } = await import("./commands/build-source")
        await runBuildSource(rest)
      }
      return
    case "build:desktop":
      {
        const { runBuildDesktop } = await import("./commands/build-desktop")
        await runBuildDesktop(rest)
      }
      return
    case "publish:source":
      {
        const { runPublishSource } = await import("./commands/publish-source")
        await runPublishSource(rest)
      }
      return
    case "publish:desktop":
      {
        const { runPublishDesktop } = await import("./commands/publish-desktop")
        await runPublishDesktop(rest)
      }
      return
    case "help":
    case "--help":
    case "-h":
      printUsage()
      return
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
