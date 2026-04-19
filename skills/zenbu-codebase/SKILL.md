---
name: zenbu-codebase
description: ONLY use when the user explicitly wants to self-modify Zenbu itself (edit the app's source, write/change a Zenbu plugin, use the `zen` CLI), OR when the current working directory is inside `~/.zenbu/plugins/` (any plugin including `~/.zenbu/plugins/zenbu/`). Do NOT use for general coding tasks, other projects, or questions that happen to mention Zenbu in passing. When it does apply, read the full SKILL.md first to orient yourself — it indexes key files, directories, services, the `zen` CLI (including `zen init` recipes), and core concepts (loader chain, service system, plugin system, view system, Kyju reactive DB, agent system, advice, mode system, install model).
---

# Zenbu codebase index

Zenbu is an Emacs-inspired Electron desktop app where every piece of the running
app — including the kernel — is a hot-reloadable plugin. The user clones a git
repo (`~/.zenbu/plugins/zenbu/`) and modifies any file; dynohot swaps the module
live without restart.

> Authoritative reference: `~/.zenbu/plugins/zenbu/DOCS.md`. Read it in full
> the first time you touch anything non-trivial. This file points at specific
> parts.

## Repository layout

```
~/.zenbu/
├── config.jsonc                     # lists plugin manifests to load
├── registry/                        # generated; zen link writes these
│   ├── services.ts                  # typed ServiceRouter across all services
│   └── db-sections.ts               # typed DbRoot across all plugin sections
└── plugins/
    ├── zenbu/                       # the main monorepo (kernel + tooling)
    │   ├── apps/kernel/             # Electron shell (only precompiled code)
    │   ├── packages/                # see below
    │   ├── registry.jsonl           # plugin catalog (name, description, repo)
    │   ├── DOCS.md                  # full architecture doc
    │   └── packages/init/setup.ts   # idempotent first-run installer (run via bun)
    └── <third-party plugins>/       # each with its own zenbu.plugin.json
```

## Packages you will touch most

| Package | What it is | Start here |
|---|---|---|
| `packages/init` | **The main plugin.** All core services + the React renderer. | `src/main/services/`, `src/renderer/` |
| `packages/agent` | ACP client + Agent abstraction (Effect-based). Skills live here. | `src/agent.ts`, `src/skills/` |
| `packages/kyju` | Reactive SQLite-backed DB with cross-process replication. | `src/v2/db/`, `src/v2/client/` |
| `packages/advice` | Emacs-style function interception (Babel transform + runtime). | `src/node-loader.ts`, `src/runtime/` |
| `packages/dynohot` | ESM HMR. Rewrites imports into live proxies. | (rarely edited) |
| `packages/zenrpc` | Typed RPC over WebSocket. | `src/` |
| `packages/claude-acp`, `packages/codex-acp`, `packages/mock-acp` | ACP bridges to specific LLM backends | — |
| `packages/zen` | The `zen` CLI (hot-editable). | `src/bin.ts` |
| `packages/ui` | Shared React primitives. | — |

## The `zen` CLI — your main tool for plugin work

Source: `packages/zen/src/`. Shim at `~/.zenbu/bin/zen`. Hot-editable; edits
to `packages/zen/src/**/*.ts` take effect on the next `zen` invocation.

### Fast path: create a new plugin

```bash
zen init my-plugin                                  # minimal: one service
zen init my-plugin --with db                        # + kyju section
zen init my-plugin --with shortcut                  # + keyboard shortcut
zen init my-plugin --with advice                    # + component wrap/replace
zen init my-plugin --with view                      # + Vite-served React view
zen init my-plugin --with db,shortcut,advice,view   # compose any combo
zen init my-plugin --preset mega                    # all recipes at once
zen init my-plugin --dir /path/to/elsewhere
```

`zen init` does all of the following in one shot:

1. Scaffolds the **base layer** from `packages/zen/templates/plugin/base/`
   (manifest, package.json, tsconfig + tsconfig.local.json, setup.ts,
   README, .gitignore, one service stub). Then overlays any
   **recipe layers** from `packages/zen/templates/plugin/recipes/<recipe>/`.
   `zenbu.plugin.json` and `package.json` are generated programmatically so
   fields and deps reflect the selected recipes.
2. Runs the scaffolded `setup.ts` via the bundled bun (isolated pnpm).
3. Registers the plugin in `~/.zenbu/config.jsonc` — over RPC if the app is
   running, or writes the file directly if offline.
4. Runs `zen link` so the new plugin's service + schema types show up in
   `~/.zenbu/registry/{services,db-sections}.ts`.

After `zen init` the plugin is live. Edit `src/services/<name>.ts` and
dynohot hot-swaps on save; views/advice code pick up through Vite HMR.

**Recipes** — each is a self-contained template overlay, composable in any
combination. See `packages/zen/src/commands/init.ts` (`RECIPES`, `PRESETS`)
and `packages/zen/templates/plugin/recipes/<name>/` for the source of truth.

| Recipe | Adds | Use when |
|---|---|---|
| `db` | `src/schema.ts`, `kyju.config.ts`, `kyju/index.ts`; manifest `schema` + `migrations` fields | Plugin owns its own DB section (`root.plugin.<name>.*`) |
| `shortcut` | `src/services/shortcuts.ts` that calls `ShortcutService.register` | Plugin needs a keyboard binding |
| `advice` | `src/services/advice.ts` + `src/replacements/sample-wrapper.tsx`; calls `registerAdvice` | Plugin replaces/wraps a component in an existing view |
| `view` | `vite.config.ts`, `src/view/{index.html,main.tsx,App.tsx}`, `src/services/view.ts` that calls `ViewRegistryService.register` | Plugin ships its own Vite-served view |

To add a new recipe: drop a new dir under `packages/zen/templates/plugin/recipes/<name>/`
mirroring the output structure, add the name to `RECIPES` in `init.ts`,
and (if it needs new deps or manifest fields) extend `buildPackageJson` /
`buildManifest` in the same file.

### Subcommand reference

| Command | What it does |
|---|---|
| `zen` | Open a Zenbu window. Talks to the running app over zenrpc via `runtime.json` (WS port + pid); if nothing's running, spawns the Electron binary. |
| `zen [--agent <name>] [--resume] [--blocking]` | Same, with window-open flags. |
| `zen init <name> [--dir X]` | Scaffold a new plugin and register it. See above. |
| `zen setup [--dir .] [--reason "..."]` | Re-run a plugin's `setup.ts` via the bundled bun. If the app is running and the plugin is loaded, asks the UI to confirm a relaunch (pass `--reason` to display in the modal). |
| `zen link` | Regenerate `~/.zenbu/registry/{services,db-sections}.ts`. Run from any plugin dir; merges with other plugins' entries. |
| `zen kyju generate [--name tag]` | Diff current schema vs last snapshot, emit a migration + snapshot + journal entry. Run from a dir with a `kyju.config.ts`. |
| `zen kyju db <root\|collections\|collection\|...>` | Inspect the on-disk DB. |
| `zen doctor` | Re-run the kernel's `setup.ts` idempotently. Use after `git pull` pulls new setup steps, or after clearing `~/Library/Caches/Zenbu/`. |
| `zen config <get\|set> <key> [value]` | Read/write the zen-cli kyju section (`appPath` today). |

### "I want to … → run …"

| After this change | Run |
|---|---|
| Added/removed a public method on a `Service` | `zen link` (from the plugin dir) |
| Added/removed a whole service file | `zen link` |
| Edited a `createSchema({...})` field | `zen kyju generate` **then** `zen link` |
| Changed `package.json` (new dep, version bump) | `zen setup --dir <plugin>`; confirm the Relaunch modal |
| Changed `setup.ts` steps and want them re-run | Bump `setup.version` in the manifest, then `zen setup` |
| Edited any service/view/component source | Nothing — dynohot + Vite HMR pick it up |
| Cleared `~/Library/Caches/Zenbu/` or pulled a new core setup step | `zen doctor` |

### Cases to consider when scaffolding

- **Plugin name.** Must match `/^[a-z][a-z0-9-]*$/` (kebab-case). It becomes
  the `name` in the manifest, the kyju section key, the RPC namespace, and
  the service file name (`src/services/<name>.ts`). Derived variants used in
  templates: `PascalName`, `camelName`.
- **Dependencies.** The template ships `effect`, `nanoid`, `zod`. Add more
  to `package.json`, then `zen setup` — template uses
  `pnpm install --no-frozen-lockfile` so new deps don't fail on a stale
  lockfile.
- **Schema.** The stub has a `createSchema({ exampleCount, notes })`. After
  editing, you *must* `zen kyju generate` before the new field reads/writes
  work; and `zen link` so the type flows to `useDb()` callers.
- **Loading order.** Adding to `~/.zenbu/config.jsonc` triggers the zenbu
  loader to re-evaluate and import the new plugin. This happens within
  seconds of `zen init` — no restart unless `setup.ts` changed
  `node_modules`, which only matters on later `zen setup` calls (the first
  install happens before the plugin is loaded).
- **Restart prompts.** The frontend `CliRelaunchModal`
  (`packages/init/src/renderer/views/orchestrator/components/CliRelaunchModal.tsx`)
  subscribes to `events.cli.relaunchRequested`. `zen setup` surfaces its
  `--reason` string verbatim in that modal.
- **Third-party plugin checked into `~/.zenbu/plugins/<name>/`.** Not
  required — plugins can live anywhere; the config entry is an absolute path
  to the manifest. `zen init` puts them wherever `--dir` says.

### Recipes — concrete pointers for common plugin tasks

Each recipe names the **one file to open first**. Read that, mirror the
pattern.

**Register a keyboard shortcut.**
- Primitive: `ShortcutService.register({ id, defaultBinding, scope?, handler? })`
  in `packages/init/src/main/services/shortcut.ts:53`.
- Canonical example: `packages/init/src/main/services/focus-shortcuts.ts:14-61` —
  two registrations with handlers. Copy the structure.
- `scope` is a string matching a view scope (e.g. `"chat"`, `"orchestrator"`);
  omit for a global shortcut. Dispatch happens automatically — handlers run
  on the main process, or renderer-side via `useShortcutHandler({ scope, id })`
  in `packages/init/src/renderer/lib/shortcut-handler.ts:126` when you need
  DOM access.
- Key-combo syntax: modifiers + key, e.g. `"cmd+b"`, `"cmd+shift+k"`,
  `"cmd+/"`. See the kernel file above for the full grammar.

**Read or write application state.**
- Kernel schema (almost everything — sidebar, panes, views, modes, etc.):
  `packages/init/shared/schema/index.ts` (194 lines; fields listed at the
  top of the file).
- **Agent state lives in a separate schema.** `packages/agent/src/schema.ts`
  exports `agentSchemaFragment` + `agentSchema`. The kernel schema spreads
  `agentSchemaFragment` into its root, so `agents`, `agentConfigs`,
  `archivedAgents`, `hotAgentsCap`, `skillRoots` appear at
  `root.plugin.kernel.<field>`. Read/write agent fields there.
- From a service: `this.ctx.db.client.readRoot().plugin.kernel.foo` and
  `this.ctx.db.client.update(root => { root.plugin.kernel.foo = ... })`.
- From a view: `useDb(root => root.plugin.kernel.foo)`.

**Find where a view is rendered or its components live.**
- Orchestrator root + tab/pane layout: `packages/init/src/renderer/views/orchestrator/App.tsx`.
- Chat view (composer, display, combobox, shortcuts input):
  `packages/init/src/renderer/views/chat/`.
- Agent switcher combobox component: `packages/init/src/renderer/views/chat/components/Composer.tsx:285-356` (`AgentConfigCombobox`).
- Settings view: `packages/init/src/renderer/views/settings/`.

**Reuse an existing minimal plugin as a template.**
- Tiniest service-only plugin: `~/.zenbu/plugins/minimap/src/services/minimap.ts`
  (26 lines — one advice replacement).
- Service + advice + RPC: `~/.zenbu/plugins/commit-button/src/services/commit-button.ts`
  (~100 lines).

**Where user (third-party) plugins live.** `~/.zenbu/plugins/<name>/` — each a
standalone repo with its own `zenbu.plugin.json`. Current installs:
`claude-plans, code-review, commit-button, event-log-viewer, file-viewer,
ghostty-terminal, git-viewer, injections, left-sidebar, minimap,
plan-comments, plan-viewer, recent-agents, sidebar, tab-orchestrator,
vercel-viewer`. The `zenbu` dir under there is the kernel monorepo — don't
confuse it with a user plugin.

**Replace or wrap a component without forking.** Use `registerAdvice(scope, {
moduleId, name, type: "replace" | "around", modulePath, exportName })` from
`packages/init/src/main/services/advice-config.ts`. The `moduleId` is the
target file's path relative to the view's Vite root
(`packages/init/src/renderer/`).

**Inject a content script into a view.** `registerContentScript(scope,
absolutePath)` from the same file. Scope `"*"` targets every view.

### CLI ↔ app transport (for when you edit the CLI itself)

- App-side: `packages/init/src/main/services/cli.ts` — `CliService`
  (public methods auto-exposed as `rpc.cli.*`). Writes
  `~/.zenbu/.internal/runtime.json` on every evaluate with
  `{ wsPort, dbPath, pid }`.
- CLI-side: `packages/zen/src/lib/rpc.ts` — `connectCli()` reads
  `runtime.json`, opens a WebSocket, calls `connectRpc<ServiceRouter>()`.
  Returns `null` if the app isn't running; commands should fall back or
  bail with a clear message.
- To add a new CLI command that needs app state: add a method to
  `CliService`, run `zen link`, call it from a new `packages/zen/src/commands/*.ts`
  file via `conn.rpc.cli.yourMethod(...)`. Do not add hand-rolled socket
  protocols.

## Where specific functionality lives

### Services (main process)
`packages/init/src/main/services/` — every file is a `Service` subclass. Public
methods are auto-exposed as RPC namespaced by `static key`. Hot-reloads via
`runtime.register(Cls, import.meta.hot)` at the bottom of each file.

| Concern | File |
|---|---|
| Database + sections + migration discovery | `db.ts` |
| HTTP + WebSocket server | `server.ts`, `http.ts` |
| Typed RPC auto-router | `rpc.ts` |
| Electron windows, dock, menus | `window.ts` |
| Vite dev servers for views | `reloader.ts` |
| View ↔ scope registry | `view-registry.ts` |
| The core (orchestrator+views) Vite server | `core-renderer.ts` |
| Agent lifecycle, ACP proxying, first-prompt skill preamble | `agent.ts` |
| Plugin installer (clones repo, runs setup.ts) | `installer.ts` |
| Advice + content script config | `advice-config.ts` |
| CLI RPC (`zen` commands ↔ running app over zenrpc) | `cli.ts`, `cli-intent.ts` |
| Keyboard shortcuts (register, dispatch, per-scope routing) | `shortcut.ts`, `focus-shortcuts.ts` |
| File scanner (non-gitignore-aware today) | `file-scanner.ts` |

The Service base class + DAG initializer lives at
`packages/init/src/main/runtime.ts`.

### Renderer (orchestrator + views)
`packages/init/src/renderer/`

| Concern | Location |
|---|---|
| Orchestrator root UI (iframe host, tabs, panes) | `orchestrator/App.tsx` |
| Chat view | `views/chat/` (components, plugins, ChatDisplay.tsx, Composer.tsx) |
| Minimap | `views/chat/components/MinimapContent.tsx` |
| Settings view | `views/settings/` |
| Shared hooks / providers (`useRpc`, `useDb`) | `lib/providers.ts`, `lib/ws-connection.ts` |
| Frontend advice registration | `orchestrator/advice/` |

Every view is a Vite-served page loaded in an iframe; it connects back to the
kernel over a single WebSocket that multiplexes `{ ch: "rpc" }` and
`{ ch: "db" }` frames.

### Schema + DB
- **Kernel schema** (sidebar, panes, views, modes, shortcut registry, chat, …):
  `packages/init/shared/schema/index.ts`. Migrations in `packages/init/kyju/`.
- **Agent schema** is authored in `packages/agent/src/schema.ts` and spread
  into the kernel root via `agentSchemaFragment` — so `root.plugin.kernel.agents`,
  `.agentConfigs`, `.archivedAgents`, `.hotAgentsCap`, `.skillRoots` all read
  from the kernel section but the field definitions live in the agent package.
- Third-party plugins get their own section at `root.plugin.<plugin-name>.*`
  from their own `schema.ts`.
- CLI: `zen kyju generate` (diff schema → new migration) and `zen kyju db <...>`
  for inspection.
- Kyju primitives live in `packages/kyju/src/v2/db/schema.ts` — `f.array`,
  `f.record`, `f.collection`, `f.blob`, `makeCollection(...)` for preallocating
  nested collection refs.

### Agents
- `packages/agent/src/agent.ts` — the `Agent` class (Effect-based lifecycle, ACP
  session management, event log, first-prompt preamble latch).
- `packages/agent/src/client.ts` — `AcpClient` (spawns subprocess, NDJSON).
- `packages/agent/src/skills/` — skill discovery (open spec `SKILL.md`,
  gitignore-aware) + routing-metadata formatter.
- `packages/init/src/main/services/agent.ts` — `AgentService`: process registry,
  config-option fanout, first-prompt latch (reads/writes `agent.firstPromptSentAt`
  on the DB record), default `skillRoots → ~/.zenbu/skills`.

### Advice + content scripts
- Transform: `packages/advice/src/node-loader.ts`, `src/vite-plugin.ts`
- Runtime: `packages/advice/src/runtime/`
- Plugin API: `packages/init/src/main/services/advice-config.ts`
  (`registerAdvice`, `registerContentScript`)

### Modes
- Schema fields: `majorMode: string`, `minorModes: string[]` on the kernel root.
- Read/write from anywhere that has the DB client.

## Philosophy — things that are load-bearing

1. **Every module is hot-reloadable.** Avoid module-level mutable state; put it
   in `Service` effects so cleanup runs on re-evaluation. Don't cache
   import-time values that should change on edit.
2. **Services wire themselves.** Don't write routers by hand; add a public
   method to a `Service` and it's automatically RPC-accessible after
   `zen link` regenerates types.
3. **The DB is the bus.** Main ↔ renderer sync is through Kyju, not `ipcMain`.
   If you need a view to react to main-process state, put it in the schema.
4. **Plugins get equal footing with the kernel.** The kernel is a plugin; it
   uses the same manifest + section system as third parties. Don't build
   special paths that only the kernel can take.
5. **Commit messages and code comments are instructions to future merge
   agents.** Pulls that conflict will be resolved by an LLM reading the
   history; explicit intent matters.

## Portability

- Zenbu ships its own `bun` + `pnpm` at `~/Library/Caches/Zenbu/bin/`.
  Set by `bootstrapEnv` in `apps/kernel/src/shell/env-bootstrap.ts`.
- Hard user-system deps: only Xcode Command Line Tools (git + bash).
- User overrides: `ZENBU_BUN`, `ZENBU_PNPM`, `ZENBU_GIT` env vars.
- All plugin `setup.ts` scripts inherit the isolated toolchain env.
- Every plugin's `setup.ts` must be idempotent and use the `##ZENBU_STEP:`
  protocol for progress reporting.

## Conventions — things to do (or not) when editing

- **Use `ni`** to install packages (auto-detects pnpm/npm/bun). Never run
  `npm install` / `pnpm install` directly in a plugin dir — prefer
  `zen setup` for plugin deps so the Relaunch bridge fires.
- **Don't start the dev server** — assume the user already has it running.
  Zenbu hot-reloads on file save, main process included. If you break a file,
  the app breaks. Make incremental edits that leave the system in a valid state
  at every save.
- **Which zen command to run after a change** — see the "I want to … → run …"
  table in the `zen` CLI section above.
- Plugin registry lives at `packages/zenbu/registry.jsonl` (newline-delimited
  JSON). To publish, PR a line with your plugin's git URL.

## Known gaps / future work

Documented at the bottom of `DOCS.md`:
- Service `setup()` method for first-time plugin installation.
- Commit-hash pinning in `registry.jsonl`.
- Orchestrator slot system (so views declare where they render).
- Dynamic code execution into a view's iframe (chrome.tabs.executeScript analog).
- Agent-assisted merge conflict resolution on `git pull`.
