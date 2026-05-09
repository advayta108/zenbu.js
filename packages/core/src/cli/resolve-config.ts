#!/usr/bin/env node
// Resolves a project's `zenbu.config.ts` to the loader payload (plugins +
// appEntrypoint + pluginSourceFiles) and writes it to stdout as JSON.
//
// Spawned via `child_process.execFileSync` from `loaders/zenbu.ts` whenever
// dynohot invalidates the plugins root URL — Node's loader hooks run in a
// worker thread that can't `await import()` the user's TS config without
// deadlocking, so we shell out to a fresh process where tsx + dynamic import
// work normally.
//
// Argv: [node, this script, <projectDir>]

import { register } from "tsx/esm/api"
import { loadConfig } from "./lib/load-config"

async function main(): Promise<void> {
  register()

  const projectDir = process.argv[2]
  if (!projectDir) {
    process.stderr.write("usage: resolve-config <projectDir>\n")
    process.exit(2)
  }

  const { resolved, pluginSourceFiles } = await loadConfig(projectDir)
  const payload = {
    plugins: resolved.plugins.map((p) => ({
      name: p.name,
      dir: p.dir,
      services: p.services,
      schemaPath: p.schemaPath,
      migrationsPath: p.migrationsPath,
      preloadPath: p.preloadPath,
      eventsPath: p.eventsPath,
      icons: p.icons,
    })),
    appEntrypoint: resolved.uiEntrypointPath,
  }
  process.stdout.write(JSON.stringify({ payload, pluginSourceFiles }))
}

main().catch((err) => {
  process.stderr.write(
    `[zenbu resolve-config] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  )
  process.exit(1)
})
