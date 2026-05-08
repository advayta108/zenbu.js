import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: {
      bin: "src/bin.ts",
      build: "src/build.ts",
    },
    format: "esm",
    platform: "node",
    target: "node20",
    clean: true,
    dts: false,
    outDir: "dist",
    outExtensions: () => ({ js: ".mjs" }),
  },
  {
    entry: {
      launcher: "src/launcher.ts",
    },
    format: "esm",
    platform: "node",
    target: "node20",
    deps: {
      neverBundle: ["electron"],
    },
    clean: false,
    dts: false,
    outDir: "dist",
    outExtensions: () => ({ js: ".mjs" }),
  },
]);
