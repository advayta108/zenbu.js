import path from "node:path"
import { fileURLToPath } from "node:url"
import { Service, runtime } from "../runtime"
import { createLogger } from "../../../shared/log"
import { registerContentScript } from "./advice-config"

const log = createLogger("drag-region")

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "renderer",
  "lib",
  "drag-region-install.ts",
)

/**
 * Installs the cross-iframe drag-region forwarder in every view (scope
 * `*`). The actual hook + overlay components live in
 * `renderer/lib/drag-region.tsx` and are imported directly by consumers.
 *
 * Without this content script, intermediate iframes that don't import
 * the module themselves would fail to relay child drag-region heartbeats
 * up the frame tree.
 */
export class DragRegionService extends Service {
  static key = "drag-region"
  static deps = {}

  evaluate() {
    this.setup("register-content-script", () =>
      registerContentScript("*", SCRIPT_PATH),
    )
    log.verbose(`content script registered: ${SCRIPT_PATH}`)
  }
}

runtime.register(DragRegionService, import.meta)
