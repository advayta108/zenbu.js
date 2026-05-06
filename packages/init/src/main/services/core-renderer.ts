import path from "node:path"
import fsp from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Service, runtime } from "../runtime"
import { ReloaderService } from "./reloader"
import { DbService } from "./db"
import { mark } from "../../../shared/tracer"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function resolveRendererRoot(): Promise<{ rendererRoot: string; configFile: string | false }> {
  const configPath = process.env.ZENBU_CONFIG_PATH
  if (configPath) {
    try {
      const config = JSON.parse(await fsp.readFile(configPath, "utf8"))
      const configDir = path.dirname(configPath)

      for (const manifestRel of config.plugins ?? []) {
        const resolvedManifest = path.resolve(configDir, manifestRel)
        try {
          const manifest = JSON.parse(await fsp.readFile(resolvedManifest, "utf8"))
          if (!manifest.uiEntrypoint) continue

          const projectDir = path.dirname(resolvedManifest)
          const rendererDir = path.resolve(projectDir, manifest.uiEntrypoint)
          const viteConfig = path.join(projectDir, "vite.config.ts")

          let cf: string | false = false
          try { await fsp.access(viteConfig); cf = viteConfig } catch {}
          try { await fsp.access(rendererDir) } catch { continue }

          console.log(`[core-renderer] using project renderer: ${rendererDir}`)
          return { rendererRoot: rendererDir, configFile: cf }
        } catch { continue }
      }

      const projectDir = configDir
      const rendererDir = path.resolve(projectDir, "src/renderer")
      const viteConfig = path.join(projectDir, "vite.config.ts")
      let cf: string | false = false
      try { await fsp.access(viteConfig); cf = viteConfig } catch {}
      try {
        await fsp.access(rendererDir)
        console.log(`[core-renderer] using default project renderer: ${rendererDir}`)
        return { rendererRoot: rendererDir, configFile: cf }
      } catch {}
    } catch {}
  }

  const fallback = path.resolve(__dirname, "../../renderer")
  const fallbackConfig = path.join(fallback, "vite.config.ts")
  let configFile: string | false = false
  try { await fsp.access(fallbackConfig); configFile = fallbackConfig } catch {}
  return { rendererRoot: fallback, configFile }
}

export class CoreRendererService extends Service {
  static key = "reloader-shell"
  static deps = { reloader: ReloaderService, db: DbService }
  declare ctx: { reloader: ReloaderService; db: DbService }

  url = ""
  port = 0

  async evaluate() {
    const { rendererRoot, configFile } = await resolveRendererRoot()
    const entry = await this.trace("reloader-create", () =>
      this.ctx.reloader.create("core", rendererRoot, configFile),
    )
    this.url = entry.url
    this.port = entry.port

    if (process.env.ZENBU_CONFIG_PATH) {
      await this.ctx.db.client.update((root) => {
        root.plugin.kernel.orchestratorViewPath = "/index.html"
      })
    }

    mark("vite-ready", { url: this.url })
    console.log(`[core-renderer] ready at ${this.url}`)
  }
}

runtime.register(CoreRendererService, import.meta)
