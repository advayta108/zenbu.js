# Create a View

## What You're Doing

Creating a view — a frontend UI that runs as an iframe inside Zenbu. Each view is a tiny React app served by its own Vite dev server with full HMR. The view connects to the main process via WebSocket for RPC and Kyju (database) access.

The same template works for both kernel views (chat, workspace, orchestrator, …) and plugin views. Plugins live outside the kernel monorepo but share the kernel's Vite stack via a one-line config.

## Background

### What you get for free

Calling `defineZenbuViewConfig()` from the kernel (`packages/init/src/renderer/view-config.ts`) injects every plugin a view needs. There is **one** injection site for everything; the kernel-side `startRendererServer` only handles per-renderer runtime config (port, cacheDir, fs).

Each renderer (kernel + plugin) gets, automatically:

- **Tailwind v4** + shadcn theme variables + chat animations (via `@import "#zenbu/init/src/renderer/styles/app.css"` in your `app.css`).
- **Workspace theme support** — when the iframe URL has `?workspaceId=…` (which `<View>` always sets when mounting plugin iframes from inside a workspace), the workspace's `.zenbu/theme.css` is auto-injected as a `<link>` tag and overrides the shadcn defaults via cascade.
- **Advice + content scripts** — `advicePreludePlugin` injects the per-iframe prelude that wires up registered advice/content-script paths. `zenbuAdviceTransform` runs the babel transform on this renderer's source files. `resolveAdviceRuntime` aliases `@zenbu/advice/runtime` to the kernel source. You don't configure any of these.
- **Standard aliases**: `@` → kernel renderer dir, `#zenbu` → kernel packages dir.
- **`@vitejs/plugin-react` + `@tailwindcss/vite`** — resolved transitively from the kernel's `node_modules`. You do not install them in your plugin.

### Files you write

| File | Purpose |
|------|---------|
| `vite.config.ts` | One line. Imports `defineZenbuViewConfig` from the kernel. |
| `src/view/index.html` | Mount point + `<script src="/main.tsx">`. |
| `src/view/main.tsx` | `createRoot(...).render(<App />)`. |
| `src/view/App.tsx` | The view UI. Wraps in `<ViewProvider>` for WS/RPC/Kyju setup. |
| `src/view/app.css` | One line: imports the kernel preset. Plugin-specific styles below. |
| `src/services/<name>.ts` | Service that registers the view scope with `ViewRegistryService`. |

### How a view is mounted

1. A service registers the view's scope with `ViewRegistryService.register(scope, viewRoot, configFile)`.
2. The kernel's `ReloaderService` spins up a Vite dev server rooted at `viewRoot`. It always injects `themeStylesheetPlugin`, `advicePreludePlugin`, and the advice runtime/transform.
3. Some other view (orchestrator, workspace, …) mounts `<View id="…" scope="<scope>" props={{…}} />`. The `<View>` primitive looks up the scope in `viewRegistry`, builds the iframe URL with `?wsPort=…&wsToken=…&windowId=…&workspaceId=…&viewId=…&<your props>`, and mounts the iframe.
4. The iframe's React tree wraps everything in `<ViewProvider>`, which gates rendering on the WS connection and gives the subtree access to `useRpc()` / `useDb()` / `useKyjuClient()` / `useViewProps()`.

## Steps

### 1. `vite.config.ts`

```ts
import { defineZenbuViewConfig } from "../zenbu/packages/init/src/renderer/view-config"

export default defineZenbuViewConfig()
```

That's the whole file. The relative path is correct for any plugin sitting at `~/.zenbu/plugins/<name>/`. If your `index.html` lives in a subdir, add `root`:

```ts
import path from "node:path"
import { defineZenbuViewConfig } from "../zenbu/packages/init/src/renderer/view-config"

export default defineZenbuViewConfig({
  root: path.join(import.meta.dirname, "src", "view"),
})
```

`defineZenbuViewConfig({ ... })` accepts:
- `root?: string` — Vite project root.
- `plugins?: Plugin[]` — extra Vite plugins.
- `aliases?: Array<{ find, replacement }>` — extra resolve aliases (e.g. cross-plugin imports).
- `overrides?: UserConfig` — anything else (`optimizeDeps`, `build`, custom `dedupe`, …).

### 2. `src/view/index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My View</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

### 3. `src/view/main.tsx`

```tsx
import { createRoot } from "react-dom/client"
import { App } from "./App"
import "./app.css"

createRoot(document.getElementById("root")!).render(<App />)
```

### 4. `src/view/app.css`

```css
@import "#zenbu/init/src/renderer/styles/app.css";
```

That import gives you Tailwind v4, the shadcn theme variables, the chat animations, and the shared `@source` rules for utility scanning. Workspace `theme.css` overrides cascade in via the `<link>` tag the kernel injects. Add plugin-specific styles below the import.

