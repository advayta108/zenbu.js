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
  version: 40,
  operations: [
    {
      "op": "alter",
      "key": "viewRegistry",
      "changes": {
        "typeHash": {
          "from": "5c07a336ddef0560",
          "to": "db20be04e2d2c569"
        }
      }
    }
  ],
  migrate(prev, { apply }) {
    // `viewRegistry` is rewritten on every boot by
    // `ViewRegistryService.syncToDb`, so adding `meta.label` only needs
    // the typeHash bump. No row-level transform required.
    return apply(prev)
  },
}

export default migration
