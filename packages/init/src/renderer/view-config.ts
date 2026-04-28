import path from "node:path"
import os from "node:os"
import { createRequire } from "node:module"
import { pathToFileURL, fileURLToPath } from "node:url"
import type { Plugin, UserConfig } from "vite"
import {
  themeStylesheetPlugin,
  advicePreludePlugin,
  resolveAdviceRuntime,
  zenbuAdviceTransform,
} from "./vite-plugins"

// ---------------------------------------------------------------------------
// defineZenbuViewConfig
//
// Single source of truth for every renderer Vite config in the system —
// kernel and plugin. Plugins write:
//
//   import { defineZenbuViewConfig } from "../zenbu/packages/init/src/renderer/view-config"
//   export default defineZenbuViewConfig()
//
// The kernel's own renderer config does the same thing with overrides:
//
//   export default defineZenbuViewConfig({
//     overrides: { build: { rollupOptions: { input: { ... } } } },
//   })
//
// What gets injected (every renderer, no opt-out):
//   - @vitejs/plugin-react       (JSX + React Fast Refresh)
//   - @tailwindcss/vite          (Tailwind v4 utility extraction)
//   - themeStylesheetPlugin      (global.css + workspace.css link tags)
//   - advicePreludePlugin        (per-iframe advice/content-script prelude)
//   - resolveAdviceRuntime       (alias `@zenbu/advice/runtime` to source)
//   - zenbuAdviceTransform       (babel transform wrapping top-level fns
//                                  with __def/__ref so advice can attach)
//   - Standard aliases: `@` (kernel renderer), `#zenbu` (kernel packages)
//   - HMR config matching the kernel's expectations
//
// Why those plugins resolve without per-plugin deps: at config-load time
// this file runs in the kernel Node process. `createRequire` rooted at
// the kernel's package.json walks the kernel's node_modules first, so
// `@vitejs/plugin-react` / `@tailwindcss/vite` resolve there. The four
// kernel-internal plugins (theme/advice/etc.) come from a sibling import
// (`./vite-plugins`).
//
// startRendererServer (services/reloader.ts) used to inject the four
// kernel-internal plugins itself; now it only handles per-renderer
// runtime config (port, cacheDir, fs.strict, …). One config injection
// path, used everywhere.
//
// CSS contract (plugins follow this in their app.css):
//   @import "#zenbu/init/src/renderer/styles/app.css";
// inherits Tailwind v4 + shadcn theme vars + chat animations + shared
// `@source` rules. Workspace `theme.css` overrides cascade in via the
// link tag injected by themeStylesheetPlugin.
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url))
// HERE = .../packages/init/src/renderer
const RENDERER_DIR = HERE
const INIT_PACKAGE_DIR = path.resolve(RENDERER_DIR, "..", "..")
const PACKAGES_DIR = path.resolve(INIT_PACKAGE_DIR, "..")

// createRequire rooted at the kernel's package.json so module resolution
// for `@vitejs/plugin-react` / `@tailwindcss/vite` walks the kernel's
// node_modules first. Hardcoded only on the homedir — same assumption
// the rest of the app already makes (every plugin uses the same path
// to compute `#zenbu`).
const KERNEL_PKG_JSON = path.join(INIT_PACKAGE_DIR, "package.json")
const requireFromKernel = createRequire(pathToFileURL(KERNEL_PKG_JSON).href)

// Vite plugins are CJS-default in their published shapes; default-export
// lives on the require result. Both packages publish a default function.
const reactPlugin = requireFromKernel("@vitejs/plugin-react").default ??
  requireFromKernel("@vitejs/plugin-react")
const tailwindPlugin = requireFromKernel("@tailwindcss/vite").default ??
  requireFromKernel("@tailwindcss/vite")

// Match what the homedir-based plugin layout assumes elsewhere.
const HOMEDIR_PACKAGES_DIR = path.join(
  os.homedir(),
  ".zenbu",
  "plugins",
  "zenbu",
  "packages",
)
const HOMEDIR_RENDERER_DIR = path.join(
  HOMEDIR_PACKAGES_DIR,
  "init",
  "src",
  "renderer",
)

export interface DefineZenbuViewConfigOptions {
  /** Plugin's project root (defaults to the dir of vite.config.ts).
   *  Set this if your `index.html` lives in a subdir like `src/view/`. */
  root?: string
  /** Extra Vite plugins appended after react() + tailwindcss(). */
  plugins?: Plugin[]
  /** Extra resolve aliases. `@` (kernel renderer) and `#zenbu` (kernel
   *  packages) are always provided. */
  aliases?: Array<{ find: string | RegExp; replacement: string }>
  /** Vite UserConfig overrides merged in last, for anything else
   *  (optimizeDeps, build, etc). */
  overrides?: UserConfig
}

export function defineZenbuViewConfig(
  opts: DefineZenbuViewConfigOptions = {},
): UserConfig {
  // We use the homedir-based paths in the alias targets because that's
  // where Vite (running the plugin's server) will be reading files from.
  // The kernel package may be loaded via a different path on disk inside
  // pnpm/dynohot, but for plugins the homedir layout is canonical.
  const baseAliases = [
    { find: "@", replacement: HOMEDIR_RENDERER_DIR },
    { find: "#zenbu", replacement: HOMEDIR_PACKAGES_DIR },
    ...(opts.aliases ?? []),
  ]

  const base: UserConfig = {
    ...(opts.root ? { root: opts.root } : {}),
    plugins: [
      reactPlugin(),
      tailwindPlugin(),
      themeStylesheetPlugin(),
      advicePreludePlugin(),
      resolveAdviceRuntime(),
      zenbuAdviceTransform(),
      ...(opts.plugins ?? []),
    ],
    resolve: {
      alias: baseAliases,
      dedupe: ["react", "react-dom"],
    },
    server: {
      hmr: { protocol: "ws", host: "localhost" },
      allowedHosts: true,
    },
  }

  if (!opts.overrides) return base
  return mergeShallow(base, opts.overrides)
}

function mergeShallow(a: UserConfig, b: UserConfig): UserConfig {
  return {
    ...a,
    ...b,
    plugins: [...(a.plugins ?? []), ...(b.plugins ?? [])],
    resolve: {
      ...(a.resolve ?? {}),
      ...(b.resolve ?? {}),
      alias: mergeAliases(a.resolve?.alias, b.resolve?.alias),
    },
    server: {
      ...(a.server ?? {}),
      ...(b.server ?? {}),
    },
  }
}

type AliasShape = NonNullable<NonNullable<UserConfig["resolve"]>["alias"]>

function mergeAliases(
  a: AliasShape | undefined,
  b: AliasShape | undefined,
): AliasShape {
  const aArr = toAliasArray(a)
  const bArr = toAliasArray(b)
  return [...aArr, ...bArr]
}

function toAliasArray(
  alias: AliasShape | undefined,
): Array<{ find: string | RegExp; replacement: string }> {
  if (!alias) return []
  if (Array.isArray(alias)) {
    return alias as Array<{ find: string | RegExp; replacement: string }>
  }
  return Object.entries(alias as Record<string, string>).map(
    ([find, replacement]) => ({ find, replacement }),
  )
}
