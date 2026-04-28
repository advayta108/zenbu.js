import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createTextNode,
  $getRoot,
  $getNodeByKey,
  $insertNodes,
  $createParagraphNode,
} from "lexical";
import { $createTokenNode, $isTokenNode, TokenNode } from "../lib/TokenNode";
import { subscribeTokenInsert, subscribeTokenUpgrade } from "../lib/token-bus";

/**
 * Subscribes to window-scoped insert/upgrade events and applies them to the
 * Lexical editor. Filters on `viewId` - there's exactly one composer
 * per view (rendered into one iframe), so a viewId match is the precise
 * "this insert is for me" check.
 *
 * `localId` in the TokenPayload's data is used to find a previously-inserted
 * transient node on upgrade. We stash it in the payload's `data._localId`
 * so it's round-trippable through persistence.
 */
export function TokenInsertPlugin({ viewId }: { viewId: string }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const unsubInsert = subscribeTokenInsert((d) => {
      if (d.viewId !== viewId) return;
      editor.update(() => {
        const payload = { ...d.payload };
        if (d.localId) {
          payload.data = { ...payload.data, _localId: d.localId };
        }
        const node = $createTokenNode(payload);
        const space = $createTextNode(" ");
        $insertNodes([node, space]);
        space.select();
      });
    });

    const unsubUpgrade = subscribeTokenUpgrade((d) => {
      if (d.viewId !== viewId) return;
      editor.update(() => {
        const existing = findTokenByLocalId($getRoot(), d.localId);
        if (existing) {
          existing.setPayload({
            ...d.payload,
            data: { ...d.payload.data, _localId: d.localId },
          });
        }
      });
    });

    return () => {
      unsubInsert();
      unsubUpgrade();
    };
  }, [editor, viewId]);

  return null;
}

function findTokenByLocalId(
  root: ReturnType<typeof $getRoot>,
  localId: string,
): TokenNode | null {
  const stack = [...root.getChildren()];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if ($isTokenNode(n)) {
      const p = n.getPayload();
      if (p.data?._localId === localId) return n;
    }
    if ("getChildren" in n && typeof n.getChildren === "function") {
      stack.push(...(n as any).getChildren());
    }
  }
  return null;
}

// Exported so other plugins can re-use the same lookup without duplicating it.
export { findTokenByLocalId };
