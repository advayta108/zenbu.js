import * as Effect from "effect/Effect";
import { Service, runtime } from "../runtime";
import { DbService } from "./db";
import { MAIN_WINDOW_ID } from "../../../shared/schema";
import { makeWindowAppState } from "../../../shared/agent-ops";
import { createLogger } from "../../../shared/log";

const log = createLogger("cli-intent");

export class CliIntentService extends Service {
  static key = "cli-intent";
  static deps = {
    db: DbService,
    baseWindow: "base-window",
  };
  declare ctx: {
    db: DbService;
    baseWindow: any;
  };

  private _processed = false;

  evaluate() {
    if (this._processed) return;
    this._processed = true;

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
          log.verbose(
            `pruned ${prunedWindows.length} orphaned windows`,
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
    ).catch((err) => {
      log.error("Failed to apply CLI intent:", err);
    });

    log.verbose("applied");
  }
}

runtime.register(CliIntentService, import.meta);
