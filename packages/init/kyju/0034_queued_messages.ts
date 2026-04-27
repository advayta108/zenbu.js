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
  version: 35,
  operations: [
    {
      "op": "alter",
      "key": "agents",
      "changes": {
        "typeHash": {
          "from": "ae79c207f81ac523",
          "to": "1f9e5fea8a989198"
        }
      }
    },
    {
      "op": "alter",
      "key": "viewRegistry",
      "changes": {
        "typeHash": {
          "from": "39d278953653c40c",
          "to": "ef7f8b23fc6b82e0"
        }
      }
    }
  ],
  migrate(prev, { apply }) {
    const result = apply(prev)
    // customize transformation here
    return result
  },
}

export default migration
