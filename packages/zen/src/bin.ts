#!/usr/bin/env bun
// zen CLI — hot-editable TypeScript source, interpreted by the bundled bun.
// Subcommand dispatcher. No positional subcommand = fall through to `open`
// (current behavior, backwards compatible).

import { runOpen } from "./commands/open"
import { runKyju } from "./commands/kyju"
import { runLink } from "./commands/link"
import { runDoctor } from "./commands/doctor"
import { runConfig } from "./commands/config"
import { runSetup } from "./commands/setup"
import { runInit } from "./commands/init"
import { runExec } from "./commands/exec"
import { runProfile } from "./commands/profile"
import { runDb } from "./commands/db"

const SUBCOMMANDS = new Set([
  "kyju",
  "link",
  "doctor",
  "config",
  "setup",
  "init",
  "exec",
  "profile",
  "db",
  "help",
  "--help",
  "-h",
])

function printUsage() {
  console.log(`
zen — Zenbu CLI

Usage:
  zen [path] [-r|-n] [-d <path>] [--blocking]    Open a workspace at path (default: cwd)
  zen kyju <generate|db> [...]                   Run the kyju CLI
  zen link                                       Regenerate registry types
  zen doctor                                     Re-run kernel setup.ts
  zen setup [--dir <path>]                       Run a plugin's setup.ts
  zen config <get|set> <key> [value]             Read/write CLI config
  zen db [list|add|default|remove] [...]         Manage DB paths (no args = interactive picker)
  zen init <plugin-name> [--dir <path>]          Scaffold a new plugin
  zen exec -e '<ts>' | zen exec <file.ts>        Run TS with rpc/events pre-opened
  zen profile [--duration <ms>] [--out <path>]   CPU profile the kernel main process
  zen profile heap [--out <path>]                Heap snapshot of the kernel main process

Open flags:
  -r, --reuse-window   Swap workspace on the last focused window
  -n, --new-window     Always open a new window
  -d, --db <path>      Use the DB at <path> for this launch (creates if missing)
`)
}

async function main() {
  const argv = process.argv.slice(2)
  const first = argv[0]
  // Anything that isn't a known subcommand falls through to `open` — which
  // accepts a `[path]` positional (`zen .`, `zen /some/dir`) plus its own
  // flags. `open` validates the path and rejects unknown flags itself.
  if (!first || !SUBCOMMANDS.has(first)) {
    await runOpen(argv)
    return
  }
  const rest = argv.slice(1)
  switch (first) {
    case "kyju":
      await runKyju(rest)
      return
    case "link":
      await runLink(rest)
      return
    case "doctor":
      await runDoctor(rest)
      return
    case "config":
      await runConfig(rest)
      return
    case "setup":
      await runSetup(rest)
      return
    case "init":
      await runInit(rest)
      return
    case "exec":
      await runExec(rest)
      return
    case "profile":
      await runProfile(rest)
      return
    case "db":
      await runDb(rest)
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
