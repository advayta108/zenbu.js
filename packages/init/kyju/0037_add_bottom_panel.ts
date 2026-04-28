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
  version: 38,
  operations: [
    {
      "op": "alter",
      "key": "viewRegistry",
      "changes": {
        "typeHash": {
          "from": "ef7f8b23fc6b82e0",
          "to": "5c07a336ddef0560"
        }
      }
    },
    {
      "op": "alter",
      "key": "workspaceState",
      "changes": {
        "typeHash": {
          "from": "b7b4c4ff924c8f5a",
          "to": "f94da3e6d62831ce"
        }
      }
    }
  ],
  migrate(prev, { apply }) {
    const result = apply(prev)

    // Back-fill the new bottom-panel fields on every existing
    // workspaceState row. `applyOperations`'s `alter` branch only swaps
    // a top-level value when the whole current value matches the old
    // default; it does not recurse into the `record(...)` rows. Without
    // this loop, populated DBs would keep rows shaped like the pre-37
    // schema and the renderer would fall back to its `?? defaults` —
    // safe, but the persisted shape would never converge.
    if (result.workspaceState && typeof result.workspaceState === "object") {
      for (const id of Object.keys(result.workspaceState)) {
        const r = result.workspaceState[id] ?? {}
        result.workspaceState[id] = {
          workspaceId: typeof r.workspaceId === "string" ? r.workspaceId : id,
          lastViewId: r.lastViewId ?? null,
          bottomPanelOpen: r.bottomPanelOpen ?? false,
          bottomPanelSelected: r.bottomPanelSelected ?? null,
          bottomPanelHeight:
            typeof r.bottomPanelHeight === "number" ? r.bottomPanelHeight : 260,
        }
      }
    }

    // `viewRegistry` is rewritten on every boot by `ViewRegistryService.syncToDb`,
    // so adding `meta.bottomPanel` to its zod shape only needs the typeHash
    // bump above; no row-level transform.

    return result
  },
}

export default migration
