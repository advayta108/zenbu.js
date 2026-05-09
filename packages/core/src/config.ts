// Public API surface of the unified Zenbu config. User code imports these
// from `@zenbujs/core/config`:
//
//   import { defineConfig, definePlugin, defineBuildConfig } from "@zenbujs/core/config"
//
// All three functions are pass-through identity — they exist only to
// provide TS inference + auto-import discoverability. Runtime resolution
// lives in `cli/lib/load-config.ts` (used by both the loader and the CLI).

export {
  defineConfig,
  definePlugin,
  defineBuildConfig,
  type Config,
  type ResolvedConfig,
  type Plugin,
  type ResolvedPlugin,
  type BuildConfig,
  type ResolvedBuildConfig,
  type BundleConfig,
  type MirrorConfig,
  type Transform,
  type TransformInput,
  type TransformOutput,
} from "./cli/lib/build-config"

export { dropFiles, stripIfDisabled } from "./cli/lib/transforms"
