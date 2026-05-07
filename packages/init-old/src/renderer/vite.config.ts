import { resolve } from "path";
import { defineZenbuViewConfig } from "./view-config";

export default defineZenbuViewConfig({
  // Kernel-only: the orchestrator/chat/etc. live in this package as
  // multi-page entries; vite needs each one declared so production
  // build ships them as separate bundles. The workspace shell, new-agent
  // picker, and plugins browser used to live here; they now live in
  // @zenbu/agent-manager and are served by that package's own Vite.
  overrides: {
    server: {
      warmup: {
        clientFiles: ["./views/orchestrator/main.tsx", "./views/chat/main.tsx"],
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
          "composer-debug": resolve(
            __dirname,
            "views/composer-debug/index.html",
          ),
        },
      },
    },
  },
});
