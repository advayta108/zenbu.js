import type { DbSections } from "#registry/db-sections";

type Assert<T extends true> = T;
type Has<T, K extends string> = K extends keyof T ? true : false;
type Lacks<T, K extends string> = K extends keyof T ? false : true;

type KernelSection = DbSections["kernel"];
type AgentManagerSection = DbSections["agent-manager"];

// Kernel still owns the canonical agent + view tables.
type _KernelHasAgents = Assert<Has<KernelSection, "agents">>;
type _KernelHasViewRegistry = Assert<Has<KernelSection, "viewRegistry">>;
type _KernelHasViews = Assert<Has<KernelSection, "views">>;
type _KernelHasViewState = Assert<Has<KernelSection, "viewState">>;
type _KernelHasWindowState = Assert<Has<KernelSection, "windowState">>;

// Agent-manager section owns the moved fields.
type _AmHasWorkspaceState = Assert<Has<AgentManagerSection, "workspaceState">>;
type _AmHasAgentState = Assert<Has<AgentManagerSection, "agentState">>;
type _AmHasShellState = Assert<Has<AgentManagerSection, "workspaceShellState">>;
type _AmHasPool = Assert<Has<AgentManagerSection, "pool">>;

// Kernel must NOT carry the moved fields anymore.
type _KernelLacksWorkspaceState = Assert<Lacks<KernelSection, "workspaceState">>;
type _KernelLacksAgentState = Assert<Lacks<KernelSection, "agentState">>;
type _KernelLacksPool = Assert<Lacks<KernelSection, "pool">>;
type _KernelLacksPoolSize = Assert<Lacks<KernelSection, "poolSize">>;
