// Back-compat surface: `@zenbujs/core/build` was the import path for
// `defineBuildConfig` / transforms before the unified `zenbu.config.ts`.
// The new canonical path is `@zenbujs/core/config`, but we keep the
// build-only re-exports here so existing user files importing from
// `@zenbujs/core/build` keep compiling during migration.

export {
  defineBuildConfig,
  resolveBuildConfig,
  type BuildConfig,
  type BundleConfig,
  type MirrorConfig,
  type ResolvedBuildConfig,
  type Transform,
  type TransformInput,
  type TransformOutput,
} from "./lib/build-config"
export { dropFiles, stripIfDisabled } from "./lib/transforms"
