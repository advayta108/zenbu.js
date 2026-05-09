#!/usr/bin/env node
// zen CLI — bundled by tsdown. Subcommands are imported lazily so one command
// does not pull the full surface into process startup.

const SUBCOMMANDS = new Set([
  "link",
  "install",
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
  zen launch [--blocking] [--runtime <ver>]      Run app with cached Electron runtime
  zen runtime [install|list|remove] [version]    Manage cached Electron runtimes
  zen setup-app [--name "App"] [--runtime <ver>] Build a /Applications/<name>.app from runtime cache
  zen link                                       Regenerate registry types
  zen db [list|add|default|remove|generate] [...] Manage DB paths or generate migrations
  zen install [path] [--force]                   Install app deps with managed pnpm
  zen dev <link|unlink> [monorepo-path]          Symlink/restore zenbu/ submodule for live monorepo edits

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
    case "link":
      {
        const { runLink } = await import("./commands/link")
      await runLink(rest)
      }
      return
    case "install":
      {
        const { runInstall } = await import("./commands/install")
      await runInstall(rest)
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
