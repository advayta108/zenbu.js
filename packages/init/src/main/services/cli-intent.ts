import * as Effect from "effect/Effect";
import { Service, runtime } from "../runtime";
import { DbService } from "./db";
import { WorkspaceService } from "./workspace";
import { MAIN_WINDOW_ID } from "../../../shared/schema";
import { makeWindowAppState } from "../../../shared/agent-ops";

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
    // todo: why is this an any and not an import ref
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

        // Prune orphaned windows (from prior cold-started sessions with
        // no matching live Electron window). Persisted entries (e.g. the
        // main window) are the source of truth across processes and must
        // survive the prune even when no Electron window has adopted them
        // yet.
        const liveWindowIds = new Set<string>(
          this.ctx.baseWindow.windows.keys() as Iterable<string>,
        );
        const prunedWindows = kernel.windows.filter(
          (w) => !liveWindowIds.has(w.id) && !w.persisted,
        );
        if (prunedWindows.length > 0) {
          const droppedIds = new Set<string>(prunedWindows.map((w) => w.id));
          kernel.windows = kernel.windows.filter((w) => !droppedIds.has(w.id));
          // Drop their windowState rows.
          const nextWindowState = { ...kernel.windowState };
          for (const id of droppedIds) delete nextWindowState[id];
          kernel.windowState = nextWindowState;
          // Drop the views in those windows + their viewState rows.
          const droppedViewIds = new Set<string>(
            kernel.views.filter((v) => droppedIds.has(v.windowId)).map((v) => v.id),
          );
          if (droppedViewIds.size > 0) {
            kernel.views = kernel.views.filter(
              (v) => !droppedIds.has(v.windowId),
            );
            const nextViewState = { ...kernel.viewState };
            for (const id of droppedViewIds) delete nextViewState[id];
            kernel.viewState = nextViewState;
          }
          console.log(
            `[cli-intent] pruned ${prunedWindows.length} orphaned windows`,
          );
        }

        // Ensure the persisted main window exists. On first ever boot,
        // create it; on upgrade from pre-`persisted` DBs, self-heal the
        // flag; always prune chat views whose agentId no longer exists.
        let mainWindow = kernel.windows.find((w) => w.id === MAIN_WINDOW_ID);
        if (!mainWindow) {
          kernel.windows = [
            ...kernel.windows,
            { id: MAIN_WINDOW_ID, persisted: true },
          ];
          kernel.windowState = {
            ...kernel.windowState,
            [MAIN_WINDOW_ID]:
              kernel.windowState[MAIN_WINDOW_ID] ??
              makeWindowAppState(MAIN_WINDOW_ID),
          };
          mainWindow = { id: MAIN_WINDOW_ID, persisted: true };
        } else if (!mainWindow.persisted) {
          kernel.windows = kernel.windows.map((w) =>
            w.id === MAIN_WINDOW_ID ? { ...w, persisted: true } : w,
          );
        }

        // Prune chat views in the main window whose agentId no longer
        // exists in kernel.agents.
        const agentIds = new Set<string>(kernel.agents.map((a) => a.id));
        const orphanedViewIds = new Set<string>(
          kernel.views
            .filter(
              (v) =>
                v.windowId === MAIN_WINDOW_ID &&
                v.scope === "chat" &&
                v.props.agentId &&
                !agentIds.has(v.props.agentId),
            )
            .map((v) => v.id),
        );
        if (orphanedViewIds.size > 0) {
          kernel.views = kernel.views.filter((v) => !orphanedViewIds.has(v.id));
          const nextViewState = { ...kernel.viewState };
          for (const id of orphanedViewIds) delete nextViewState[id];
          kernel.viewState = nextViewState;
        }
      }),
    )
      .then(async () => {
        // Cold-boot only ever has one live window (the main one). `mode`
        // doesn't matter here - there's nothing to reuse vs. new against.
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

runtime.register(CliIntentService, import.meta);
