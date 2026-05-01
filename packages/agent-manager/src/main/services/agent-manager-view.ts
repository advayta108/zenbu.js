import path from "node:path"
import fsp from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Service, runtime } from "#zenbu/init/src/main/runtime"
import { ReloaderService } from "#zenbu/init/src/main/services/reloader"
import { ViewRegistryService } from "#zenbu/init/src/main/services/view-registry"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
// __dirname = .../agent-manager/src/main/services
// renderer root = .../agent-manager/src/renderer
const rendererRoot = path.resolve(__dirname, "../../renderer")
const viteConfigPath = path.join(rendererRoot, "vite.config.ts")

const RELOADER_ID = "agent-manager-server"

/**
 * Owns the Vite dev server for the agent-manager package. One server, three
 * scopes:
 *
 *   agent-manager → /workspace (the workspace shell view)
 *   new-agent     → /new-agent
 *   plugins       → /plugins
 *
 * `reloader.create` is called directly so a single Vite instance backs all
 * three scopes; each scope is published via `viewRegistry.registerAlias`
 * so the renderer URL gets the correct path prefix. This replaces the old
 * `services/view-plugins.ts` in init that used to alias these three scopes
 * onto the core renderer.
 */
export class AgentManagerViewService extends Service {
  static key = "agent-manager-view"
  static deps = {
    reloader: ReloaderService,
    viewRegistry: ViewRegistryService,
  }
  declare ctx: {
    reloader: ReloaderService
    viewRegistry: ViewRegistryService
  }

  async evaluate() {
    let configFile: string | false = false
    try {
      await fsp.access(viteConfigPath)
      configFile = viteConfigPath
    } catch {}

    await this.trace("reloader-create", () =>
      this.ctx.reloader.create(RELOADER_ID, rendererRoot, configFile),
    )

    this.ctx.viewRegistry.registerAlias(
      "agent-manager",
      RELOADER_ID,
      "/workspace",
      { kind: "workspace-shell", label: "Agent Manager" },
    )
    this.ctx.viewRegistry.registerAlias(
      "new-agent",
      RELOADER_ID,
      "/new-agent",
      { label: "New Agent" },
    )
    this.ctx.viewRegistry.registerAlias(
      "plugins",
      RELOADER_ID,
      "/plugins",
      { label: "Plugins" },
    )
  }
}

runtime.register(AgentManagerViewService, (import.meta as any).hot)
