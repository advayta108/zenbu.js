import zod from "zod";
import {
  createSchema,
  f,
  type InferSchema,
  type InferRoot,
} from "@zenbu/kyju/schema";
import {
  agentSchemaFragment,
  agentConfigSchema,
} from "@zenbu/agent/src/schema";
export type {
  AgentEvent,
  AgentTitle,
  AgentRecord,
  ArchivedAgentRecord,
} from "@zenbu/agent/src/schema";

const windowSchema = zod.object({
  id: zod.string(),
  persisted: zod.boolean().default(false),
});

const viewSchema = zod.object({
  id: zod.string(),
  windowId: zod.string(),
  parentId: zod.string().nullable().default(null),
  scope: zod.string(),
  props: zod.record(zod.string(), zod.string()).default({}),
  createdAt: zod.number(),
});

const windowAppStateSchema = zod.object({
  windowId: zod.string(),
  activeViewId: zod.string().nullable().default(null),
  activeWorkspaceId: zod.string().nullable().default(null),
});

// Slimmed: workspace-shell-only sub-fields (sidebarOpen, tabSidebarOpen,
// sidebarPanel, utilitySidebarSelected) moved to
// `plugin["agent-manager"].workspaceShellState`. Generic per-view fields
// (cache/load metadata, draft, order) stay in kernel.
const viewAppStateSchema = zod.object({
  viewId: zod.string(),
  draft: zod
    .object({
      editorState: zod.unknown().nullable().default(null),
      blobs: zod
        .array(zod.object({ blobId: zod.string(), mimeType: zod.string() }))
        .default([]),
    })
    .nullable()
    .default(null),
  pendingCwd: zod.string().nullable().default(null),
  order: zod.number().default(0),
  cachedAt: zod.number().nullable().default(null),
  loadedAt: zod.number().nullable().default(null),
  loadCount: zod.number().default(0),
  loadError: zod.string().nullable().default(null),
});

const workspaceIconSchema = zod.object({
  blobId: zod.string(),
  origin: zod.enum(["override", "scanned"]),
  sourcePath: zod.string().nullable().default(null),
});

const workspaceSchema = zod.object({
  id: zod.string(),
  name: zod.string(),
  cwds: zod.array(zod.string()).default([]),
  createdAt: zod.number(),
  icon: workspaceIconSchema.nullable().default(null),
  // Which registered ViewRegistry scope provides this workspace's shell.
  // Defaults to "agent-manager"; future plugins can register alternative
  // workspace shells with `meta.kind === "workspace-shell"` and a user can
  // set this field to point at one.
  viewScope: zod.string().default("agent-manager"),
  // Hidden workspaces don't appear in the workspace sidebar rail and skip
  // their plugin barrel during `loadWorkspacePlugins`. Today this is used
  // exclusively for "agent windows" — mirrors of a source workspace that
  // render the default agent-manager shell so the user can edit/admin a
  // workspace whose plugins overrode `viewScope`. This is the simplest
  // representation that lets us run the same cwds without the source's
  // plugins; a richer per-workspace "plugin allowlist" model is the
  // long-term direction.
  hidden: zod.boolean().default(false),
  // If non-null, this workspace mirrors another workspace's cwds + chrome.
  // Used to dedupe agent-windows (one mirror per source) and cascade-
  // delete the mirror when the source is deleted.
  mirrorOfWorkspaceId: zod.string().nullable().default(null),
});

export const MAIN_WINDOW_ID = "main";

