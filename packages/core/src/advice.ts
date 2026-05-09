/**
 * Public API for plugin authors who want to inject content scripts or
 * advise (wrap/replace) renderer-side functions.
 *
 *   import {
 *     registerContentScript,
 *     registerAdvice,
 *   } from "@zenbujs/core/advice"
 *
 *   evaluate() {
 *     this.setup("inject", () =>
 *       registerContentScript("app", "src/content/clock.tsx", import.meta),
 *     )
 *     this.setup("wrap", () =>
 *       registerAdvice(
 *         "app",
 *         {
 *           moduleId: "App.tsx",
 *           name: "Counter",
 *           type: "around",
 *           modulePath: "src/content/wrap-counter.tsx",
 *           exportName: "WrapCounter",
 *         },
 *         import.meta,
 *       ),
 *     )
 *   }
 *
 * The third `import.meta` argument lets us anchor relative paths against
 * the plugin's root (the folder containing `zenbu.plugin.json`). Absolute
 * paths are also accepted, but the plugin-relative form keeps service
 * files free of `path.resolve(fileURLToPath(...))` boilerplate.
 *
 * Both functions return an unregister function suitable for use as a
 * `setup()` cleanup, so they hot-reload cleanly along with the service.
 */
export {
  registerAdvice,
  registerContentScript,
  type AdviceSpec,
  type ViewAdviceEntry,
} from "./services/advice-config";

/**
 * Read-side accessors for tools that introspect what's currently registered
 * for a given view scope (devtools, debug overlays, etc.). These are pure
 * reads against the in-memory registries; they don't trigger reload.
 */
export {
  getAdvice,
  getAllAdviceScopes,
  getContentScripts,
  getAllContentScriptPaths,
  getAllScopes,
} from "./services/advice-config";
