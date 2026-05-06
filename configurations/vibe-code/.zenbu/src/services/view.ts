import path from "node:path"
import { fileURLToPath } from "node:url"
import { Service, runtime } from "#zenbu/init/src/main/runtime"
import { ViewRegistryService } from "#zenbu/init/src/main/services/view-registry"

export class BrowserViewService extends Service {
  static key = "browser-view"
  static deps = { viewRegistry: ViewRegistryService }
  declare ctx: { viewRegistry: ViewRegistryService }

  evaluate() {
    this.setup("register-view", () => {
      const serviceDir = path.dirname(fileURLToPath(import.meta.url))
      const viewRoot = path.resolve(serviceDir, "..", "view")
      const configFile = path.resolve(serviceDir, "..", "..", "vite.config.ts")

      this.ctx.viewRegistry.register("browser", viewRoot, configFile, {
        sidebar: true,
      })

      return () => {
        this.ctx.viewRegistry.unregister("browser")
      }
    })
  }
}

runtime.register(BrowserViewService, import.meta)
