import * as Effect from "effect/Effect";
import { Service, runtime } from "../runtime";
import { DbService } from "./db";
import { WorkspaceService } from "./workspace";
import { MAIN_WINDOW_ID } from "../../../shared/schema";

type WindowMode = "default" | "reuse" | "new";

function parseZenArgs(argv: string[]): {
  cwd?: string;
  mode?: WindowMode;
} {
  const result: { cwd?: string; mode?: WindowMode } = {};
  for (const arg of argv) {
    if (arg.startsWith("--zen-cwd=")) {
      result.cwd = arg.slice("--zen-cwd=".length);
    } else if (arg.startsWith("--zen-window-mode=")) {
      const m = arg.slice("--zen-window-mode=".length);
      if (m === "default" || m === "reuse" || m === "new") result.mode = m;
    }
  }
  return result;
}

export class CliIntentService extends Service {
  static key = "cli-intent";
  static deps = {
    db: DbService,
    workspace: WorkspaceService,
    baseWindow: "base-window",
  };
  declare ctx: {
    db: DbService;
    workspace: WorkspaceService;
    baseWindow: any;
  };

  private _processed = false;

  evaluate() {
    if (this._processed) return;
    this._processed = true;

    const { cwd } = parseZenArgs(process.argv);

    const client = this.ctx.db.effectClient;

    Effect.runPromise(
      client.update((root) => {
        const kernel = root.plugin.kernel;

        // Prune orphaned windowStates (from prior cold-started sessions with
        // no matching live Electron window). Persisted entries (e.g. the
        // main window) are the source of truth across processes and must
        // survive the prune even when no Electron window has adopted them
        // yet.
        const liveWindowIds = new Set(this.ctx.baseWindow.windows.keys());
        const prunedCount = kernel.windowStates.filter(
          (ws) => !liveWindowIds.has(ws.id) && !ws.persisted,
        ).length;
        if (prunedCount > 0) {
          kernel.windowStates = kernel.windowStates.filter(
            (ws) => liveWindowIds.has(ws.id) || ws.persisted,
          );
          console.log(
            `[cli-intent] pruned ${prunedCount} orphaned windowStates`,
          );
        }

        // Ensure the persisted main windowState exists. On first ever boot,
        // create it; on upgrade from pre-`persisted` DBs, self-heal the
        // flag; always prune sessions whose agentId no longer exists.
        let mainWs = kernel.windowStates.find((ws) => ws.id === MAIN_WINDOW_ID);
        if (!mainWs) {
          kernel.windowStates = [
            ...kernel.windowStates,
            {
              id: MAIN_WINDOW_ID,
              sessions: [],
              panes: [],
              rootPaneId: null,
              focusedPaneId: null,
              sidebarOpen: false,
              tabSidebarOpen: true,
              sidebarPanel: "overview",
              persisted: true,
            },
          ];
        } else {
          if (!mainWs.persisted) mainWs.persisted = true;
          mainWs.sessions = mainWs.sessions.filter((s) =>
            kernel.agents.some((a) => a.id === s.agentId),
          );
        }
      }),
    )
      .then(async () => {
        // Cold-boot only ever has one live window (the main one). `mode`
        // doesn't matter here — there's nothing to reuse vs. new against.
        // If the CLI passed a cwd, find/create its workspace and activate
        // it on main. Otherwise leave whatever was last active in place.
        if (cwd) {
          const { id: workspaceId } =
            await this.ctx.workspace.findOrCreateWorkspaceForCwd(cwd);
          await this.ctx.workspace.activateWorkspace(
            MAIN_WINDOW_ID,
            workspaceId,
          );
        }
      })
      .catch((err) => {
        console.error("[cli-intent] Failed to apply CLI intent:", err);
      });

    console.log(`[cli-intent] applied${cwd ? ` cwd=${cwd}` : ""}`);
  }
}

runtime.register(CliIntentService, (import.meta as any).hot);
