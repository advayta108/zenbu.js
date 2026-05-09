export interface TransformInput {
  path: string
  code: string
}

export interface TransformOutput {
  code?: string
  drop?: boolean
}

export type Transform = (file: TransformInput) => TransformOutput | null | undefined | void

export interface MirrorConfig {
  target: string
  branch?: string
}

export interface BundleConfig {
  seed?: boolean
  extraResources?: string[]
}

export interface BuildConfig {
  source?: string
  out?: string
  include: string[]
  ignore?: string[]
  transforms?: Transform[]
  mirror?: MirrorConfig
  bundle?: BundleConfig
}

export function defineBuildConfig(config: BuildConfig): BuildConfig {
  return config
}

export type ResolvedBuildConfig = Required<Omit<BuildConfig, "mirror" | "bundle">> & {
  mirror?: MirrorConfig
  bundle?: BundleConfig
}

export function resolveBuildConfig(config: BuildConfig): ResolvedBuildConfig {
  return {
    source: config.source ?? ".",
    out: config.out ?? ".zenbu/build/seed",
    include: config.include,
    ignore: config.ignore ?? [],
    transforms: config.transforms ?? [],
    mirror: config.mirror,
    bundle: config.bundle,
  }
}
