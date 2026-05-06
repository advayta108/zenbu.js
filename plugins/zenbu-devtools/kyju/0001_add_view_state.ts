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
  version: 2,
  operations: [
    {
      "op": "add",
      "key": "viewState",
      "kind": "data",
      "hasDefault": true,
      "default": {}
    },
    {
      "op": "add",
      "key": "agents",
      "kind": "data",
      "hasDefault": true,
      "default": []
    },
    {
      "op": "alter",
      "key": "panelOpen",
      "changes": {
        "typeHash": {
          "from": "7f4b45d1b1f6ab59",
          "to": "b3d8a10d1f0aad21"
        },
        "default": {
          "to": null
        },
        "hasDefault": {
          "to": true
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
