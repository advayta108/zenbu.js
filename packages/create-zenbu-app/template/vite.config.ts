import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineZenbuViewConfig } from "./zenbu/packages/init/src/renderer/view-config"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineZenbuViewConfig({
  root: path.resolve(__dirname, "src", "renderer"),
  aliases: [
    { find: "#zenbu", replacement: path.resolve(__dirname, "zenbu", "packages") },
    { find: "@", replacement: path.resolve(__dirname, "src", "renderer") },
  ],
})
