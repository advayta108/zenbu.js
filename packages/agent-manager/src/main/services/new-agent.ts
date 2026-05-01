import { nanoid } from "nanoid"
import { makeCollection } from "@zenbu/kyju/schema"
import { Service, runtime } from "#zenbu/init/src/main/runtime"
import { DbService } from "#zenbu/init/src/main/services/db"
import { AgentService } from "#zenbu/init/src/main/services/agent"
import {
  insertHotAgent,
  validSelectionFromTemplate,
  makeViewAppState,
  type ArchivedAgent,
} from "#zenbu/init/shared/agent-ops"
import { makeAgentAppState } from "../../../shared/schema"

/**
 * Backs `rpc["new-agent"].promoteNewAgentTab`: replaces a `new-agent`-scoped
 * sentinel view with a real chat-scoped view. Prefers the head of the
 * warm pool (`PooledAgentService`); if the pool is empty (e.g. cold start
 * before the first refill, or the user opens new agents faster than the
 * pool can refill) it falls back to creating one inline.
 *
 * The new-agent onboarding view (renderer/new-agent) is rendered into the
 * sentinel view. When the user submits a message there, the renderer calls
 * this method to swap the sentinel for a real chat view in the same window
 * slot, then sends the prompt over `rpc.agent.send`.
 *
 * Lives in agent-manager (not init) because pool, agentState, and the
 * promotion flow are workspace-shell concerns. Cross-section reads/writes
 * to kernel.{agents, agentConfigs, views, viewState, windowState} go
 * through `root.plugin.kernel.*`.
 */
export class NewAgentService extends Service {
  static key = "new-agent"
  static deps = { db: DbService, agent: AgentService }
  declare ctx: { db: DbService; agent: AgentService }

  async promoteNewAgentTab(args: {
    windowId: string
    sentinelViewId: string
    cwd?: string
    workspaceId?: string
  }): Promise<{ agentId: string; viewId: string }> {
    const { windowId, sentinelViewId, cwd, workspaceId } = args
    const client = this.ctx.db.client
    const am = client.readRoot().plugin["agent-manager"] as any

    const head = (am.pool ?? [])[0] as { agentId: string } | undefined

    if (head) {
      return await this.promoteFromPool({
        head,
        windowId,
        sentinelViewId,
        cwd,
        workspaceId,
      })
    }

    return await this.promoteInline({
      windowId,
      sentinelViewId,
      cwd,
      workspaceId,
    })
  }

  /**
   * Atomic update: pop pool head, replace the sentinel view's entity row
   * (in `kernel.views`) with a chat-scoped view referencing the popped
   * agent, and update the active-view pointer if the sentinel was active.
   * If the user picked a cwd different from the pool agent's seed, write
   * it through `agent.changeCwd` after the swap so the running process
   * picks it up before the renderer's subsequent `rpc.agent.send` lands.
   *
   * The race guard inside the update transaction protects against another
   * promote / pool prune landing between read and write.
   */
  private async promoteFromPool(args: {
    head: { agentId: string }
    windowId: string
    sentinelViewId: string
    cwd?: string
    workspaceId?: string
  }): Promise<{ agentId: string; viewId: string }> {
    const { head, windowId, sentinelViewId, cwd, workspaceId } = args
    const client = this.ctx.db.client
    const { agentId } = head
    const viewId = nanoid()

    await client.update((root) => {
      const k = root.plugin.kernel
      const am = root.plugin["agent-manager"]
      if (am.pool[0]?.agentId !== agentId) {
        throw new Error("[new-agent] pool head changed mid-promote")
      }
      am.pool = am.pool.slice(1)

      // Bind the agent to the active workspace (explicit, app-state).
      if (workspaceId) {
        const existing = am.agentState[agentId]
        am.agentState = {
          ...am.agentState,
          [agentId]: existing
            ? { ...existing, workspaceId }
            : makeAgentAppState(agentId, { workspaceId }),
        }
      }

      // Find the sentinel view and replace it with a chat-scoped view.
      const sentinelIdx = k.views.findIndex((v) => v.id === sentinelViewId)
      if (sentinelIdx === -1) return

      const sentinel = k.views[sentinelIdx]
      const sentinelOrder = k.viewState[sentinelViewId]?.order ?? 0

      const chatView = {
        id: viewId,
        windowId,
        parentId: sentinel.parentId ?? null,
        scope: "chat",
        props: { agentId },
        createdAt: Date.now(),
      }
      k.views = [
        ...k.views.slice(0, sentinelIdx),
        chatView,
        ...k.views.slice(sentinelIdx + 1),
      ]

      // Slim viewState: per-tab UX is just order/draft/load now. Sidebar
      // state lives on workspaceShellState (per-shell-view), so new chat
      // tabs don't carry shell-sidebar state.
      const nextViewState = { ...k.viewState }
      delete nextViewState[sentinelViewId]
      nextViewState[viewId] = makeViewAppState(viewId, {
        order: sentinelOrder,
      })
      k.viewState = nextViewState

      // If the sentinel was the active view, promote the new view.
      const ws = k.windowState[windowId]
      if (ws && ws.activeViewId === sentinelViewId) {
        k.windowState = {
          ...k.windowState,
          [windowId]: { ...ws, activeViewId: viewId },
        }
      }
    })

    // If the user picked a cwd different from the pool seed, propagate
    // it to the running process. `changeCwd` writes metadata.cwd and
    // tells the live Agent to update its session cwd. Skip the write
    // when they already match to avoid a no-op kyju update.
    if (cwd) {
      const current = (client.readRoot() as any).plugin.kernel.agents.find(
        (a: any) => a.id === agentId,
      )
      if (current?.metadata?.cwd !== cwd) {
        await this.ctx.agent.changeCwd(agentId, cwd).catch((err: unknown) => {
          console.error("[new-agent] changeCwd failed:", err)
        })
      }
    }

    return { agentId, viewId }
  }

