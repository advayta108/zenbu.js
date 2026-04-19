export type ZenbuEvents = {
  advice: {
    reload: { scope: string }
  }
  orchestrator: {
    scrollTouch: { webContentsId: number; phase: "begin" | "end" }
  }
  pty: {
    data: { sessionId: string; data: string }
    exit: { sessionId: string; exitCode: number }
  }
  shortcut: {
    dispatched: { id: string; scope: string; windowId: string | null; paneId: string | null; ts: number }
  }
  setup: {
    /** A line of stdout/stderr from a setup.ts subprocess, streamed live. */
    progress: { pluginName: string; line: string }
  }
  cli: {
    /**
     * Emitted by `CliService.requestRelaunch` when an external `zen` invocation
     * wants the UI to confirm a restart. The renderer shows a modal and replies
     * via `CliService.confirmRelaunch(requestId, "accept" | "reject")`.
     */
    relaunchRequested: { requestId: string; pluginName: string; reason: string }
  }
}
