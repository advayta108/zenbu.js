import { nanoid } from "nanoid"
import { makeCollection } from "@zenbu/kyju/schema"
import { Service, runtime } from "../runtime"
import { DbService } from "./db"
import { AgentService } from "./agent"
import {
  insertHotAgent,
  validSelectionFromTemplate,
  type ArchivedAgent,
} from "../../../shared/agent-ops"

/**
 * Backs `rpc.kernel.promoteNewAgentTab`: replaces a `new-agent:<nanoid>`
 * sentinel tab in a window's pane with a real agent + session. Prefers
 * the head of the warm pool (`PooledAgentService`); if the pool is empty
 * (e.g. cold start before the first refill, or the user opens new agents
 * faster than the pool can refill) it falls back to creating one inline.
 *
 * The new-agent onboarding view (`views/new-agent`) is rendered into the
 * sentinel tab. When the user submits a message there, the renderer calls
 * this method to swap the sentinel for a real chat session in the same
 * pane slot, then sends the prompt over `rpc.agent.send`.
 */
export class NewAgentService extends Service {
  static key = "new-agent"
  static deps = { db: DbService, agent: AgentService }
  declare ctx: { db: DbService; agent: AgentService }

  async promoteNewAgentTab(args: {
    windowId: string
    sentinelTabId: string
    cwd?: string
    workspaceId?: string
  }): Promise<{ agentId: string; sessionId: string }> {
    const { windowId, sentinelTabId, cwd, workspaceId } = args
    const client = this.ctx.db.client
    const kernel = client.readRoot().plugin.kernel as any

    const head = (kernel.pool ?? [])[0] as
      | { agentId: string; sessionId: string }
      | undefined

    if (head) {
      return await this.promoteFromPool({
        head,
        windowId,
        sentinelTabId,
        cwd,
        workspaceId,
      })
    }

    return await this.promoteInline({
      windowId,
      sentinelTabId,
      cwd,
      workspaceId,
    })
  }

  /**
   * Atomic update: pop pool head, swap sentinel tabId for sessionId in
   * the pane, append the session row. If the user picked a cwd different
   * from the pool agent's seed, write it through `agent.changeCwd` after
   * the swap so the running process picks it up before the renderer's
   * subsequent `rpc.agent.send` lands.
   *
   * The race guard inside the update transaction protects against another
   * promote / pool prune landing between read and write.
   */
  private async promoteFromPool(args: {
    head: { agentId: string; sessionId: string }
    windowId: string
    sentinelTabId: string
    cwd?: string
    workspaceId?: string
  }): Promise<{ agentId: string; sessionId: string }> {
    const { head, windowId, sentinelTabId, cwd, workspaceId } = args
    const client = this.ctx.db.client
    const { agentId, sessionId } = head

    await client.update((root: any) => {
      const k = root.plugin.kernel
      if (k.pool[0]?.agentId !== agentId) {
        throw new Error("[new-agent] pool head changed mid-promote")
      }
      k.pool = k.pool.slice(1)

      // The pool agent was created without a workspace binding; apply
      // the caller's workspaceId now so the sidebar groups it correctly.
      if (workspaceId) {
        const a = k.agents.find((x: any) => x.id === agentId)
        if (a) a.workspaceId = workspaceId
      }

      const ws = k.windowStates.find((w: any) => w.id === windowId)
      if (!ws) return
      ws.sessions = [
        ...ws.sessions,
        { id: sessionId, agentId, lastViewedAt: null },
      ]
      const pane = ws.panes.find((p: any) =>
        (p.tabIds ?? []).includes(sentinelTabId),
      )
      if (!pane) return
      const idx = pane.tabIds.indexOf(sentinelTabId)
      if (idx < 0) return
      const next = [...pane.tabIds]
      next[idx] = sessionId
      pane.tabIds = next
      if (pane.activeTabId === sentinelTabId) pane.activeTabId = sessionId
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

    return { agentId, sessionId }
  }

  /**
   * Fallback when the pool is empty. Creates a fresh agent + session and
   * fires `agent.init` async — same shape as the pre-pool implementation,
   * kept so an empty pool degrades to the old behavior instead of throwing.
   */
  private async promoteInline(args: {
    windowId: string
    sentinelTabId: string
    cwd?: string
    workspaceId?: string
  }): Promise<{ agentId: string; sessionId: string }> {
    const { windowId, sentinelTabId, cwd, workspaceId } = args
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
    const sessionId = nanoid()
    const seeded = validSelectionFromTemplate(selectedConfig)

    let evicted: ArchivedAgent[] = []
    await client.update((root: any) => {
      evicted = insertHotAgent(root.plugin.kernel, {
        id: agentId,
        name: selectedConfig.name,
        startCommand: selectedConfig.startCommand,
        configId: selectedConfig.id,
        metadata: cwd ? { cwd } : {},
        workspaceId,
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

      const ws = root.plugin.kernel.windowStates.find(
        (w: any) => w.id === windowId,
      )
      if (!ws) return
      ws.sessions = [
        ...ws.sessions,
        { id: sessionId, agentId, lastViewedAt: null },
      ]
      const pane = ws.panes.find((p: any) =>
        (p.tabIds ?? []).includes(sentinelTabId),
      )
      if (!pane) return
      const idx = pane.tabIds.indexOf(sentinelTabId)
      if (idx < 0) return
      const next = [...pane.tabIds]
      next[idx] = sessionId
      pane.tabIds = next
      if (pane.activeTabId === sentinelTabId) pane.activeTabId = sessionId
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

    return { agentId, sessionId }
  }

  evaluate() {}
}

runtime.register(NewAgentService, (import.meta as any).hot)