export const appSchema = createSchema({
  ...agentSchemaFragment,
  agentConfigs: f.array(agentConfigSchema).default([
    {
      id: "codex",
      name: "codex",
      startCommand:
        "$ZENBU_BUN $HOME/.zenbu/plugins/zenbu/packages/codex-acp/src/index.ts",
      availableModels: [],
      availableThinkingLevels: [],
      availableModes: [],
      defaultConfiguration: {},
    },
    {
      id: "claude",
      name: "claude",
      startCommand:
        "$ZENBU_BUN $HOME/.zenbu/plugins/zenbu/packages/claude-acp/src/index.ts",
      availableModels: [],
      availableThinkingLevels: [],
      availableModes: [],
      defaultConfiguration: {},
    },
    {
      id: "cursor",
      name: "cursor",
      startCommand: "agent acp",
      availableModels: [],
      availableThinkingLevels: [],
      availableModes: [],
      defaultConfiguration: {},
    },
    {
      id: "opencode",
      name: "opencode",
      startCommand: "opencode acp",
      availableModels: [],
      availableThinkingLevels: [],
      availableModes: [],
      defaultConfiguration: {},
    },
    {
      id: "copilot",
      name: "copilot",
      startCommand: "copilot --acp",
      availableModels: [],
      availableThinkingLevels: [],
      availableModes: [],
      defaultConfiguration: {},
    },
  ]),
  selectedConfigId: f.string().default("claude"),
  summarizationAgentConfigId: f.string().nullable().default(null),
  summarizationModel: f.string().nullable().default(null),
  orchestratorViewPath: f.string().default("/views/orchestrator/index.html"),
  viewRegistry: f
    .array(
      zod.object({
        scope: zod.string(),
        url: zod.string(),
        port: zod.number(),
        icon: zod.string().optional(),
        workspaceId: zod.string().optional(),
        meta: zod
          .object({
            kind: zod.string().optional(),
            sidebar: zod.boolean().optional(),
            bottomPanel: zod.boolean().optional(),
            label: zod.string().optional(),
          })
          .optional(),
      }),
    )
    .default([]),
  windows: f.array(windowSchema).default([]),
  windowState: f.record(zod.string(), windowAppStateSchema).default({}),
  views: f.array(viewSchema).default([]),
  viewState: f.record(zod.string(), viewAppStateSchema).default({}),
  commands: f
    .array(
      zod.object({
        id: zod.string(),
        name: zod.string(),
        description: zod.string().optional(),
        group: zod.string().optional(),
        shortcut: zod.string().optional(),
        rpcMethod: zod.string(),
        rpcArgs: zod.array(zod.any()).optional(),
      }),
    )
    .default([]),
  majorMode: f.string().default("fundamental-mode"),
  minorModes: f.array(zod.string()).default([]),
  focusedWindowId: f.string().nullable().default(null),
  shortcutRegistry: f
    .array(
      zod.object({
        id: zod.string(),
        defaultBinding: zod.string(),
        description: zod.string(),
        scope: zod.string(),
      }),
    )
    .default([]),
  shortcutOverrides: f.record(zod.string(), zod.string()).default({}),
  shortcutDisabled: f.array(zod.string()).default([]),
  focusRequestTarget: f.string().nullable().default(null),
  focusRequestWindowId: f.string().nullable().default(null),
  focusRequestNonce: f.string().default(""),
  updateState: f
    .object({
      status: zod
        .enum([
          "idle",
          "checking",
          "available",
          "not-available",
          "downloading",
          "downloaded",
          "error",
        ])
        .default("idle"),
      availableVersion: zod.string().nullable().default(null),
      releaseNotes: zod.string().nullable().default(null),
      downloadPercent: zod.number().nullable().default(null),
      downloadBytesPerSecond: zod.number().nullable().default(null),
      error: zod.string().nullable().default(null),
      lastCheckedAt: zod.number().nullable().default(null),
      dismissedVersion: zod.string().nullable().default(null),
    })
    .default({
      status: "idle",
      availableVersion: null,
      releaseNotes: null,
      downloadPercent: null,
      downloadBytesPerSecond: null,
      error: null,
      lastCheckedAt: null,
      dismissedVersion: null,
    }),
  workspaces: f.array(workspaceSchema).default([]),
});

export const schema = appSchema;

export type AppSchema = InferSchema<typeof appSchema>;
export type SchemaRoot = InferRoot<AppSchema>;

export type Window = zod.infer<typeof windowSchema>;
export type View = zod.infer<typeof viewSchema>;
export type WindowAppState = zod.infer<typeof windowAppStateSchema>;
export type ViewAppState = zod.infer<typeof viewAppStateSchema>;
