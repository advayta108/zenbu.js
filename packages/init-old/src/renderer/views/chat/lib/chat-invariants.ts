import type { MaterializedMessage } from "./materialize"

const PREFIX = "[chat invariant violation]"
const seenInvariantKeys = new Set<string>()

export type ExpectedVisibleMessage = {
  agentId: string
  timestamp: number
  createdAt: number
  textPreview: string
  imageCount: number
}

declare global {
  interface Window {
    __chatInvariants?: Array<{
      at: number
      code: string
      details: Record<string, unknown>
    }>
  }
}

export function summarizeMessage(
  message: MaterializedMessage | undefined,
): Record<string, unknown> | null {
  if (!message) return null

  switch (message.role) {
    case "user":
      return {
        key: message.key ?? null,
        role: message.role,
        timeSent: message.timeSent ?? null,
        contentLength: message.content.length,
        contentPreview: message.content.slice(0, 80),
        imageCount: message.images?.length ?? 0,
      }
    case "assistant":
    case "thinking":
      return {
        key: message.key ?? null,
        role: message.role,
        contentLength: message.content.length,
        contentPreview: message.content.slice(0, 80),
      }
    case "tool":
      return {
        key: message.key ?? null,
        role: message.role,
        toolCallId: message.toolCallId,
        status: message.status,
        childCount: message.children.length,
      }
    case "plan":
      return {
        key: message.key ?? null,
        role: message.role,
        entryCount: message.entries.length,
      }
    case "permission_request":
      return {
        key: message.key ?? null,
        role: message.role,
        toolCallId: message.toolCallId,
        optionCount: message.options.length,
      }
    case "ask_question":
      return {
        key: message.key ?? null,
        role: message.role,
        toolCallId: message.toolCallId,
        questionPreview: message.question.slice(0, 80),
      }
    case "auth_event":
      return {
        key: message.key ?? null,
        role: message.role,
        status: message.status,
        authMethodCount: message.authMethods.length,
      }
    case "interrupted":
      return {
        key: message.key ?? null,
        role: message.role,
      }
  }
}

export function reportChatInvariant(
  code: string,
  details: Record<string, unknown>,
  dedupeKey?: string,
): void {
  if (typeof process !== "undefined" && process.env.NODE_ENV === "production") {
    return
  }

  if (dedupeKey) {
    if (seenInvariantKeys.has(dedupeKey)) return
    seenInvariantKeys.add(dedupeKey)
  }

  const at = Date.now()
  window.__chatInvariants ??= []
  window.__chatInvariants.push({ at, code, details })

  const error = new Error(`${PREFIX} ${code}`)
  console.error(error, details)
}
