#!/usr/bin/env node

const PUBLIC_SUBCOMMANDS = new Set([
  "dev",
  "build:source",
  "build:electron",
  "publish:source",
  "link",
]);

const INTERNAL_SUBCOMMANDS = new Set(["monorepo", "db"]);

function printUsage() {
  console.log(`
zen — Zenbu CLI

Usage:
  zen dev                                Run the local app in Electron with HMR
  zen build:source                       Transform user TS into the staged
                                         source tree (default: .zenbu/build/source)
  zen build:electron [-- <eb args>]      Stage launcher + bundled bun/pnpm,
                                         then invoke electron-builder against
                                         the project's electron-builder config.
                                         Pass-through args after \`--\` go to
                                         electron-builder (e.g. \`-- --publish always\`).
  zen publish:source [init|push]         Push staged source to the mirror repo
  zen link                               Regenerate registry types from
                                         zenbu.config.ts
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (!first || first === "help" || first === "--help" || first === "-h") {
    printUsage();
    return;
  }

  if (!PUBLIC_SUBCOMMANDS.has(first) && !INTERNAL_SUBCOMMANDS.has(first)) {
    console.error(`zen: unknown command "${first}"`);
    console.error(`run \`zen --help\` to see available commands`);
    process.exit(1);
  }

  const rest = argv.slice(1);
  switch (first) {
    case "dev": {
      const { runDev } = await import("./commands/dev");
      await runDev(rest);
      return;
    }
    case "build:source": {
      const { runBuildSource } = await import("./commands/build-source");
      await runBuildSource(rest);
      return;
    }
    case "build:electron": {
      const { runBuildElectron } = await import("./commands/build-electron");
      await runBuildElectron(rest);
      return;
    }
    case "publish:source": {
      const { runPublishSource } = await import("./commands/publish-source");
      await runPublishSource(rest);
      return;
    }
    case "link": {
      const { runLink } = await import("./commands/link");
      await runLink(rest);
      return;
    }
    case "monorepo": {
      const { runMonorepo } = await import("./commands/monorepo");
      await runMonorepo(rest);
      return;
    }
    case "db": {
      const { runDb } = await import("./commands/db");
      await runDb(rest);
      return;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
