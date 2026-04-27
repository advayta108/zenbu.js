import path from "node:path"
import fsp from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Service, runtime } from "../runtime"
import { ReloaderService } from "./reloader"
import { mark } from "../../../shared/tracer"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rendererRoot = path.resolve(__dirname, "../../renderer")
const viteConfigPath = path.join(rendererRoot, "vite.config.ts")

export class CoreRendererService extends Service {
  static key = "reloader-shell"
  static deps = { reloader: ReloaderService }
  declare ctx: { reloader: ReloaderService }

  // what lol
  url = ""
  port = 0

  async evaluate() {
    let configFile: string | false = false
    try {
      await fsp.access(viteConfigPath)
      configFile = viteConfigPath
    } catch {}
    const entry = await this.trace("reloader-create", () =>
      this.ctx.reloader.create("core", rendererRoot, configFile),
    )
    this.url = entry.url
    this.port = entry.port
    mark("vite-ready", { url: this.url })
    console.log(`[core-renderer] ready at ${this.url}`)
  }
}

runtime.register(CoreRendererService, (import.meta as any).hot)
