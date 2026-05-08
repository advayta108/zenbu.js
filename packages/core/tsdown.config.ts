import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "setup-gate": "src/setup-gate.ts",
    index: "src/index.ts",
    "env-bootstrap": "src/env-bootstrap.ts",
    registry: "src/registry.ts",
    runtime: "src/runtime.ts",
    schema: "src/schema.ts",
    "node-loader": "../advice/src/node-loader.ts",
    "advice-runtime": "../advice/src/runtime/index.ts",
    "loaders/zenbu": "src/loaders/zenbu.ts",
    "services/index": "src/services/index.ts",
    "services/default": "src/services/default.ts",
    db: "src/db.ts",
    rpc: "src/rpc.ts",
    react: "src/react.ts",
    advice: "src/advice.ts",
    vite: "src/vite.ts",
  },
  format: "esm",
  dts: { eager: true },
  platform: "node",
  target: "node20",
  clean: true,
  outDir: "dist",
  outExtensions: () => ({ js: ".mjs" }),
  deps: {
    alwaysBundle: [
      "@zenbu/advice",
      "@zenbu/git",
      "@zenbu/kyju",
      "@zenbu/zenrpc",
      "dynohot",
    ],
  },
});
