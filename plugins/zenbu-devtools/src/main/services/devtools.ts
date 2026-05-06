import path from "node:path"
import { fileURLToPath } from "node:url"
import { nanoid } from "nanoid"
import { Service, runtime } from "#zenbu/init/src/main/runtime"
import { ViewRegistryService } from "#zenbu/init/src/main/services/view-registry"
import { WindowService } from "#zenbu/init/src/main/services/window"
import { DbService } from "#zenbu/init/src/main/services/db"
import { AgentService } from "#zenbu/init/src/main/services/agent"
import { insertHotAgent } from "#zenbu/init/shared/agent-ops"
import { makeCollection } from "#zenbu/kyju/src/v2/db/schema"

export class DevtoolsService extends Service {
  static key = "devtools"
  static deps = {
    viewRegistry: ViewRegistryService,
    window: WindowService,
    db: DbService,
    agent: AgentService,
  }
  declare ctx: {
    viewRegistry: ViewRegistryService
    window: WindowService
    db: DbService
    agent: AgentService
  }

  private _isOpen = false

  async evaluate() {
    const serviceDir = path.dirname(fileURLToPath(import.meta.url))
    const viewRoot = path.resolve(serviceDir, "../../renderer")
    const configFile = path.resolve(serviceDir, "../../../vite.config.ts")

    await this.ctx.viewRegistry.register("devtools", viewRoot, configFile)

    const initChatDir = path.resolve(serviceDir, "../../../../../packages/init/src/renderer")
    const initViteConfig = path.resolve(serviceDir, "../../../../../packages/init/src/renderer/vite.config.ts")
    const chatEntry = await this.ctx.viewRegistry.register("devtools-chat-server", initChatDir, initViteConfig)
    this.ctx.viewRegistry.registerAlias("devtools-chat", chatEntry.scope, "/views/chat")

    this.setup("split-panel", () => {
      return this.ctx.window.registerSplitPanel({
        name: "Devtools",
        scope: "devtools",
      })
    })

    if (this.ctx.db.client.readRoot().plugin.devtools.agents.length === 0) {
      await this.createAgent()
    }

    const root = this.ctx.db.client.readRoot()
    const panelOpen = root.plugin.devtools.panelOpen
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

  async createAgent(): Promise<string> {
    const root = this.ctx.db.client.readRoot()
    const kernel = root.plugin.kernel as any
    const configs = kernel.agentConfigs ?? []
    const selectedConfig =
      configs.find((c: any) => c.id === kernel.selectedConfigId) ?? configs[0]
    if (!selectedConfig) {
      throw new Error("No agent configs available")
    }

    const agentId = nanoid()

    await this.ctx.db.client.update((rootW) => {
      const k = rootW.plugin.kernel
      insertHotAgent(k, {
        id: agentId,
        name: `devtools-chat`,
        startCommand: selectedConfig.startCommand,
        configId: selectedConfig.id,
        metadata: {
          cwd: process.cwd(),
          systemPrompt: "",
        },
        // @ts-expect-error eventLog typing
        eventLog: makeCollection({
          collectionId: nanoid(),
          debugName: "devtools-chat-eventLog",
        }),
        status: "idle",
        model: selectedConfig.defaultConfiguration?.model,
        thinkingLevel: selectedConfig.defaultConfiguration?.thinkingLevel,
        mode: selectedConfig.defaultConfiguration?.mode,
        title: { kind: "set", value: "Devtools" },
        reloadMode: "keep-alive",
        sessionId: null,
        firstPromptSentAt: null,
        createdAt: Date.now(),
        queuedMessages: [],
      })
      rootW.plugin.devtools.agents.push({
        agentId,
        createdAt: Date.now(),
      })
    })

    this.ctx.agent.init(agentId).catch((err: unknown) => {
      console.error("[devtools] agent init failed:", err)
    })

    return agentId
  }

  async selectAgent(viewId: string, agentId: string): Promise<void> {
    await this.ctx.db.client.update((root) => {
      const dt = root.plugin.devtools
      const existing = dt.viewState[viewId]
      if (existing) {
        existing.activeAgentId = agentId
      } else {
        dt.viewState[viewId] = {
          viewId,
          sidebarOpen: false,
          activeAgentId: agentId,
        }
      }
    })
  }

  async toggleSidebar(viewId: string): Promise<void> {
    await this.ctx.db.client.update((root) => {
      const dt = root.plugin.devtools
      const existing = dt.viewState[viewId]
      if (existing) {
        existing.sidebarOpen = !existing.sidebarOpen
      } else {
        dt.viewState[viewId] = {
          viewId,
          sidebarOpen: true,
          activeAgentId: null,
        }
      }
    })
  }
}

runtime.register(DevtoolsService, import.meta)