  /**
   * Fallback when the pool is empty. Creates a fresh agent + view and
   * fires `agent.init` async — same shape as the pre-pool implementation,
   * kept so an empty pool degrades to the old behavior instead of throwing.
   */
  private async promoteInline(args: {
    windowId: string
    sentinelViewId: string
    cwd?: string
    workspaceId?: string
  }): Promise<{ agentId: string; viewId: string }> {
    const { windowId, sentinelViewId, cwd, workspaceId } = args
    const client = this.ctx.db.client
    const kernel = client.readRoot().plugin.kernel as any

    const configs = kernel.agentConfigs as any[]
    const selectedConfigId = kernel.selectedConfigId as string
    const selectedConfig =
      configs.find((c) => c.id === selectedConfigId) ?? configs[0]
    if (!selectedConfig) {
      throw new Error("[new-agent] no agentConfigs available")
    }

    const agentId = nanoid()
    const viewId = nanoid()
    const seeded = validSelectionFromTemplate(selectedConfig)

    let evicted: ArchivedAgent[] = []
    await client.update((root: any) => {
      const k = root.plugin.kernel
      const am = root.plugin["agent-manager"]
      evicted = insertHotAgent(k, {
        id: agentId,
        name: selectedConfig.name,
        startCommand: selectedConfig.startCommand,
        configId: selectedConfig.id,
        metadata: cwd ? { cwd } : {},
        eventLog: makeCollection({
          collectionId: nanoid(),
          debugName: "eventLog",
        }),
        status: "idle",
        ...seeded,
        title: { kind: "not-available" },
        reloadMode: "keep-alive",
        sessionId: null,
        firstPromptSentAt: null,
        createdAt: Date.now(),
        queuedMessages: [],
      })

      // Bind workspace if provided.
      if (workspaceId) {
        am.agentState = {
          ...am.agentState,
          [agentId]: makeAgentAppState(agentId, { workspaceId }),
        }
      }

      // Replace the sentinel view with a chat-scoped view.
      const sentinelIdx = k.views.findIndex(
        (v: { id: string }) => v.id === sentinelViewId,
      )
      if (sentinelIdx === -1) return

      const sentinel = k.views[sentinelIdx]
      const sentinelOrder = k.viewState[sentinelViewId]?.order ?? 0
      const chatView = {
        id: viewId,
        windowId,
        parentId: sentinel.parentId ?? null,
        scope: "chat",
        props: { agentId },
        createdAt: Date.now(),
      }
      k.views = [
        ...k.views.slice(0, sentinelIdx),
        chatView,
        ...k.views.slice(sentinelIdx + 1),
      ]

      const nextViewState = { ...k.viewState }
      delete nextViewState[sentinelViewId]
      nextViewState[viewId] = makeViewAppState(viewId, {
        order: sentinelOrder,
      })
      k.viewState = nextViewState

      const ws = k.windowState[windowId]
      if (ws && ws.activeViewId === sentinelViewId) {
        k.windowState = {
          ...k.windowState,
          [windowId]: { ...ws, activeViewId: viewId },
        }
      }
    })

    if (evicted.length > 0) {
      await client.plugin.kernel.archivedAgents
        .concat(evicted)
        .catch(() => {})
    }

    void this.ctx.agent
      .init(agentId)
      .catch((err) =>
        console.error("[new-agent] agent init failed:", err),
      )

    return { agentId, viewId }
  }

  evaluate() {}
}

runtime.register(NewAgentService, (import.meta as any).hot)
