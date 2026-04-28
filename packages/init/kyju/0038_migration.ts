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
  version: 39,
  operations: [
    {
      "op": "alter",
      "key": "views",
      "changes": {
        "typeHash": {
          "from": "611dde5a4520f0af",
          "to": "ae406ef2f3306f04"
        }
      }
    },
    {
      "op": "alter",
      "key": "viewState",
      "changes": {
        "typeHash": {
          "from": "64550070d88b9a8b",
          "to": "f77093f6231eac0f"
        }
      }
    }
  ],
  migrate(prev, { apply }) {
    const result = apply(prev)

    // Rename `view.params` -> `view.props` on every existing view row.
    if (Array.isArray(result.views)) {
      result.views = result.views.map((v: any) => {
        if (!v || typeof v !== "object") return v
        const { params, ...rest } = v
        return {
          ...rest,
          props:
            v.props ??
            (params && typeof params === "object" ? params : {}),
        }
      })
    }

    // Add `cachedAt: null` to every existing viewState entry. Boot-time
    // observability: the field stays null until something mounts the
    // view's iframe.
    if (result.viewState && typeof result.viewState === "object") {
      const next: Record<string, any> = {}
      for (const [id, vs] of Object.entries(result.viewState)) {
        if (!vs || typeof vs !== "object") {
          next[id] = vs
          continue
        }
        next[id] = {
          ...vs,
          cachedAt: (vs as any).cachedAt ?? null,
        }
      }
      result.viewState = next
    }

    return result
  },
}

export default migration
