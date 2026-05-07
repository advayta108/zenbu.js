import fsp from "node:fs/promises";
import { app } from "electron";
import * as Effect from "effect/Effect";
import { nanoid } from "nanoid";
import { Service, runtime } from "../runtime";
import { DbService } from "./db";
import { HttpService } from "./http";
import { RpcService } from "./rpc";
import { INTERNAL_DIR, RUNTIME_JSON } from "../../../shared/paths";
import { MAIN_WINDOW_ID } from "../../../shared/schema";
import { makeWindowAppState } from "../../../shared/agent-ops";
import { createLogger } from "../../../shared/log";

const log = createLogger("cli");

export type WindowMode = "default" | "reuse" | "new";

export type RelaunchDecision = "accept" | "reject";

export class CliService extends Service {
  static key = "cli";
  static deps = {
    db: DbService,
    http: HttpService,
    rpc: RpcService,
    baseWindow: "base-window",
    window: "window",
  };
  declare ctx: {
    db: DbService;
    http: HttpService;
    rpc: RpcService;
    baseWindow: any;
    window: any;
  };

  private pendingRelaunches = new Map<string, (d: RelaunchDecision) => void>();

  ping() {
    return {
      ok: true,
      pid: process.pid,
      wsPort: this.ctx.http.port,
      extra: " observe me 101",
    };
  }

  /** Read-only listing for `zen exec` scripts that introspect agent state. */
  listAgents() {
    const kernel = this.ctx.db.effectClient.readRoot().plugin.kernel;
    return {
      agents: kernel.agents.map((a) => ({
        id: a.id,
        name: a.name,
        configId: a.configId,
        status: a.status,
        lastUserMessageAt: a.lastUserMessageAt ?? null,
      })),
    };
  }

  /**
   * `zen [path]` entrypoint. Focuses an existing window or opens a new one
   * using VS Code-style window semantics:
   *   - default / reuse: focus an existing window if one is open.
   *   - new:             always open a new window.
   */
  async openWindow(args: { mode?: WindowMode } = {}): Promise<{
    windowId: string;
  }> {
    const mode: WindowMode = args.mode ?? "default";

    const client = this.ctx.db.effectClient;

    let targetWindowId: string | null = null;

    if (mode === "default" || mode === "reuse") {
      const root = client.readRoot();
      const kernel = root.plugin.kernel;
      const focused = kernel.focusedWindowId ?? null;
      if (focused && this.ctx.baseWindow.windows.has(focused)) {
        targetWindowId = focused;
      } else if (this.ctx.baseWindow.windows.has(MAIN_WINDOW_ID)) {
        targetWindowId = MAIN_WINDOW_ID;
      } else {
        const first = this.ctx.baseWindow.windows.keys().next().value as
          | string
          | undefined;
        targetWindowId = first ?? null;
      }
    }

    if (!targetWindowId) {
      const windowId = nanoid();
      await Effect.runPromise(
        client.update((root) => {
          const k = root.plugin.kernel;
          k.windows = [...k.windows, { id: windowId, persisted: false }];
          k.windowState = {
            ...k.windowState,
            [windowId]: makeWindowAppState(windowId),
          };
        }),
      );
      this.ctx.baseWindow.createWindow({ windowId });
      targetWindowId = windowId;
      setTimeout(() => {
        this.ctx.window.evaluate();
      }, 50);
    }

    const win = this.ctx.baseWindow.windows.get(targetWindowId);
    if (win && !win.isDestroyed()) win.focus();

    return { windowId: targetWindowId };
  }

  /**
   * Ask the UI whether to relaunch the app. Returns the user's decision.
   * Called from the CLI after `setup.ts` modifies files outside the module
   * graph (e.g. `node_modules`) that dynohot can't hot-reload. If accepted,
   * the app relaunches shortly after the RPC response ships.
   */
  async requestRelaunch(
    pluginName: string,
    reason: string,
  ): Promise<RelaunchDecision> {
    const requestId = nanoid();
    const promise = new Promise<RelaunchDecision>((resolve) => {
      this.pendingRelaunches.set(requestId, resolve);
    });
    this.ctx.rpc.emit.cli.relaunchRequested({ requestId, pluginName, reason });
    return promise;
  }

  /** Called by the frontend modal when the user makes a choice. */
  confirmRelaunch(requestId: string, decision: RelaunchDecision) {
    const resolve = this.pendingRelaunches.get(requestId);
    if (!resolve) return { ok: false as const, error: "unknown requestId" };
    this.pendingRelaunches.delete(requestId);
    resolve(decision);
    if (decision === "accept") {
      // Match the canonical relaunch pattern used by runtime-control.ts,
      // git-updates.ts, and the ipcMain("relaunch") handler in the kernel
      // shell. `queueMicrotask` runs after zenrpc serializes this method's
      // return value but inside the same tick — no arbitrary buffer for
      // native FSEvents callbacks to race shutdown. `{ args: [app.getAppPath()] }`
      // avoids the dev-mode "Unable to find Electron app" dialog.
      queueMicrotask(() => {
        app.relaunch({ args: [app.getAppPath()] });
        app.quit();
      });
    }
    return { ok: true as const };
  }

  /**
   * Canonical handshake file for external processes (the zen CLI, scripts).
   * Carries the live WS port so they can speak zenrpc on the same transport
   * the renderer uses. Because `HttpService` is a declared dep, any port
   * change re-evaluates this service and rewrites the file.
   */
  private async writeRuntimeJson(): Promise<void> {
    await fsp.mkdir(INTERNAL_DIR, { recursive: true });
    await fsp.writeFile(
      RUNTIME_JSON,
      JSON.stringify({
        wsPort: this.ctx.http.port,
        wsToken: this.ctx.http.authToken,
        dbPath: this.ctx.db.dbPath,
        pid: process.pid,
      }),
    );
  }

  evaluate() {
    this.writeRuntimeJson().catch((err) => {
      log.error("writeRuntimeJson failed:", err);
    });
    this.setup("runtime-json-cleanup", () => {
      return async () => {
        try {
          await fsp.unlink(RUNTIME_JSON);
        } catch {}
      };
    });
    log.verbose("service ready");
  }
}

runtime.register(CliService, import.meta);
