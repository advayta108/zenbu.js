import { useEffect, useMemo, useRef, useState } from "react";
import { useShortcutIframeRegistryOptional } from "../providers/shortcut-forwarder";
import { useFocusOnRequest } from "../../../lib/focus-request";
import { View, getViewIframe } from "../../../lib/View";
import type { View as ViewRow } from "../../../../../shared/schema";

/**
 * Renders the currently-active view's iframe in a window. Lazily mounts an
 * iframe per visited view (so switching back is instant) via `<View>`'s
 * LRU cache. The tab UI lives elsewhere - the agent sidebar (`AgentList`)
 * is the canonical view switcher.
 */
export function ActiveView({
  views,
  activeViewId,
}: {
  views: ViewRow[];
  activeViewId: string | null;
}) {
  const knownViewIds = useRef<Set<string>>(new Set());
  // ActiveView is mounted in both the orchestrator iframe (provider
  // present) and the workspace iframe (separate React tree, no provider).
  // The optional hook returns null in the second case; iframes mounted
  // there just don't get registered with the orchestrator's chord matcher.
  const shortcutIframes = useShortcutIframeRegistryOptional();

  useEffect(() => {
    if (!shortcutIframes) return;
    return () => {
      for (const viewId of knownViewIds.current) {
        shortcutIframes.unregister(viewId);
      }
    };
  }, [shortcutIframes]);

  useFocusOnRequest("active-view", () => {
    if (!activeViewId) return;
    const iframe = getViewIframe(activeViewId);
    iframe?.focus();
    iframe?.contentWindow?.focus();
  });

  // Lazy-mount: only render `<View>` for views the user has actually
  // visited. Switching back to a previously-visited view hits the LRU
  // cache (state preserved); never-visited views stay unmounted.
  const [visitedViewIds, setVisitedViewIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!activeViewId) return;
    setVisitedViewIds((prev) => {
      if (prev.has(activeViewId)) return prev;
      return new Set([...prev, activeViewId]);
    });
    requestAnimationFrame(() => {
      const iframe = getViewIframe(activeViewId);
      iframe?.focus();
    });
  }, [activeViewId]);

  // Forward focus to the active iframe when it announces it's ready.
  const activeViewIdRef = useRef(activeViewId);
  activeViewIdRef.current = activeViewId;
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (
        !e.data ||
        typeof e.data !== "object" ||
        (e.data as { type?: unknown }).type !== "zenbu-iframe-ready"
      )
        return;
      const activeId = activeViewIdRef.current;
      if (!activeId) return;
      const iframe = getViewIframe(activeId);
      if (iframe?.contentWindow === e.source) {
        iframe.focus();
        iframe.contentWindow?.postMessage(
          { type: "zenbu-focus-editor" },
          "*",
        );
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const viewsToRender = useMemo(
    () => views.filter((v) => visitedViewIds.has(v.id)),
    [views, visitedViewIds],
  );

  return (
    <div className="flex h-full flex-col min-h-0 min-w-0">
      <div className="relative flex-1 min-h-0">
        {activeViewId ? (
          viewsToRender.map((view) => {
            knownViewIds.current.add(view.id);
            const isActive = view.id === activeViewId;
            return (
              <View
                key={view.id}
                id={view.id}
                scope={view.scope}
                props={view.props}
                pinned={isActive}
                hidden={!isActive}
                onLoad={(win) => shortcutIframes?.register(view.id, win)}
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  display: isActive ? "block" : "none",
                }}
              />
            );
          })
        ) : (
          <div className="flex h-full items-center justify-center text-neutral-400 text-xs">
            Empty window
          </div>
        )}
      </div>
    </div>
  );
}
