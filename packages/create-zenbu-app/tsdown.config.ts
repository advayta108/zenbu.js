import { defineConfig } from "tsdown"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    desktop: "src/desktop/index.ts",
  },
  format: "esm",
  platform: "node",
  target: "node20",
  clean: true,
  dts: true,
  outDir: "dist",
  outExtensions: () => ({ js: ".mjs" }),
})
