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

// Adds `hidden` and `mirrorOfWorkspaceId` to every workspace row. Used by
// the "Open Agent Window" feature: a hidden workspace mirrors a source
// workspace's cwds + chrome but skips its plugin barrel, so the user can
// run a clean agent-manager shell against the same project even when the
// source workspace's plugins overrode `viewScope`.
const migration: KyjuMigration = {
  version: 42,
  migrate(prev, { apply }) {
    const result = apply(prev)
    if (Array.isArray(result.workspaces)) {
      result.workspaces = result.workspaces.map((w: any) =>
        w && typeof w === "object"
          ? {
              ...w,
              hidden: w.hidden ?? false,
              mirrorOfWorkspaceId: w.mirrorOfWorkspaceId ?? null,
            }
          : w,
      )
    }
    return result
  },
}

export default migration
