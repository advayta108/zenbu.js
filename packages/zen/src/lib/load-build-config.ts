import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"
import { resolveBuildConfig, type BuildConfig, type ResolvedBuildConfig } from "./build-config"

const localRequire = createRequire(import.meta.url)

const CONFIG_NAMES = ["zenbu.build.ts", "zenbu.build.mts", "zenbu.build.js", "zenbu.build.mjs"]

export function findBuildConfig(projectDir: string): string {
  for (const name of CONFIG_NAMES) {
    const candidate = path.join(projectDir, name)
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error(
    `No zenbu.build config found at ${projectDir}. Expected one of: ${CONFIG_NAMES.join(", ")}`,
  )
}

let tsxRegistered: Promise<void> | null = null

function ensureTsxRegistered(): Promise<void> {
  if (tsxRegistered) return tsxRegistered
  tsxRegistered = (async () => {
    try {
      const tsxApi: { register?: () => unknown } = localRequire("tsx/esm/api")
      if (typeof tsxApi.register === "function") tsxApi.register()
    } catch {
      // tsx not available — caller's TS files must already be transpiled.
    }
  })()
  return tsxRegistered
}

export async function loadBuildConfig(configPath: string): Promise<ResolvedBuildConfig> {
  await ensureTsxRegistered()
  const absPath = path.resolve(configPath)
  const mod = await import(pathToFileURL(absPath).href)
  const config = (mod.default ?? mod) as BuildConfig
  if (!config || !Array.isArray(config.include)) {
    throw new Error(
      `${path.basename(configPath)} must export a config object (via defineBuildConfig) with an 'include' array.`,
    )
  }
  return resolveBuildConfig(config)
}
