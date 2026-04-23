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
  version: 31,
  operations: [
    {
      "op": "add",
      "key": "updateState",
      "kind": "data",
      "hasDefault": true,
      "default": {
        "status": "idle",
        "availableVersion": null,
        "releaseNotes": null,
        "downloadPercent": null,
        "downloadBytesPerSecond": null,
        "error": null,
        "lastCheckedAt": null,
        "dismissedVersion": null
      }
    }
  ],
}

export default migration
