import * as Effect from "effect/Effect";
import { nanoid } from "nanoid";
import { Service, runtime } from "../runtime";
import { DbService } from "./db";
import { RpcService } from "./rpc";
import {
  findLiveViewTab,
  findAgentIdForView,
  makeViewAppState,
} from "../../../shared/agent-ops";
import { appendTokenToEditorState } from "../../../shared/editor-state";
import type { TokenPayload } from "../../../shared/tokens";

export type InsertTokenResult = {
  delivered: "live" | "persisted";
  requestId?: string;
};

/**
 * Core-owned RPC entry point for "insert this token into that view's
 * composer". Called by plugin callers (e.g. file-manager picker mode),
 * agents, the CLI - any code that has a viewId + payload.
 *
 * Two paths, split by whether the view is the active view of the focused
 * window:
 *
 *  - Live: emit `insert.requested` via zenrpc. The focused composer's
 *    InsertBridgePlugin picks it up and hands it to the token-bus, which
 *    mutates the Lexical editor.
 *  - Not live (backgrounded view / non-focused window / not mounted): write
 *    the TokenNode directly into the view's persisted draft on
 *    `kernel.viewState[viewId]`. On next mount OR on refocus, the composer
 *    rehydrates from that draft and the pill appears.
 *
 * TODO(crdt): This split exists only because we don't have a merge protocol
 * for two writers mutating editor state concurrently. With a CRDT we could
 * apply to any mounted composer and merge with local edits.
 */
export class InsertService extends Service {
  static key = "insert";
  static deps = { db: DbService, rpc: RpcService };
  declare ctx: { db: DbService; rpc: RpcService };

  async insertToken(args: {
    viewId: string;
    payload: TokenPayload;
  }): Promise<InsertTokenResult> {
    const client = this.ctx.db.effectClient;
    const kernel = client.readRoot().plugin.kernel;

    const live = findLiveViewTab(kernel, args.viewId);
    if (live) {
      const agentId = findAgentIdForView(kernel.views, args.viewId);
      const requestId = nanoid();
      this.ctx.rpc.emit.insert.requested({
        requestId,
        windowId: live.windowId,
        viewId: args.viewId,
        agentId: agentId ?? "",
        payload: args.payload,
        ts: Date.now(),
      });
      return { delivered: "live", requestId };
    }

    // Persisted path: write directly into viewState[viewId].draft.
    await Effect.runPromise(
      client.update((root) => {
        const k = root.plugin.kernel;
        if (!k.views.some((v) => v.id === args.viewId)) {
          // No such view. Caller gave us a stale id - fail quietly.
          return;
        }
        const existing = k.viewState[args.viewId];
        const baseDraft = existing?.draft ?? {
          editorState: null,
          blobs: [],
        };
        const nextEditorState = appendTokenToEditorState(
          baseDraft.editorState,
          args.payload,
        );
        const nextBlobs = [
          ...(baseDraft.blobs ?? []),
          ...(args.payload.blobs ?? []).map((b) => ({
            blobId: b.blobId,
            mimeType: b.mimeType,
          })),
        ];
        const next = existing
          ? {
              ...existing,
              draft: {
                editorState: nextEditorState as unknown,
                blobs: nextBlobs,
              },
            }
          : makeViewAppState(args.viewId, {
              draft: {
                editorState: nextEditorState as unknown,
                blobs: nextBlobs,
              },
            });
        k.viewState = { ...k.viewState, [args.viewId]: next };
      }),
    ).catch((err) => {
      console.error("[insert] persist failed:", err);
    });

    return { delivered: "persisted" };
  }

  /**
   * Agent-keyed insert - no view needed up front. Intended for callers that
   * target a brand-new agent (e.g. the quick-chat plugin creates a cursor
   * agent before any view wraps it). Walks `kernel.views` for any chat
   * view referencing this agent and writes into its persisted draft; if
   * none exists yet, no-op (the agent will get its draft seeded once a
   * view is created).
   */
  async insertTokenForAgent(args: {
    agentId: string;
    payload: TokenPayload;
  }): Promise<{ ok: boolean }> {
    const client = this.ctx.db.effectClient;
    let ok = false;
    await Effect.runPromise(
      client.update((root) => {
        const k = root.plugin.kernel;
        const view = k.views.find(
          (v) => v.scope === "chat" && v.params.agentId === args.agentId,
        );
        if (!view) return;
        ok = true;
        const existing = k.viewState[view.id];
        const baseDraft = existing?.draft ?? {
          editorState: null,
          blobs: [],
        };
        const nextEditorState = appendTokenToEditorState(
          baseDraft.editorState,
          args.payload,
        );
        const nextBlobs = [
          ...(baseDraft.blobs ?? []),
          ...(args.payload.blobs ?? []).map((b) => ({
            blobId: b.blobId,
            mimeType: b.mimeType,
          })),
        ];
        const next = existing
          ? {
              ...existing,
              draft: {
                editorState: nextEditorState as unknown,
                blobs: nextBlobs,
              },
            }
          : makeViewAppState(view.id, {
              draft: {
                editorState: nextEditorState as unknown,
                blobs: nextBlobs,
              },
            });
        k.viewState = { ...k.viewState, [view.id]: next };
      }),
    ).catch((err) => {
      console.error("[insert] insertTokenForAgent persist failed:", err);
      ok = false;
    });
    return { ok };
  }

  evaluate() {
    console.log("[insert] service ready");
  }
}

runtime.register(InsertService, (import.meta as any).hot);
