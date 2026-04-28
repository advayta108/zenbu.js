import { resolve } from "path"
import { defineZenbuViewConfig } from "./view-config"

export default defineZenbuViewConfig({
  // Kernel-only: the orchestrator/chat/workspace/etc. live in this
  // package as multi-page entries; vite needs each one declared so
  // production build ships them as separate bundles. Plugins ship a
  // single index.html and don't need this.
  overrides: {
    server: {
      warmup: {
        clientFiles: [
          "./views/orchestrator/main.tsx",
          "./views/chat/main.tsx",
        ],
      },
    },
    build: {
      rollupOptions: {
        input: {
          orchestrator: resolve(__dirname, "views/orchestrator/index.html"),
          chat: resolve(__dirname, "views/chat/index.html"),
          "message-input": resolve(__dirname, "views/message-input/index.html"),
          quiz: resolve(__dirname, "views/quiz/index.html"),
          flashcard: resolve(__dirname, "views/flashcard/index.html"),
          heatmap: resolve(__dirname, "views/heatmap/index.html"),
          "composer-debug": resolve(__dirname, "views/composer-debug/index.html"),
          "new-agent": resolve(__dirname, "views/new-agent/index.html"),
          plugins: resolve(__dirname, "views/plugins/index.html"),
          workspace: resolve(__dirname, "views/workspace/index.html"),
        },
      },
    },
  },
})
