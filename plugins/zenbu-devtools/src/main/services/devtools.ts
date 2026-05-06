import path from "node:path"
import { fileURLToPath } from "node:url"
import { Service, runtime } from "#zenbu/init/src/main/runtime"
import { ViewRegistryService } from "#zenbu/init/src/main/services/view-registry"
import { WindowService } from "#zenbu/init/src/main/services/window"
import { DbService } from "#zenbu/init/src/main/services/db"

export class DevtoolsService extends Service {
  static key = "devtools"
  static deps = { viewRegistry: ViewRegistryService, window: WindowService, db: DbService }
  declare ctx: { viewRegistry: ViewRegistryService; window: WindowService; db: DbService }

  private _isOpen = false

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

    const root = this.ctx.db.client.readRoot()
    const panelOpen = root.plugin?.devtools?.panelOpen ?? null
    const appConfig = (globalThis as any).__zenbu_app_config__ ?? {}
    const defaultOpen = appConfig.devtools?.defaultOpen ?? false
    const shouldOpen = panelOpen === null ? defaultOpen : panelOpen

    if (shouldOpen) {
      this._isOpen = true
      this.ctx.window.openSplitAll()
    }
  }

  togglePanel() {
    if (this._isOpen) {
      this._isOpen = false
      this.ctx.window.closeSplitAll()
    } else {
      this._isOpen = true
      this.ctx.window.openSplitAll()
    }
    this.ctx.db.client.update((root) => {
      if (!root.plugin.devtools) return
      root.plugin.devtools.panelOpen = this._isOpen
    })
  }
}

runtime.register(DevtoolsService, import.meta)
