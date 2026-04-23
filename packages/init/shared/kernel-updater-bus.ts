import { sharedEventBus, type EventBus } from "./event-bus"

export type KernelUpdaterEvents = {
  /** electron-updater kicked off a version check */
  "updater.checking": { ts: number }
  /** remote has a newer version than the running app */
  "updater.available": {
    version: string
    releaseDate: string | null
    releaseNotes: string | null
    ts: number
  }
  /** remote is equal-or-older than the running app */
  "updater.not-available": { currentVersion: string; ts: number }
  /** download byte-progress tick (fires often; service coalesces) */
  "updater.download-progress": {
    percent: number
    bytesPerSecond: number
    transferred: number
    total: number
    ts: number
  }
  /** download completed; install runs on next app quit (or on `cmd.install`) */
  "updater.downloaded": { version: string; ts: number }
  /** terminal autoupdater failure */
  "updater.error": { message: string; code: string | null; ts: number }

  /** service → kernel: trigger a fresh version check */
  "updater.cmd.check": { requestId: string }
  /** service → kernel: start downloading the available update */
  "updater.cmd.download": { requestId: string }
  /** service → kernel: quit + install the downloaded update */
  "updater.cmd.install": { requestId: string }

  /** kernel → service: command acknowledgement (paired by requestId) */
  "updater.cmd.ack": { requestId: string; ok: boolean; error?: string }
}

/**
 * Shared bus for kernel binary auto-updates. Bridges the kernel shell
 * (esbuild bundle) and the init-script services (tsx + dynohot). Mirrors
 * the `bootBus` pattern: typed events, same-process singleton via
 * `globalThis`.
 */
export const kernelUpdaterBus: EventBus<KernelUpdaterEvents> =
  sharedEventBus<KernelUpdaterEvents>("kernel-updater")
