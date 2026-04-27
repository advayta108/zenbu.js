import { describe, expect, it } from "vitest";
import { reconcileAgentDbProcessState } from "../src/agent.ts";
import type { AgentDb, AgentRecord, AgentRoot } from "../src/schema.ts";

function agent(
  id: string,
  overrides: Partial<AgentRecord> = {},
): AgentRecord {
  return {
    id,
    name: id,
    startCommand: "codex",
    configId: "codex",
    status: "idle",
    reloadMode: "keep-alive",
    title: { kind: "not-available" },
    createdAt: Date.now(),
    sessionId: null,
    firstPromptSentAt: null,
    eventLog: {} as AgentRecord["eventLog"],
    queuedMessages: [],
    ...overrides,
  };
}

function dbWithAgents(agents: AgentRecord[]): AgentDb {
  const root = {
    agentConfigs: [],
    agents,
    archivedAgents: {} as AgentRoot["archivedAgents"],
    hotAgentsCap: 20,
    skillRoots: [],
  } satisfies AgentRoot;

  return {
    readRoot: () => root,
    update: async (fn) => {
      fn(root);
    },
    agents: [] as unknown as AgentDb["agents"],
    archivedAgents: {} as AgentDb["archivedAgents"],
  };
}

describe("reconcileAgentDbProcessState", () => {
  it("resets stale live-only state for agents without a process", async () => {
    const db = dbWithAgents([
      agent("loading", {
        status: "streaming",
        processState: "initializing",
      }),
      agent("prompting", {
        status: "streaming",
        processState: "prompting",
      }),
    ]);

    await reconcileAgentDbProcessState(db, []);

    for (const row of db.readRoot().agents) {
      expect(row.status).toBe("idle");
      expect(row.processState).toBe("ready");
      expect(row.lastFinishedAt).toEqual(expect.any(Number));
    }
  });

  it("leaves active and already-settled agents alone", async () => {
    const active = agent("active", {
      status: "streaming",
      processState: "prompting",
    });
    const ready = agent("ready", {
      status: "idle",
      processState: "ready",
      lastFinishedAt: 123,
    });
    const db = dbWithAgents([active, ready]);

    await reconcileAgentDbProcessState(db, ["active"]);

    expect(active.status).toBe("streaming");
    expect(active.processState).toBe("prompting");
    expect(ready.status).toBe("idle");
    expect(ready.processState).toBe("ready");
    expect(ready.lastFinishedAt).toBe(123);
  });
});
