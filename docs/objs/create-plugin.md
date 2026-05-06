# Create a Standalone Plugin

## What You're Doing

Creating a plugin in its own git repository that can be installed alongside the kernel. In Zenbu, the kernel itself is just a plugin—your plugin uses the exact same system.

## Background

### What Is a Plugin?

A plugin is a directory with a `zenbu.plugin.json` manifest that lists service files. When the manifest path is added to `~/.zenbu/config.json`, the shell's loader chain imports all listed service files, and each one registers with the shared `ServiceRuntime`.

### How Discovery Works

The shell reads `~/.zenbu/config.json`, which contains an array of absolute paths to `zenbu.plugin.json` manifests. For each manifest, the zenbu loader expands the `services` globs into side-effect imports:

```
config.json → zenbu:plugins (virtual module)
  → zenbu:barrel per manifest (virtual module)
    → import each service .ts file
      → runtime.register() in each file
```

All service files from all plugins share the same `ServiceRuntime` instance (`globalThis.__zenbu_service_runtime__`). Services from different plugins can depend on each other by key.

### The Loader Chain

Four loaders process every import in order:
1. **Zenbu loader** — resolves `zenbu:` virtual modules (config → manifest → barrel)
2. **TSX** — compiles TypeScript
3. **Advice** — Babel transform for function interception
4. **Dynohot** — HMR proxy wrapping + file watching

Your plugin code goes through all four, so it gets TypeScript support, advice transforms, and hot reloading automatically.

## Steps

### 1. Create the Repository Structure

```
my-plugin/
├── package.json
├── tsconfig.json
├── zenbu.plugin.json
├── setup.ts              (optional — run via bun by the installer)
└── src/
    └── services/
        └── my-service.ts
```

### 2. Write `zenbu.plugin.json`

```json
{
  "name": "my-plugin",
  "services": [
    "src/services/*.ts"
  ],
  "setup": {
    "script": "./setup.ts",
    "version": 1
  }
}
```

The `services` array supports:
- **Globs**: `"src/services/*.ts"` — all `.ts` files in the directory
- **Direct paths**: `"src/services/specific.ts"`
- **Nested manifests**: `"other/zenbu.plugin.json"` — recursively loads another manifest

The optional `setup` field declares a one-time host setup script. The runtime runs it via the cached bun binary when the declared `version` is greater than what's recorded in `~/.zenbu/.internal/plugin-setup-state.json` for this plugin. Bump `version` whenever your `setup.ts` needs to re-run on existing installs (new dependencies, new binaries to download, new host config, etc). Forward-only: rolling `version` back is a no-op.

A future `setup.permissions` field is planned as an extension point — plugin authors will declare the host capabilities the setup script needs (filesystem writes outside the plugin dir, network access, subprocess spawning), and the UI will confirm before running. Not implemented yet; setup runs unconditionally.

### 3. Write `package.json`

```json
{
  "name": "my-zenbu-plugin",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "dependencies": {}
}
```

The `package.json` is required because the shell uses it to find the project root (walks up from the manifest looking for `package.json`). This affects `process.cwd()` and TypeScript resolution.

If your plugin needs npm packages, add them as dependencies here.

### 4. Write `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

The shell finds the nearest `tsconfig.json` from the first plugin manifest and passes it to TSX.

### 5. Write Service Files

Service files follow the same pattern as kernel services. Import from the init package using the `#zenbu/` alias (resolved at runtime by the alias loader, and at type-check time by `tsconfig.local.json`):

```typescript
import { Service, runtime } from "#zenbu/init/src/main/runtime"
import { DbService } from "#zenbu/init/src/main/services/db"

export class MyPluginService extends Service {
  static key = "my-plugin-service"
  static deps = { db: DbService }
  declare ctx: { db: DbService }

  evaluate() {
    this.effect("setup", () => {
      console.log("[my-plugin] running")
      return () => console.log("[my-plugin] cleaning up")
    })
  }
}

runtime.register(MyPluginService, import.meta)
```

You can also depend on kernel services by string key to avoid import path issues:

```typescript
static deps = { db: "db" }
declare ctx: { db: any }
```

### 6. (Optional) Write `setup.ts`

If your plugin has one-time host setup (install deps, download binaries, configure external paths), write a `setup.ts` in the plugin root:

```typescript
#!/usr/bin/env bun
import { $ } from "bun"

await $`pnpm install`
// ... anything else your plugin needs once per machine ...
```

Register it in the manifest via `"setup": { "script": "./setup.ts", "version": 1 }`. The runtime spawns it via the bun binary in `~/Library/Caches/Zenbu/bin/bun` when:

