import { Service, runtime } from "#zenbu/init/src/main/runtime"
import { DbService } from "#zenbu/init/src/main/services/db"
import {
  makeAgentAppState,
  makeWorkspaceAppState,
  makeWorkspaceShellState,
} from "../../../shared/schema"

/**
 * Public RPC surface for agent-manager state. The renderer typically
 * writes its own state directly via the kyju client, but a few flows
 * (e.g. a future external orchestrator that wants to nudge the workspace
 * shell) prefer to go through RPC. Keep this thin — only methods that a
 * non-shell caller would legitimately want to invoke.
 */
export class AgentManagerService extends Service {
  static key = "agent-manager"
  static deps = { db: DbService }
  declare ctx: { db: DbService }

  /**
   * Mark an agent as just-viewed (clears its unread badge) or just-departed
   * (sets its lastViewedAt to `now`). Idempotent.
   */
  async markAgentViewed(args: {
    agentId: string
    departed?: boolean
  }): Promise<void> {
    const { agentId, departed } = args
    const client = this.ctx.db.client
    await client.update((root) => {
      const am = root.plugin["agent-manager"]
      const cur = am.agentState[agentId]
      const next = departed ? Date.now() : null
      am.agentState = {
        ...am.agentState,
        [agentId]: cur
          ? { ...cur, lastViewedAt: next }
          : makeAgentAppState(agentId, { lastViewedAt: next }),
      }
    })
  }

  /**
   * Toggle / set the workspace shell's sidebar-open state. Identifies the
   * shell view by `workspace:${windowId}:${workspaceId}` (the same id the
   * workspace view derives from URL params). If `open` is omitted, toggles.
   */
  async setSidebar(args: {
    windowId: string
    workspaceId: string
    open?: boolean
  }): Promise<void> {
    const { windowId, workspaceId, open } = args
    const shellViewId = `workspace:${windowId}:${workspaceId}`
    const client = this.ctx.db.client
    await client.update((root) => {
      const am = root.plugin["agent-manager"]
      const cur = am.workspaceShellState[shellViewId]
      const nextOpen = open ?? !(cur?.sidebarOpen ?? true)
      const base = cur ?? makeWorkspaceShellState(shellViewId)
      am.workspaceShellState = {
        ...am.workspaceShellState,
        [shellViewId]: { ...base, sidebarOpen: nextOpen },
      }
    })
  }

  /**
   * Toggle / set the workspace shell's bottom panel. Stored on the
   * workspaceState record (per-workspace) since the bottom panel is
   * workspace-scoped, not shell-view-scoped.
   */
  async setBottomPanel(args: {
    workspaceId: string
    open?: boolean
    selected?: string | null
  }): Promise<void> {
    const { workspaceId, open, selected } = args
    const client = this.ctx.db.client
    await client.update((root) => {
      const am = root.plugin["agent-manager"]
      const cur = am.workspaceState[workspaceId]
      const base = cur ?? makeWorkspaceAppState(workspaceId)
      const nextOpen = open ?? !(cur?.bottomPanelOpen ?? false)
      const nextSelected =
        selected !== undefined ? selected : (cur?.bottomPanelSelected ?? null)
      am.workspaceState = {
        ...am.workspaceState,
        [workspaceId]: {
          ...base,
          bottomPanelOpen: nextOpen,
          bottomPanelSelected: nextSelected,
        },
      }
    })
  }

  evaluate() {}
}

runtime.register(AgentManagerService, import.meta)
