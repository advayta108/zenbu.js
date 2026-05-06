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

const migration: KyjuMigration = {
  version: 43,
  operations: [
    { op: "remove", key: "workspaces", kind: "data" },
  ],
  migrate(prev, { apply }) {
    const result = apply(prev)

    delete result.workspaces

    if (result.windowState && typeof result.windowState === "object") {
      for (const key of Object.keys(result.windowState)) {
        const ws = result.windowState[key]
        if (ws && typeof ws === "object") {
          delete ws.activeWorkspaceId
        }
      }
    }

    if (Array.isArray(result.viewRegistry)) {
      result.viewRegistry = result.viewRegistry.map((entry: any) => {
        if (entry && typeof entry === "object") {
          const { workspaceId, ...rest } = entry
          return rest
        }
        return entry
      })
    }

    return result
  },
}

export default migration
