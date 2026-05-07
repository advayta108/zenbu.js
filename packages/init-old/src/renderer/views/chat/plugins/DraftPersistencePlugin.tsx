import { useEffect, useRef, useCallback } from "react"
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext"
import { useKyjuClient } from "../../../lib/providers"
import { migrateLegacyNodesInEditorState } from "../../../../../shared/editor-state"

const DEBOUNCE_MS = 300
const MAX_STALE_MS = 4000

function isEditorStateEmpty(state: any): boolean {
  const root = state.root
  if (!root?.children?.length) return true
  for (const block of root.children) {
    if (!block.children?.length) continue
    for (const inline of block.children) {
      if (inline.type === "linebreak") continue
      if (inline.type === "text") {
        if (inline.text && inline.text.trim() !== "") return false
      } else {
        // FileReferenceNode, ImageNode, or any other non-text node = content
        return false
      }
    }
  }
  return true
}

/**
 * Imperative flush reference exposed for the refocus-rehydrate path.
 * When the composer loses focus, `RefocusRehydratePlugin` calls `flush()`
 * on the current plugin instance so the latest local edits are in the
 * persisted draft before any external writer (e.g. InsertService) touches
 * it. Once focus returns, rehydrate can safely replace editor state.
 *
 * TODO(crdt): The split between "draft is authoritative while blurred"
 * and "composer is authoritative while focused" exists because we have
 * no merge protocol for two writers. A CRDT would fold remote ops in
 * without a handoff.
 */
type DraftFlush = { flush: () => void }
const activeFlushByView = new Map<string, DraftFlush>()

export function getDraftFlush(viewId: string): (() => void) | null {
  const entry = activeFlushByView.get(viewId)
  return entry ? entry.flush : null
}

export function DraftPersistencePlugin({ viewId }: { viewId: string }) {
  const [editor] = useLexicalComposerContext()
  const client = useKyjuClient()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idleRef = useRef<number | null>(null)
  const lastSaveRef = useRef<number>(Date.now())

  const saveDraft = useCallback(() => {
    lastSaveRef.current = Date.now()
    const state = editor.getEditorState().toJSON()
    const viewStateRecord = client.plugin.kernel.viewState.read() ?? {}
    const current = viewStateRecord[viewId]
    if (!current) return

    const blobs = current.draft?.blobs ?? []

    if (isEditorStateEmpty(state) && blobs.length === 0) {
      // Empty draft - clear it on the view's state record.
      if (current.draft != null) {
        const next = { ...viewStateRecord, [viewId]: { ...current, draft: null } }
        client.plugin.kernel.viewState.set(next)
      }
      return
    }

    const next = {
      ...viewStateRecord,
      [viewId]: {
        ...current,
        draft: { editorState: state, blobs },
      },
    }
    client.plugin.kernel.viewState.set(next)
  }, [editor, client, viewId])

  const cancelPending = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (idleRef.current != null) {
      cancelIdleCallback(idleRef.current)
      idleRef.current = null
    }
  }, [])

  const scheduleSave = useCallback(() => {
    cancelPending()
    const stale = Date.now() - lastSaveRef.current >= MAX_STALE_MS
    if (stale) {
      // Stale - save on next idle, with a timeout fallback
      idleRef.current = requestIdleCallback(() => {
        idleRef.current = null
        saveDraft()
      }, { timeout: DEBOUNCE_MS })
    } else {
      timerRef.current = setTimeout(saveDraft, DEBOUNCE_MS)
    }
  }, [saveDraft, cancelPending])

  useEffect(() => {
    const unregister = editor.registerUpdateListener(scheduleSave)
    return () => {
      unregister()
    }
  }, [editor, scheduleSave])

  // Register this plugin's imperative flush so RefocusRehydratePlugin can
  // force a synchronous persist when the composer blurs. Scope to viewId
  // because the orchestrator may have multiple composer iframes in flight
  // during HMR transitions.
  const flushNow = useCallback(() => {
    cancelPending()
    saveDraft()
  }, [cancelPending, saveDraft])

  useEffect(() => {
    activeFlushByView.set(viewId, { flush: flushNow })
    return () => {
      const current = activeFlushByView.get(viewId)
      if (current && current.flush === flushNow) {
        activeFlushByView.delete(viewId)
      }
    }
  }, [viewId, flushNow])

  // Flush on unmount if anything is pending
  useEffect(() => {
    return () => {
      if (timerRef.current || idleRef.current != null) {
        cancelPending()
        saveDraft()
      }
    }
  }, [saveDraft, cancelPending])

  return null
}

export function getInitialEditorState(
  client: any,
  viewId: string,
): string | null {
  const viewStateRecord = client.plugin.kernel.viewState.read() ?? {}
  const draft = viewStateRecord[viewId]?.draft
  if (!draft?.editorState) return null
  // Rewrite any legacy file-reference / image nodes to the generic token
  // shape on the way in. The next save (debounced) persists the migrated
  // JSON back, so drafts drift to the new shape without an explicit
  // migration pass.
  const migrated = migrateLegacyNodesInEditorState(draft.editorState)
  return JSON.stringify(migrated)
}

/** Check if a persisted draft has real content (for use outside the chat view) */
export function draftHasContent(draft: { editorState?: any; blobs?: any[] } | null | undefined): boolean {
  if (!draft) return false
  if (draft.blobs?.length) return true
  if (!draft.editorState) return false
  return !isEditorStateEmpty(draft.editorState)
}
