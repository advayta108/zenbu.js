import path from "node:path"
import { fileURLToPath } from "node:url"
import { Service, runtime } from "#zenbu/init/src/main/runtime"
import { ViewRegistryService } from "#zenbu/init/src/main/services/view-registry"
import { WindowService } from "#zenbu/init/src/main/services/window"

export class DevtoolsService extends Service {
  static key = "devtools"
  static deps = { viewRegistry: ViewRegistryService, window: WindowService }
  declare ctx: { viewRegistry: ViewRegistryService; window: WindowService }

  async evaluate() {
    const serviceDir = path.dirname(fileURLToPath(import.meta.url))
    const viewRoot = path.resolve(serviceDir, "../../renderer")
    const configFile = path.resolve(serviceDir, "../../../vite.config.ts")

    await this.ctx.viewRegistry.register("devtools", viewRoot, configFile)

    this.setup("split-panel", () => {
      return this.ctx.window.registerSplitPanel({
        name: "Devtools",
        scope: "devtools",
      })
    })
  }
}

runtime.register(DevtoolsService, import.meta)
