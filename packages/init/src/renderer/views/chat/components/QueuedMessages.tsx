import { useCallback, useEffect, useMemo, useState } from "react"
import { LexicalComposer } from "@lexical/react/LexicalComposer"
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin"
import { ContentEditable } from "@lexical/react/LexicalContentEditable"
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext"
import {
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  COMMAND_PRIORITY_HIGH,
} from "lexical"
import { ChevronRightIcon, PencilIcon, Trash2Icon } from "lucide-react"
import { ImageNode } from "../lib/ImageNode"
import { FileReferenceNode } from "../lib/FileReferenceNode"
import { TokenNode } from "../lib/TokenNode"
import {
  $deserializeUserMessage,
  hasRehydratableEditorState,
} from "../lib/deserialize"
import { serializeEditorContent, type CollectedImage } from "../lib/serialize"
import { useDb } from "../../../lib/kyju-react"
import { useKyjuClient } from "../../../lib/providers"

type QueuedMessageView = {
  id: string
  text: string
  images: { blobId: string; mimeType: string }[]
  editorState: unknown | null
  createdAt: number
}

function PassthroughErrorBoundary({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

function makeRowEditorConfig(message: QueuedMessageView, editable: boolean) {
  const nodes = [ImageNode, FileReferenceNode, TokenNode]
  if (hasRehydratableEditorState(message.editorState)) {
    return {
      namespace: `queued-row-${message.id}`,
      editable,
      nodes,
      editorState: JSON.stringify(message.editorState),
      onError: (error: Error) => console.error(error),
    }
  }
  return {
    namespace: `queued-row-${message.id}`,
    editable,
    nodes,
    editorState: () =>
      $deserializeUserMessage(message.text, message.images ?? []),
    onError: (error: Error) => console.error(error),
  }
}

function EditPlugin({
  onSave,
  onCancel,
}: {
  onSave: (
    text: string,
    images: CollectedImage[],
    editorStateJson: unknown,
  ) => void
  onCancel: () => void
}) {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    editor.focus()
  }, [editor])

  useEffect(() => {
    const offEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (event?.shiftKey) return false
        event?.preventDefault()
        const editorStateJson = editor.getEditorState().toJSON()
        editor.getEditorState().read(() => {
          const { text, images } = serializeEditorContent()
          onSave(text, images, editorStateJson)
        })
        return true
      },
      COMMAND_PRIORITY_HIGH,
    )
    const offEsc = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      () => {
        onCancel()
        return true
      },
      COMMAND_PRIORITY_HIGH,
    )
    return () => {
      offEnter()
      offEsc()
    }
  }, [editor, onSave, onCancel])

  return null
}

function QueuedRow({
  message,
  onSave,
  onDelete,
}: {
  message: QueuedMessageView
  onSave: (
    id: string,
    text: string,
    images: CollectedImage[],
    editorStateJson: unknown,
  ) => void
  onDelete: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const config = useMemo(
    () => makeRowEditorConfig(message, editing),
    // Re-mount when message id changes or edit mode toggles so Lexical
    // gets a fresh initialConfig with the current editorState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [message.id, editing, message.editorState, message.text],
  )

  const handleSave = useCallback(
    (text: string, images: CollectedImage[], editorStateJson: unknown) => {
      onSave(message.id, text, images, editorStateJson)
      setEditing(false)
    },
    [message.id, onSave],
  )

  return (
    <div className="group/qrow flex items-center gap-2 px-3 py-1 text-sm">
      <span
        aria-hidden
        className="size-3 shrink-0 rounded-full border border-neutral-400/70"
      />
      <div className="min-w-0 flex-1 truncate text-neutral-700">
        <LexicalComposer
          key={`${message.id}-${editing ? "edit" : "view"}`}
          initialConfig={config}
        >
          <PlainTextPlugin
            contentEditable={
              <ContentEditable
                className="outline-none whitespace-pre-wrap wrap-break-word"
                spellCheck={false}
              />
            }
            placeholder={null}
            ErrorBoundary={PassthroughErrorBoundary}
          />
          {editing && (
            <EditPlugin onSave={handleSave} onCancel={() => setEditing(false)} />
          )}
        </LexicalComposer>
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/qrow:opacity-100">
        <button
          type="button"
          onClick={() => setEditing((e) => !e)}
          className="rounded p-1 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-800"
          title={editing ? "Cancel edit" : "Edit"}
        >
          <PencilIcon className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onDelete(message.id)}
          className="rounded p-1 text-neutral-500 hover:bg-neutral-200 hover:text-red-600"
          title="Remove"
        >
          <Trash2Icon className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

export function QueuedMessages({ agentId }: { agentId: string }) {
  const [expanded, setExpanded] = useState(false)
  const messages = useDb(
    (root) =>
      root.plugin.kernel.agents.find((a: { id: string }) => a.id === agentId)
        ?.queuedMessages ?? [],
  ) as QueuedMessageView[]
  const client = useKyjuClient()

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await client.update((root) => {
          const a = root.plugin.kernel.agents.find(
            (x: { id: string }) => x.id === agentId,
          )
          if (!a) return
          a.queuedMessages = (a.queuedMessages ?? []).filter(
            (m: { id: string }) => m.id !== id,
          )
        })
      } catch (err) {
        console.error("[queued-messages] delete failed", err)
      }
    },
    [client, agentId],
  )

  const handleSave = useCallback(
    async (
      id: string,
      text: string,
      images: CollectedImage[],
      editorStateJson: unknown,
    ) => {
      try {
        await client.update((root) => {
          const a = root.plugin.kernel.agents.find(
            (x: { id: string }) => x.id === agentId,
          )
          if (!a) return
          a.queuedMessages = (a.queuedMessages ?? []).map(
            (m: QueuedMessageView) =>
              m.id === id
                ? {
                    ...m,
                    text,
                    images: images.map((img) => ({
                      blobId: img.blobId,
                      mimeType: img.mimeType,
                    })),
                    editorState: editorStateJson ?? null,
                  }
                : m,
          )
        })
      } catch (err) {
        console.error("[queued-messages] save failed", err)
      }
    },
    [client, agentId],
  )

  if (messages.length === 0) return null

  return (
    <div className="mx-auto w-full max-w-[919px] px-4">
      <div className="rounded-lg border border-(--zenbu-composer-border) bg-(--zenbu-composer)">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-neutral-600 hover:text-neutral-900"
        >
          <ChevronRightIcon
            className={`size-3.5 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
          <span>
            {messages.length} Queued
          </span>
        </button>
        {expanded && (
          <div className="flex flex-col pb-1">
            {messages.map((m) => (
              <QueuedRow
                key={m.id}
                message={m}
                onSave={handleSave}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
