import fs from "node:fs"
import path from "node:path"

export type Manifest = {
  name: string
  services?: string[]
  schema?: string
  migrations?: string
  setup?: { script?: string; version?: number }
}

/** Walk up from `from` until we hit a `zenbu.plugin.json`. */
export function findManifest(from: string): string | null {
  let dir = path.resolve(from)
  while (true) {
    const candidate = path.join(dir, "zenbu.plugin.json")
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function readManifest(manifestPath: string): Manifest {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest
}
