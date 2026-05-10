import { BaseWindow } from "electron"
import { nanoid } from "nanoid"
import { Service, runtime } from "../runtime"
import { createLogger } from "../shared/log"
import { entrypointBgColor } from "../shared/zenbu-bg"
import { DbService } from "./db"

const log = createLogger("base-window")

export const MAIN_WINDOW_ID = "main"
type WindowBounds = { x: number; y: number; width: number; height: number }
type BootWindow = { windowId: string; win: BaseWindow }

export class BaseWindowService extends Service.create({
  key: "base-window",
  deps: { db: DbService },
}) {
  windows = new Map<string, BaseWindow>()
  // The kernel shell spawns a BaseWindow with a loading view before plugin
  // evaluation starts, then publishes it here. On first `evaluate` we adopt
  // it instead of creating a new window, so the launch feels instantaneous
  // and the loading view can be swapped for the orchestrator view in-place.
  private get bootWindows(): BootWindow[] { return (globalThis as any).__zenbu_boot_windows__ ?? [] }
  private set bootWindows(v: BootWindow[]) { (globalThis as any).__zenbu_boot_windows__ = v }

  private getZenWidth(): number | undefined {
    const flag = process.argv.find((a) => a.startsWith("--zen-width="))
    if (!flag) return undefined
    const n = parseInt(flag.slice("--zen-width=".length), 10)
    return isNaN(n) ? undefined : n
  }

  getWindowId(win: BaseWindow): string | undefined {
    for (const [id, w] of this.windows) {
      if (w === win) return id
    }
    return undefined
  }

  createWindow(opts?: Partial<WindowBounds> & { windowId?: string; show?: boolean }): { win: BaseWindow; windowId: string } {
    const windowId = opts?.windowId ?? nanoid()
    const zenWidth = this.getZenWidth()
    const win = new BaseWindow({
      width: opts?.width ?? zenWidth ?? 1100,
      height: opts?.height ?? 750,
      ...(opts?.x != null && opts?.y != null
        ? { x: opts.x, y: opts.y }
        : {}),
        // 
      show: opts?.show ?? true,
      titleBarStyle: "hidden",
      // Traffic lights sit on top of our 36px orchestrator title bar.
      // macOS draws each light at 12×12 px, so centering vertically:
      //   y = (36 - 12) / 2 = 12
      // x mirrors macOS Finder/Safari (~20 px inset from window edge).
      trafficLightPosition: { x: 14, y: 10 },
      // Mirror whatever color the renderer's `index.html` declares via
      // `<meta name="zenbu-bg">`. Without this, the window paints
      // `#F4F4F4` for the few frames between BaseWindow creation and
      // the WebContentsView's first paint — visible as a white flash
      // on dark-themed apps.
      backgroundColor: entrypointBgColor(),
      // 
    })
    this.windows.set(windowId, win)
    win.on("closed", () => this.windows.delete(windowId))
    return { win, windowId }
  }

  evaluate() {
    if (this.windows.size === 0) {
      if (this.bootWindows.length > 0) {
        for (const boot of this.bootWindows) {
          this.windows.set(boot.windowId, boot.win)
          boot.win.on("closed", () => this.windows.delete(boot.windowId))
        }
        this.bootWindows = []
      } else {
        const prefs = this.ctx.db.client.readRoot().plugin.core.windowPrefs
        this.createWindow({
          windowId: MAIN_WINDOW_ID,
          ...prefs[MAIN_WINDOW_ID]?.lastKnownBounds,
        })
      }
    }

    this.setup("window-cleanup", () => {
      return () => {
        const snapshot = [...this.windows.entries()].map(([windowId, win]) => ({
          windowId,
          bounds: win.getBounds(),
        }))
        void this.ctx.db.client.update((root) => {
          const next = { ...root.plugin.core.windowPrefs }
          for (const { windowId, bounds } of snapshot) {
            next[windowId] = { ...next[windowId], lastKnownBounds: bounds }
          }
          root.plugin.core.windowPrefs = next
        })
        for (const win of this.windows.values()) {
          (win as any).__zenbu_on_close = null;
          (win as any).__zenbu_on_closed = null;
          win.close()
        }
        this.windows.clear()
      }
    })
    // 

    log.verbose(`ready (${this.windows.size} windows)`)
  }
}

runtime.register(BaseWindowService, import.meta)
