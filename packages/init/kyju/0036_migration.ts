type MigrationOp =
  | { op: "add"; key: string; kind: "data"; hasDefault: boolean; default?: any }
  | { op: "add"; key: string; kind: "collection"; debugName?: string }
  | { op: "add"; key: string; kind: "blob"; debugName?: string }
  | { op: "remove"; key: string; kind: "collection" | "blob" | "data" }
  | { op: "alter"; key: string; changes: Record<string, any> };

type KyjuMigration = {
  version: number;
  operations?: MigrationOp[];
  migrate?: (prev: any, ctx: { apply: (data: any) => any }) => any;
};

const migration: KyjuMigration = {
  version: 37,
  operations: [
    {
      "op": "add",
      "key": "windows",
      "kind": "data",
      "hasDefault": true,
      "default": []
    },
    {
      "op": "add",
      "key": "windowState",
      "kind": "data",
      "hasDefault": true,
      "default": {}
    },
    {
      "op": "add",
      "key": "viewState",
      "kind": "data",
      "hasDefault": true,
      "default": {}
    },
    {
      "op": "add",
      "key": "agentState",
      "kind": "data",
      "hasDefault": true,
      "default": {}
    },
    {
      "op": "add",
      "key": "workspaceState",
      "kind": "data",
      "hasDefault": true,
      "default": {}
    },
    {
      "op": "remove",
      "key": "sessions",
      "kind": "data"
    },
    {
      "op": "remove",
      "key": "sidebarOpen",
      "kind": "data"
    },
    {
      "op": "remove",
      "key": "tabSidebarOpen",
      "kind": "data"
    },
    {
      "op": "remove",
      "key": "sidebarPanel",
      "kind": "data"
    },
    {
      "op": "remove",
      "key": "panes",
      "kind": "data"
    },
    {
      "op": "remove",
      "key": "rootPaneId",
      "kind": "data"
    },
    {
      "op": "remove",
      "key": "focusedPaneId",
      "kind": "data"
    },
    {
      "op": "remove",
      "key": "chatBlobs",
      "kind": "data"
    },
    {
      "op": "remove",
      "key": "composerDrafts",
      "kind": "data"
    },
    {
      "op": "remove",
      "key": "composerPending",
      "kind": "data"
    },
    {
      "op": "remove",
      "key": "windowStates",
      "kind": "data"
    },
    {
      "op": "remove",
      "key": "activeWorkspaceByWindow",
      "kind": "data"
    },
    {
      "op": "remove",
      "key": "sidebarOpenByWindow",
      "kind": "data"
    },
    {
      "op": "remove",
      "key": "lastTabByWorkspace",
      "kind": "data"
    },
    {
      "op": "remove",
      "key": "utilitySidebarSelectedByWindow",
      "kind": "data"
    },
    {
      "op": "alter",
      "key": "agents",
      "changes": {
        "typeHash": {
          "from": "1f9e5fea8a989198",
          "to": "ceb5cedb1114bbba"
        }
      }
    },
    {
      "op": "alter",
      "key": "views",
      "changes": {
        "typeHash": {
          "from": "66ddd94dc5c72abc",
          "to": "611dde5a4520f0af"
        }
      }
    },
    {
      "op": "alter",
      "key": "pool",
      "changes": {
        "typeHash": {
          "from": "cff2f62f742addd7",
          "to": "8a6b5de3771ce531"
        }
      }
    }
  ],
  migrate(prev, { apply }) {
    const result = apply(prev)
    const now = Date.now()

    // ------------------------------------------------------------------
    // Windows: split the old `windowStates[]` (entity+state hybrid) into
    // `windows[]` (entity) + `windowState` record (per-window app-state).
    // ------------------------------------------------------------------
    const prevWindowStates: any[] = Array.isArray(prev?.windowStates)
      ? prev.windowStates
      : []
    const prevActiveWorkspaceByWindow: Record<string, string> =
      prev?.activeWorkspaceByWindow ?? {}
    const prevSidebarOpenByWindow: Record<string, boolean> =
      prev?.sidebarOpenByWindow ?? {}
    const prevUtilitySidebarSelectedByWindow: Record<string, string> =
      prev?.utilitySidebarSelectedByWindow ?? {}

    result.windows = prevWindowStates.map((ws) => ({
      id: ws.id,
      persisted: !!ws.persisted,
    }))

    result.windowState = {}
    for (const ws of prevWindowStates) {
      // Pick activeViewId from the old single-leaf-pane's activeTabId.
      // Every real DB has exactly one leaf pane; if multiple, prefer the
      // one matching rootPaneId.
      const panes: any[] = Array.isArray(ws.panes) ? ws.panes : []
      const rootPane =
        panes.find((p) => p.id === ws.rootPaneId && p.type === "leaf") ??
        panes.find((p) => p.type === "leaf") ??
        null
      const activeViewId: string | null = rootPane?.activeTabId ?? null

      result.windowState[ws.id] = {
        windowId: ws.id,
        activeViewId,
        activeWorkspaceId: prevActiveWorkspaceByWindow[ws.id] ?? null,
      }
    }

    // ------------------------------------------------------------------
    // Views: convert each session + each sentinel-prefix tab id into a
    // typed View entity + ViewAppState record. Sidebar fields seed from
    // the source window's old sidebar state so the post-migration UX
    // matches what was visible before.
    // ------------------------------------------------------------------
    const newViews: any[] = []
    const newViewState: Record<string, any> = {}

    for (const ws of prevWindowStates) {
      const sessions: any[] = Array.isArray(ws.sessions) ? ws.sessions : []
      const panes: any[] = Array.isArray(ws.panes) ? ws.panes : []
      const rootPane =
        panes.find((p) => p.id === ws.rootPaneId && p.type === "leaf") ??
        panes.find((p) => p.type === "leaf") ??
        null
      const tabIds: string[] = Array.isArray(rootPane?.tabIds)
        ? rootPane.tabIds
        : []

      const sidebarSeed = {
        sidebarOpen:
          prevSidebarOpenByWindow[ws.id] ?? ws.sidebarOpen ?? false,
        tabSidebarOpen: ws.tabSidebarOpen ?? true,
        sidebarPanel: ws.sidebarPanel ?? "overview",
        utilitySidebarSelected:
          prevUtilitySidebarSelectedByWindow[ws.id] ?? null,
      }

      // Order is determined by tabIds position; sessions/sentinels not in
      // tabIds get appended to the end in their array order.
      const orderByTabId = new Map<string, number>()
      tabIds.forEach((tid, idx) => orderByTabId.set(tid, idx))
      let nextOrder = tabIds.length

      const seenIds = new Set<string>()

      const pushSession = (s: any) => {
        if (!s?.id) return
        if (seenIds.has(s.id)) return
        seenIds.add(s.id)
        const order = orderByTabId.get(s.id) ?? nextOrder++
        newViews.push({
          id: s.id,
          windowId: ws.id,
          parentId: null,
          scope: "chat",
          params: { agentId: s.agentId ?? "" },
          createdAt: now,
        })
        newViewState[s.id] = {
          viewId: s.id,
          draft: null,
          pendingCwd: null,
          order,
          ...sidebarSeed,
        }
      }
      for (const s of sessions) pushSession(s)

      // Sentinel tab ids that don't have a corresponding session row:
      // turn them into typed views by parsing the prefix.
      for (const tid of tabIds) {
        if (seenIds.has(tid)) continue
        let scope: string
        if (tid.startsWith("new-agent:")) scope = "new-agent"
        else if (tid.startsWith("scope:")) {
          const m = /^scope:([^:]+):/.exec(tid)
          scope = m?.[1] ?? "plugins"
        } else continue // unknown id with no session - skip
        seenIds.add(tid)
        const order = orderByTabId.get(tid) ?? nextOrder++
        newViews.push({
          id: tid,
          windowId: ws.id,
          parentId: null,
          scope,
          params: {},
          createdAt: now,
        })
        newViewState[tid] = {
          viewId: tid,
          draft: null,
          pendingCwd: null,
          order,
          ...sidebarSeed,
        }
      }
    }

    result.views = newViews
    result.viewState = newViewState

    // ------------------------------------------------------------------
    // Workspace state: fold lastTabByWorkspace into workspaceState.
    // ------------------------------------------------------------------
    const prevLastTabByWorkspace: Record<string, string> =
      prev?.lastTabByWorkspace ?? {}
    result.workspaceState = {}
    for (const [wsid, lastViewId] of Object.entries(prevLastTabByWorkspace)) {
      result.workspaceState[wsid] = {
        workspaceId: wsid,
        lastViewId: lastViewId ?? null,
      }
    }

    // ------------------------------------------------------------------
    // Agent state: per-agent UI state (lastViewedAt + workspaceId).
    //   - lastViewedAt = max(session.lastViewedAt across that agent's
    //     prior sessions). Defaults to null if no signal.
    //   - workspaceId carried forward from the dropped agent.workspaceId.
    // ------------------------------------------------------------------
    const prevAgents: any[] = Array.isArray(prev?.agents) ? prev.agents : []
    const lastViewedByAgent = new Map<string, number>()
    for (const ws of prevWindowStates) {
      const sessions: any[] = Array.isArray(ws.sessions) ? ws.sessions : []
      for (const s of sessions) {
        if (!s?.agentId || s.lastViewedAt == null) continue
        const cur = lastViewedByAgent.get(s.agentId) ?? -Infinity
        if (s.lastViewedAt > cur) {
          lastViewedByAgent.set(s.agentId, s.lastViewedAt)
        }
      }
    }
    result.agentState = {}
    for (const a of prevAgents) {
      if (!a?.id) continue
      const lvAt = lastViewedByAgent.get(a.id)
      result.agentState[a.id] = {
        agentId: a.id,
        lastViewedAt: typeof lvAt === "number" ? lvAt : null,
        workspaceId: typeof a.workspaceId === "string" ? a.workspaceId : null,
      }
    }

    // ------------------------------------------------------------------
    // Agent entity: drop `workspaceId` from each row. (`sessionId` stays.)
    // ------------------------------------------------------------------
    if (Array.isArray(result.agents)) {
      result.agents = result.agents.map((a: any) => {
        if (!a || typeof a !== "object") return a
        const { workspaceId: _drop, ...rest } = a
        return rest
      })
    }

    // ------------------------------------------------------------------
    // Pool entries: drop `sessionId` (pool entry becomes `{ agentId }`).
    // ------------------------------------------------------------------
    if (Array.isArray(result.pool)) {
      result.pool = result.pool.map((entry: any) => ({
        agentId: entry?.agentId ?? "",
      }))
    }

    // ------------------------------------------------------------------
    // Defensive registry seeding for the built-in scopes. ViewRegistryService
    // populates these at boot, but this avoids a startup race where a view
    // tries to render before the registry has resynced.
    // ------------------------------------------------------------------
    const registry: any[] = Array.isArray(result.viewRegistry)
      ? result.viewRegistry
      : []
    const ensureScope = (scope: string) => {
      if (registry.some((e) => e?.scope === scope)) return
      registry.push({
        scope,
        url: "",
        port: 0,
      })
    }
    ensureScope("chat")
    ensureScope("new-agent")
    result.viewRegistry = registry

    return result
  },
}

export default migration
