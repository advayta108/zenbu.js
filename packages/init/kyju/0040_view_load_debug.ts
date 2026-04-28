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
  version: 41,
  operations: [
    {
      "op": "alter",
      "key": "viewState",
      "changes": {
        "typeHash": {
          "from": "f77093f6231eac0f",
          "to": "3a45e9073f0a5faf"
        }
      }
    }
  ],
  migrate(prev, { apply }) {
    const result = apply(prev)

    // Default the new debug fields on every existing viewState entry so
    // the view-debug plugin always sees concrete values.
    if (result.viewState && typeof result.viewState === "object") {
      const next: Record<string, any> = {}
      for (const [id, vs] of Object.entries(result.viewState)) {
        if (!vs || typeof vs !== "object") {
          next[id] = vs
          continue
        }
        next[id] = {
          ...vs,
          loadedAt: (vs as any).loadedAt ?? null,
          loadCount: (vs as any).loadCount ?? 0,
          loadError: (vs as any).loadError ?? null,
        }
      }
      result.viewState = next
    }

    return result
  },
}

export default migration
