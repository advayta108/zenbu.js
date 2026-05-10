/**
 * back compat surface? delete me pls
 */
// Back-compat surface: `@zenbujs/core/build` was the import path for
// `defineBuildConfig` before the unified `zenbu.config.ts`. The new
// canonical path is `@zenbujs/core/config`, but we keep the build-only
// re-exports here so existing user files importing from
// `@zenbujs/core/build` keep compiling during migration.

export {
  defineBuildConfig,
  resolveBuildConfig,
  type BuildConfig,
  type BundleConfig,
  type MirrorConfig,
  type ResolvedBuildConfig,
  type BuildPlugin,
  type BuildContext,
  type EmitContext,
} from "./lib/build-config"
