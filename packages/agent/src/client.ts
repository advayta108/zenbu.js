import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import { applyUserShellPath } from "./user-shell-env";

export type AcpClientState =
  | "disconnected"
  | "initializing"
  | "ready"
  | "prompting";

export type SessionUpdateHandler = (event: acp.SessionNotification) => void;

export type AcpClientHandlers = {
  requestPermission?: (
    params: acp.RequestPermissionRequest,
  ) => Promise<acp.RequestPermissionResponse>;
  readTextFile?: (
    params: acp.ReadTextFileRequest,
  ) => Promise<acp.ReadTextFileResponse>;
  writeTextFile?: (
    params: acp.WriteTextFileRequest,
  ) => Promise<acp.WriteTextFileResponse>;
  createTerminal?: (
    params: acp.CreateTerminalRequest,
  ) => Promise<acp.CreateTerminalResponse>;
  terminalOutput?: (
    params: acp.TerminalOutputRequest,
  ) => Promise<acp.TerminalOutputResponse>;
  releaseTerminal?: (
    params: acp.ReleaseTerminalRequest,
  ) => Promise<acp.ReleaseTerminalResponse | void>;
  waitForTerminalExit?: (
    params: acp.WaitForTerminalExitRequest,
  ) => Promise<acp.WaitForTerminalExitResponse>;
  killTerminal?: (
    params: acp.KillTerminalRequest,
  ) => Promise<acp.KillTerminalResponse | void>;
};

export type SpawnOpts = {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
};

export type AcpClientConfig = SpawnOpts & {
  handlers?: AcpClientHandlers;
};

export { acp };
export const PROTOCOL_VERSION = acp.PROTOCOL_VERSION;

export class AcpClient {
  private state: AcpClientState = "disconnected";
  private sessionId: string | null = null;
  private connection: acp.ClientSideConnection;
  private updateHandlers: Set<SessionUpdateHandler>;
  private proc: ChildProcess;

  private constructor(
    connection: acp.ClientSideConnection,
    updateHandlers: Set<SessionUpdateHandler>,
    proc: ChildProcess,
  ) {
    this.connection = connection;
    this.updateHandlers = updateHandlers;
    this.proc = proc;
  }

  static async create(config: AcpClientConfig): Promise<AcpClient> {
    const updateHandlers = new Set<SessionUpdateHandler>();

    const baseEnv = { ...process.env, ...config.env };
    delete baseEnv.NODE_OPTIONS;
    // Prepend the user's login-shell PATH so we can find Claude / codex /
    // other user-installed binaries. The shell probe runs as the `kernel`
    // preload concurrently with boot, so this await is typically free
    // (Promise already resolved) and only waits on first-paint-timing
    // edge cases.
    const env = await applyUserShellPath(baseEnv);

    const proc = spawn(config.command, config.args, {
      cwd: config.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "inherit"],
      env,
    });
    await once(proc as any, "spawn");

    const input = Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const connection = new acp.ClientSideConnection(
      () => ({
        sessionUpdate: async (params: acp.SessionNotification) => {
          for (const h of updateHandlers) h(params);
        },
        requestPermission: async (params: acp.RequestPermissionRequest) => {
          if (config.handlers?.requestPermission) {
            return config.handlers.requestPermission(params);
          }
          const option =
            params.options.find((o) => o.kind === "allow_always") ??
            params.options.find((o) => o.kind === "allow_once");
          if (option) {
            return {
              outcome: {
                outcome: "selected" as const,
                optionId: option.optionId,
              },
            };
          }
          return { outcome: { outcome: "cancelled" as const } };
        },
        readTextFile: async (params: acp.ReadTextFileRequest) => {
          if (config.handlers?.readTextFile) {
            return config.handlers.readTextFile(params);
          }
          return { content: "" };
        },
        writeTextFile: async (params: acp.WriteTextFileRequest) => {
          if (config.handlers?.writeTextFile) {
            return config.handlers.writeTextFile(params);
          }
          return {};
        },
        createTerminal: config.handlers?.createTerminal
          ? async (params: acp.CreateTerminalRequest) =>
              config.handlers!.createTerminal!(params)
          : undefined,
        terminalOutput: config.handlers?.terminalOutput
          ? async (params: acp.TerminalOutputRequest) =>
              config.handlers!.terminalOutput!(params)
          : undefined,
        releaseTerminal: config.handlers?.releaseTerminal
          ? async (params: acp.ReleaseTerminalRequest) =>
              config.handlers!.releaseTerminal!(params)
          : undefined,
        waitForTerminalExit: config.handlers?.waitForTerminalExit
          ? async (params: acp.WaitForTerminalExitRequest) =>
              config.handlers!.waitForTerminalExit!(params)
          : undefined,
        killTerminal: config.handlers?.killTerminal
          ? async (params: acp.KillTerminalRequest) =>
              config.handlers!.killTerminal!(params)
          : undefined,
      }),
      stream,
    );

    return new AcpClient(connection, updateHandlers, proc);
  }

  getState(): AcpClientState {
    return this.state;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async initialize(
    params: acp.InitializeRequest,
  ): Promise<acp.InitializeResponse> {
    this.state = "initializing";
    return this.connection.initialize(params);
  }

  async newSession(
    params: acp.NewSessionRequest,
  ): Promise<acp.NewSessionResponse> {
    const result = await this.connection.newSession(params);
    this.sessionId = result.sessionId;
    this.state = "ready";
    return result;
  }

  async loadSession(params: acp.LoadSessionRequest): Promise<void> {
    await this.connection.loadSession(params);
    this.sessionId = params.sessionId;
    this.state = "ready";
  }

  async resumeSession(params: {
    sessionId: string;
    cwd: string;
    mcpServers?: acp.McpServer[];
  }): Promise<acp.ResumeSessionResponse> {
    // Return the ACP response so the caller can reconcile configOptions —
    // resume, like newSession, carries the agent's current mode / model /
    // thinking defaults that we need to override with the user's persisted
    // selections.
    const response = (await (this.connection as any).unstable_resumeSession(
      params,
    )) as acp.ResumeSessionResponse;
    this.sessionId = params.sessionId;
    this.state = "ready";
    return response;
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    this.state = "prompting";
    const result = await this.connection.prompt(params);
    this.state = "ready";
    return result;
  }

  async cancel(sessionId: string): Promise<void> {
    await this.connection.cancel({ sessionId });
  }

  async setSessionMode(
    params: acp.SetSessionModeRequest,
  ): Promise<acp.SetSessionModeResponse> {
    return this.connection.setSessionMode(params);
  }

  async setSessionModel(
    params: acp.SetSessionModelRequest,
  ): Promise<acp.SetSessionModelResponse> {
    return (this.connection as any).unstable_setSessionModel(params);
  }

  async setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    return this.connection.setSessionConfigOption(params);
  }

  onSessionUpdate(handler: SessionUpdateHandler): () => void {
    this.updateHandlers.add(handler);
    return () => {
      this.updateHandlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.state = "disconnected";
    this.proc.kill();
  }
}