If your view imports kernel React components that use Tailwind utilities, add `@source` lines pointing at those kernel dirs so their classes survive Tailwind's tree-shake:

```css
@import "#zenbu/init/src/renderer/styles/app.css";

@source "../../../zenbu/packages/init/src/renderer/components";
@source "../../../zenbu/packages/init/src/renderer/lib";
```

### 5. `src/view/App.tsx`

```tsx
import { ViewProvider, useViewProps } from "#zenbu/init/src/renderer/lib/View"
import { useDb } from "#zenbu/init/src/renderer/lib/kyju-react"
import { useRpc } from "#zenbu/init/src/renderer/lib/providers"

function MyViewContent() {
  const props = useViewProps()
  const rpc = useRpc()
  const things = useDb((root) => root.plugin["my-view"]?.things ?? [])

  return (
    <div className="flex h-full items-center justify-center bg-(--zenbu-panel) text-(--foreground)">
      <p>workspace: {props.workspaceId} — {things.length} things</p>
    </div>
  )
}

export function App() {
  return (
    <ViewProvider fallback={<div className="h-full bg-(--zenbu-panel)" />}>
      <MyViewContent />
    </ViewProvider>
  )
}
```

What `<ViewProvider>` does:
- Opens a WebSocket using `?wsPort=` + `?wsToken=` from the URL.
- Provides `RpcProvider`, `EventsProvider`, `KyjuClientProvider`, `KyjuProvider` to children.
- Reads `?viewId=` from the URL and exposes the view's full props bag (URL query + Kyju row override) via `useViewProps()`. The bag includes `windowId`, `workspaceId`, `viewId`, plus any caller-passed props.

### 6. `src/services/<name>.ts`

```ts
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Service, runtime } from "#zenbu/init/src/main/runtime"
import { ViewRegistryService } from "#zenbu/init/src/main/services/view-registry"

export class MyViewService extends Service {
  static key = "my-view"
  static deps = { viewRegistry: ViewRegistryService }
  declare ctx: { viewRegistry: ViewRegistryService }

  evaluate() {
    this.setup("register-view", () => {
      const serviceDir = path.dirname(fileURLToPath(import.meta.url))
      const viewRoot = path.resolve(serviceDir, "..", "view")
      const configFile = path.resolve(serviceDir, "..", "..", "vite.config.ts")

      this.ctx.viewRegistry.register("my-view", viewRoot, configFile, {
        sidebar: true,           // appear in the workspace's util sidebar rail
        // bottomPanel: true,    // appear in the workspace's bottom panel
        // workspaceId: "<id>"   // restrict to one workspace; usually omit
      })

      return () => this.ctx.viewRegistry.unregister("my-view")
    })
  }
}

runtime.register(MyViewService, import.meta)
```

`register(scope, viewRoot, configFile, meta?)` boots a Vite dev server rooted at `viewRoot` using the plugin's `vite.config.ts`, then writes a row into `kernel.viewRegistry` so other views can mount this scope via `<View scope="my-view" />`.

### 7. `package.json`

The plugin's `package.json` only declares its **runtime** deps (react, react-dom, anything you actually import in the view). Config-time tools (`vite`, `@vitejs/plugin-react`, `@tailwindcss/vite`, `tailwindcss`) come from the kernel's `node_modules` via `defineZenbuViewConfig` — do **not** add them here.

```json
{
  "name": "my-plugin",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "dependencies": {
    "react": "^19.2.4",
    "react-dom": "^19.2.4"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0"
  }
}
```

## Mounting Your View From the Workspace

Most views just need to be registered — the `workspace` iframe's util-sidebar rail (or the bottom panel, depending on what you set in `meta`) auto-includes them.

To mount a view from your own UI (e.g. tying it to a specific row in your data), use the `<View>` primitive:

```tsx
import { View } from "#zenbu/init/src/renderer/lib/View"

<View
  id={`my-view:${someId}`}    // stable cache key + (with persisted) kyju row id
  scope="my-view"
  props={{ thingId: someId }} // becomes useViewProps().thingId in the child
  pinned                       // immune from LRU eviction while visible
  // persisted                  // also write a row to kernel.views for restoration
/>
```

## Checklist

- [ ] `vite.config.ts` — one-line `defineZenbuViewConfig()` (with `root` if your `index.html` is in a subdir)
- [ ] `src/view/index.html` — `#root` div + `<script src="/main.tsx">`
- [ ] `src/view/main.tsx` — `createRoot(...).render(<App />)`
- [ ] `src/view/app.css` — `@import "#zenbu/init/src/renderer/styles/app.css"` (+ any plugin-specific styles below)
- [ ] `src/view/App.tsx` — wraps content in `<ViewProvider>`
- [ ] `src/services/<name>.ts` — `ViewRegistryService.register(scope, viewRoot, configFile, meta)`
- [ ] `package.json` — runtime deps only; no `vite`/`tailwindcss`/`@vitejs/plugin-react`/`@tailwindcss/vite`
