import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
    exclude: ["test/**/*.type.test.ts"],
    // Package-manager tests download binaries from the network and run real
    // installs against electron headers; give them generous slack.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    restoreMocks: true,
  },
})
