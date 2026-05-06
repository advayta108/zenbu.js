import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { makeCollection } from "@zenbu/kyju/schema";
import { Service, runtime } from "#zenbu/init/src/main/runtime";
import { DbService } from "#zenbu/init/src/main/services/db";
import { AgentService } from "#zenbu/init/src/main/services/agent";
import {
  insertHotAgent,
  validSelectionFromTemplate,
  type ArchivedAgent,
} from "#zenbu/init/shared/agent-ops";

/**
 * Maintains `pool.length === poolSize` pre-created agent rows so the
 * "new agent" onboarding view can promote one instantly on submit.
 *
 * Agent rows land in `kernel.agents` like any other; only the
 * `plugin["agent-manager"].pool` pointer list distinguishes them.
 * `NewAgentService.promoteNewAgentTab` consumes the head entry; the
 * subscription below refills.
 *
 * Lives in agent-manager because pool/poolSize are the warm-pool that
 * feeds the new-agent picker — both workspace-shell concerns. Cross-
 * section reads back into `plugin.kernel.*` for agent rows / configs /
 * focused-window seed cwd.
 */
export class PooledAgentService extends Service {
  static key = "pooled-agent";
  static deps = { db: DbService, agent: AgentService };
  declare ctx: { db: DbService; agent: AgentService };

  private pending: Promise<void> | null = null;

  evaluate() {
    this.setup("pool-subscribe", () => {
      const effectClient = this.ctx.db.effectClient;

      // Prune orphaned pool entries (their agent row may have been
      // evicted by `hotAgentsCap`), then kick one refill. Further
      // refills are driven by the subscriptions below: whenever the DB
      // reports a new value and we're below poolSize, we add one. Don't
      // loop in-memory - we must wait for each update's new state to
      // propagate before deciding whether to add another.
      void (async () => {
        await this.pruneOrphans();
        void this.maybeAddOne();
      })();

      const am = effectClient.plugin["agent-manager"] as any;
      const unsubPool = am.pool.subscribe(() => {
        void this.maybeAddOne();
      });
      const unsubSize = am.poolSize.subscribe(() => {
        void this.maybeAddOne();
      });

      return () => {
        unsubPool();
        unsubSize();
      };
    });
  }

  private async pruneOrphans() {
    const client = this.ctx.db.client;
    await client.update((root) => {
      const kernel = root.plugin.kernel;
      const am = root.plugin["agent-manager"];
      const validIds = new Set(kernel.agents.map((a) => a.id));
      const kept = am.pool.filter((entry: { agentId: string }) =>
        validIds.has(entry.agentId),
      );
      if (kept.length !== am.pool.length) am.pool = kept;
    });
  }

  /**
   * Adds at most one pool entry per call, gated by an in-flight promise.
   * After the entry lands in the DB, the `pool` subscribe callback fires
   * again - if we're still below `poolSize`, that triggers the next add.
   * Never loops in-memory: two reads of `pool.length` after an update
   * can disagree until the kyju client has applied the write locally,
   * which is what caused a previous infinite-spawn bug in agent-sidebar.
   */
  private async maybeAddOne() {
    if (this.pending) return this.pending;
    const run = async () => {
      const am = this.ctx.db.client.readRoot().plugin["agent-manager"];
      const pool = am.pool ?? [];
      const poolSize =
        typeof am.poolSize === "number" && am.poolSize > 0 ? am.poolSize : 1;
      if (pool.length >= poolSize) return;
      await this.addEntry();
    };
    this.pending = run().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async addEntry() {
    const client = this.ctx.db.client;
    const root = client.readRoot();
    const kernel = root.plugin.kernel as any;
    const am = root.plugin["agent-manager"] as any;

    const configs = kernel.agentConfigs ?? [];
    const selectedConfig =
      configs.find((c: any) => c.id === kernel.selectedConfigId) ?? configs[0];
    if (!selectedConfig) {
      console.warn("[pooled-agent] no agentConfigs; skipping refill");
      return;
    }

    // Seed cwd from the focused window's active view's agent, falling
    // back to the active workspace's first cwd, then `~/.zenbu`. Never
    // default to `$HOME` - FileScannerService installs a recursive
    // fs.watch and watching home pegs CPU. The user's pick at promote
    // time runs through `changeCwd` so a wrong seed is recoverable.
    const focusedWindowId = kernel.focusedWindowId;
    const focusedWs = focusedWindowId
      ? kernel.windowState[focusedWindowId]
      : undefined;
    const focusedActiveViewId = focusedWs?.activeViewId ?? null;
    const focusedView = focusedActiveViewId
      ? kernel.views.find((v: any) => v.id === focusedActiveViewId)
      : undefined;
    const focusedAgentId =
      focusedView?.scope === "chat" ? focusedView.props.agentId : undefined;
    const focusedAgent = focusedAgentId
      ? kernel.agents.find((a: any) => a.id === focusedAgentId)
      : undefined;
    const focusedAgentCwd =
      typeof focusedAgent?.metadata?.cwd === "string"
        ? focusedAgent.metadata.cwd
        : undefined;
    const activeWorkspaceId = focusedWs?.activeWorkspaceId ?? null;
    const activeWorkspace = activeWorkspaceId
      ? kernel.workspaces.find((w: any) => w.id === activeWorkspaceId)
      : undefined;
    const seedCwd =
      focusedAgentCwd ??
      activeWorkspace?.cwds?.[0] ??
      path.join(os.homedir(), ".zenbu");

    const agentId = nanoid();
    const seeded = validSelectionFromTemplate(selectedConfig);

    void am;

    let evicted: ArchivedAgent[] = [];
    await client.update((root) => {
      const k = root.plugin.kernel;
      const ams = root.plugin["agent-manager"];
      evicted = insertHotAgent(k, {
        id: agentId,
        name: selectedConfig.name,
        startCommand: selectedConfig.startCommand,
        configId: selectedConfig.id,
        metadata: { cwd: seedCwd },
        eventLog: makeCollection({
          collectionId: nanoid(),
          debugName: "eventLog",
        }),
        status: "idle",
        ...seeded,
        title: { kind: "not-available" },
        reloadMode: "keep-alive",
        sessionId: null,
        firstPromptSentAt: null,
        createdAt: Date.now(),
        queuedMessages: [],
      } as any);
      // Append to pool AFTER the row exists so subscribers never see a
      // dangling id.
      ams.pool = [...ams.pool, { agentId }];
    });

    if (evicted.length > 0) {
      await (client as any).plugin.kernel.archivedAgents
        .concat(evicted)
        .catch(() => {});
    }

    // Spawn the ACP process. Fire-and-forget so the pool is responsive
    // even if a process is slow to start; the agent service queues sends
    // until the process is ready.
    this.ctx.agent.init(agentId).catch((err: unknown) => {
      console.error("[pooled-agent] agent.init failed:", err);
    });
  }
}

runtime.register(PooledAgentService, import.meta);
