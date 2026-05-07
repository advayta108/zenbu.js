import { useEffect } from "react"
import { nanoid } from "nanoid"
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext"
import {
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_HIGH,
  PASTE_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  $getSelection,
  $isRangeSelection,
  $isNodeSelection,
  $isElementNode,
  type LexicalNode,
} from "lexical"
import { ImageNode, $isImageNode } from "../lib/ImageNode"
import { $isTokenNode, TokenNode } from "../lib/TokenNode"
import {
  dispatchTokenInsert,
  dispatchTokenUpgrade,
} from "../lib/token-bus"
import { useKyjuClient, useRpc } from "../../../lib/providers"

/**
 * True for any inline decorator pill this plugin should treat as a unit
 * for delete (backspace swallows the whole pill instead of the character
 * before it). Kept broad so legacy ImageNodes in existing drafts keep
 * working alongside new TokenNodes.
 */
function isPillNode(node: LexicalNode | null | undefined): boolean {
  return $isImageNode(node) || $isTokenNode(node)
}

function $getAdjacentPillNode(backward: boolean): LexicalNode | null {
  const selection = $getSelection()
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null

  const anchor = selection.anchor
  const node = anchor.getNode()

  if (anchor.type === "element" && $isElementNode(node)) {
    const children = node.getChildren()
    const target = backward
      ? children[anchor.offset - 1]
      : children[anchor.offset]
    if (isPillNode(target)) return target
    return null
  }

  if (backward) {
    if (anchor.offset === 0) {
      const prev = node.getPreviousSibling()
      if (isPillNode(prev)) return prev
    }
  } else {
    if (anchor.offset === node.getTextContentSize()) {
      const next = node.getNextSibling()
      if (isPillNode(next)) return next
    }
  }

  return null
}

/**
 * Clipboard image -> composer pill. Same two-stage UX as before (optimistic
 * "uploading" placeholder, upgraded to "ready" once the blob lands on
 * disk), but now both stages go through the token-bus so a single
 * TokenNode class handles them - the plugin never touches Lexical
 * directly.
 *
 * The local uploading-stub uses `dispatchTokenInsert({source:"paste"})`
 * with a fresh `localId`. When upload finishes, `dispatchTokenUpgrade`
 * with the same `localId` rewrites the payload in place.
 *
 * Blob bookkeeping: we append the freshly-uploaded blob to the view's
 * draft blobs (`viewState[viewId].draft.blobs`) so the composer's submit
 * path can find it. The DraftPersistencePlugin also keeps draft.blobs in
 * sync via its own debounced save.
 */
export function ImagePastePlugin({
  viewId,
  agentId,
}: { viewId: string; agentId: string } = { viewId: "", agentId: "" }) {
  const [editor] = useLexicalComposerContext()
  const client = useKyjuClient()
  const _rpc = useRpc() // kept so HMR plumbing matches other plugins

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        const clipboardData =
          event instanceof ClipboardEvent ? event.clipboardData : null
        if (!clipboardData) return false

        const imageFile = Array.from(clipboardData.files).find((f) =>
          f.type.startsWith("image/"),
        )
        if (!imageFile) return false

        const selection = $getSelection()
        if (!$isRangeSelection(selection)) return false

        event.preventDefault()

        const mimeType = imageFile.type
        const localSrc = URL.createObjectURL(imageFile)
        const localId = nanoid()

        // Stage 1: optimistic pill (uploading).
        dispatchTokenInsert({
          viewId,
          agentId,
          source: "paste",
          localId,
          payload: {
            kind: "image",
            title: "Image",
            data: { status: "uploading", localSrc },
            blobs: [],
          },
        })

        imageFile
          .arrayBuffer()
          .then(async (buffer) => {
            const data = new Uint8Array(buffer)
            const blobId = await (client as any).createBlob(data, true)

            // Append the new blob to the view's draft blobs.
            const viewStateRecord = client.plugin.kernel.viewState.read() ?? {}
            const cur = viewStateRecord[viewId]
            if (cur) {
              const existingBlobs = cur.draft?.blobs ?? []
              const next = {
                ...viewStateRecord,
                [viewId]: {
                  ...cur,
                  draft: {
                    editorState: cur.draft?.editorState ?? null,
                    blobs: [...existingBlobs, { blobId, mimeType }],
                  },
                },
              }
              await client.plugin.kernel.viewState.set(next)
            }

            // Stage 2: upgrade the stub to ready + real blob id.
            dispatchTokenUpgrade({
              viewId,
              agentId,
              localId,
              payload: {
                kind: "image",
                title: "Image",
                data: { status: "ready", localSrc },
                blobs: [{ blobId, mimeType, role: "image" }],
              },
            })
          })
          .catch((err) => {
            console.error("[ImagePaste] failed:", err)
          })

        return true
      },
      COMMAND_PRIORITY_CRITICAL,
    )
  }, [editor, client, viewId, agentId])

  useEffect(() => {
    const handleDelete = (backward: boolean) => {
      const sel = $getSelection()
      if ($isNodeSelection(sel)) {
        const pills = sel.getNodes().filter(isPillNode)
        if (pills.length > 0) {
          for (const node of pills) node.remove()
          return true
        }
      }

      const adjacent = $getAdjacentPillNode(backward)
      if (adjacent) {
        adjacent.remove()
        return true
      }

      return false
    }

    const unregBackspace = editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event) => {
        const handled = handleDelete(true)
        if (handled) event.preventDefault()
        return handled
      },
      COMMAND_PRIORITY_HIGH,
    )
    const unregDelete = editor.registerCommand(
      KEY_DELETE_COMMAND,
      (event) => {
        const handled = handleDelete(false)
        if (handled) event.preventDefault()
        return handled
      },
      COMMAND_PRIORITY_HIGH,
    )
    return () => {
      unregBackspace()
      unregDelete()
    }
  }, [editor])

  return null
}

// Keep the named exports so existing callers that imported ImageNode from
// this module don't need to change.
export { ImageNode }
