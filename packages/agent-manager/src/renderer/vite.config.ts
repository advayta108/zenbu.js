import { resolve } from "path"
import { defineZenbuViewConfig } from "#zenbu/init/src/renderer/view-config"

// Three workspace-level views live in this plugin: the workspace shell
// itself, the new-agent picker, and the plugins browser. Each one is its
// own HTML entry served by the same Vite instance; `agent-manager-view.ts`
// registers `agent-manager` as the primary scope and aliases `new-agent`
// and `plugins` onto path prefixes on the same Reloader.
export default defineZenbuViewConfig({
  overrides: {
    build: {
      rollupOptions: {
        input: {
          workspace: resolve(__dirname, "workspace/index.html"),
          "new-agent": resolve(__dirname, "new-agent/index.html"),
          plugins: resolve(__dirname, "plugins/index.html"),
        },
      },
    },
  },
})
