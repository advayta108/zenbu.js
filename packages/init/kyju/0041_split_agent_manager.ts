type MigrationOp =
  | { op: "add"; key: string; kind: "data"; hasDefault: boolean; default?: any }
  | { op: "add"; key: string; kind: "collection"; debugName?: string }
  | { op: "add"; key: string; kind: "blob"; debugName?: string }
  | { op: "remove"; key: string; kind: "collection" | "blob" | "data" }
  | { op: "alter"; key: string; changes: Record<string, any> }

type KyjuMigration = {
  version: number
  operations?: MigrationOp[]
  migrate?: (prev: any, ctx: { apply: (data: any) => any }) => any
}

// Splits agent-manager state out of kernel into the new
// `plugin["agent-manager"]` section. Per direction, no data is preserved
// — the moved kernel fields are simply removed.
//
// Removed from kernel:
//   - workspaceState           (moved to agent-manager)
//   - agentState               (moved to agent-manager)
//   - pool                     (moved to agent-manager)
//   - poolSize                 (moved to agent-manager)
//
// Altered:
//   - viewState                (sidebar/util/panel sub-fields removed; they
//                               moved to agent-manager.workspaceShellState)
//
// Added:
//   - workspaces[].viewScope   (defaults to "agent-manager"; lets each
//                               workspace declare which registered shell
//                               view to use)
const migration: KyjuMigration = {
  version: 41,
  operations: [
    { op: "remove", key: "workspaceState", kind: "data" },
    { op: "remove", key: "agentState", kind: "data" },
    { op: "remove", key: "pool", kind: "data" },
    { op: "remove", key: "poolSize", kind: "data" },
  ],
  migrate(prev, { apply }) {
    const result = apply(prev)

    // Strip the four shell-only sub-fields from every viewState row.
    if (result.viewState && typeof result.viewState === "object") {
      const next: Record<string, any> = {}
      for (const [id, vs] of Object.entries(result.viewState)) {
        if (!vs || typeof vs !== "object") {
          next[id] = vs
          continue
        }
        const slim = { ...(vs as Record<string, any>) }
        delete slim.sidebarOpen
        delete slim.tabSidebarOpen
        delete slim.sidebarPanel
        delete slim.utilitySidebarSelected
        next[id] = slim
      }
      result.viewState = next
    }

    // Add `viewScope: "agent-manager"` default to every existing workspace
    // entity so the orchestrator picks the right shell.
    if (Array.isArray(result.workspaces)) {
      result.workspaces = result.workspaces.map((w: any) =>
        w && typeof w === "object" && w.viewScope === undefined
          ? { ...w, viewScope: "agent-manager" }
          : w,
      )
    }

    return result
  },
}

export default migration