- The plugin is freshly installed (no recorded version in state)
- The manifest's `version` is bumped above what the state file has recorded

When the script exits with code 0, the runtime records the new version. If the script happened to modify `pnpm-lock.yaml` inside your plugin's directory, the Updates UI shows a Relaunch button (new `node_modules` won't hot-reload cleanly; the app needs a restart to pick them up).

Scripts run as subprocesses so they never block the main electron thread.

### 7. Install the Plugin

See the `install-plugin` command. The short version: add the absolute path to your `zenbu.plugin.json` to `~/.zenbu/config.json`:

```json
{
  "plugins": [
    "/Users/you/.zenbu/plugins/zenbu/packages/init/zenbu.plugin.json",
    "/path/to/my-plugin/zenbu.plugin.json"
  ]
}
```

### Adding Views from a Plugin

See [`create-view`](./create-view.md) for the full template. The short version: plugins use `defineZenbuViewConfig()` to inherit the kernel's Vite stack (Tailwind, React, aliases) without installing those tools themselves, and `@import "#zenbu/init/src/renderer/styles/app.css"` in their CSS to inherit theme variables.

The view-registration service looks like:

```typescript
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Service, runtime } from "#zenbu/init/src/main/runtime"
import { ViewRegistryService } from "#zenbu/init/src/main/services/view-registry"

export class MyViewService extends Service {
  static key = "my-plugin-view"
  static deps = { viewRegistry: ViewRegistryService }
  declare ctx: { viewRegistry: ViewRegistryService }

  evaluate() {
    this.setup("register-view", () => {
      const serviceDir = path.dirname(fileURLToPath(import.meta.url))
      const viewRoot = path.resolve(serviceDir, "..", "view")
      const configFile = path.resolve(serviceDir, "..", "..", "vite.config.ts")
      this.ctx.viewRegistry.register("my-plugin-view", viewRoot, configFile, {
        sidebar: true,
      })
      return () => this.ctx.viewRegistry.unregister("my-plugin-view")
    })
  }
}
```

`register()` boots a Vite dev server rooted at `viewRoot`. The kernel's `themeStylesheetPlugin`, `advicePreludePlugin`, and advice runtime/transform are injected automatically into every plugin's Vite server — you don't add them yourself.

### Portable Resolution: How `#zenbu/` Works

Plugins are fully portable — they can live anywhere on the filesystem and work on any computer. This is achieved through three resolution layers:

**Main process (services):** The shell's alias loader intercepts `#zenbu/*` imports and resolves them to `~/.zenbu/plugins/zenbu/packages/*`. No hardcoded paths needed in plugin source.

**Renderer (views):** Plugins use [`defineZenbuViewConfig`](../../packages/init/src/renderer/view-config.ts) which provides the `@` and `#zenbu` aliases automatically. The whole `vite.config.ts` is two lines:

```typescript
import { defineZenbuViewConfig } from "../zenbu/packages/init/src/renderer/view-config"

export default defineZenbuViewConfig()
```

The helper resolves `@vitejs/plugin-react` and `@tailwindcss/vite` from the kernel's `node_modules` (via `createRequire` rooted at the kernel's `package.json`), so plugins don't install them.

**CSS (shadcn / theme vars):** Import the kernel's shared preset in your `app.css`:

```css
@import "#zenbu/init/src/renderer/styles/app.css";
```

That gives you Tailwind v4, all the `--zenbu-*` and shadcn theme vars, the chat animations, and the streamdown source scan. Workspace `theme.css` overrides cascade in via the `<link>` tag injected by `themeStylesheetPlugin`.

**TypeScript (IDE):** `tsconfig.local.json` is gitignored and generated per machine (by `setup.ts` or manually). It maps `#zenbu/*` to the local monorepo path for IDE type-checking.

## Checklist

- [ ] `zenbu.plugin.json` with `services` array
- [ ] `package.json` at the plugin root (runtime deps only — no `vite`/`tailwindcss`/`@vitejs/plugin-react`/`@tailwindcss/vite`)
- [ ] `tsconfig.json` extending `./tsconfig.local.json`
- [ ] `tsconfig.local.json` (gitignored, generated per machine)
- [ ] `vite.config.ts` — `defineZenbuViewConfig()` one-liner (only if plugin has views)
- [ ] `app.css` — `@import "#zenbu/init/src/renderer/styles/app.css"` (only if plugin has views)
- [ ] Service files that import from `#zenbu/init/...` and call `runtime.register()`
- [ ] Plugin manifest path added to `~/.zenbu/config.json`
