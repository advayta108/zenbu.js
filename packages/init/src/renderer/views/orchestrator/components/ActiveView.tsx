import { useEffect, useMemo, useRef, useState } from "react";
import { useShortcutIframeRegistryOptional } from "../providers/shortcut-forwarder";
import { useFocusOnRequest } from "../../../lib/focus-request";
import { ViewCacheSlot, getCachedIframe } from "../../../lib/view-cache";
import type { View } from "../../../../../shared/schema";

/**
 * Renders the currently-active view's iframe in a window. Lazily mounts an
 * iframe per visited view (so switching back is instant) and hides the
 * inactive ones via `display: none`. The tab UI lives elsewhere - the
 * agent sidebar (`AgentList`) is the canonical view switcher.
 */
export function ActiveView({
  views,
  activeViewId,
  registryMap,
  wsPort,
  wsToken,
  windowId,
}: {
  views: View[];
  activeViewId: string | null;
  registryMap: Map<string, { scope: string; url: string; port: number }>;
  wsPort: number;
  wsToken: string;
  windowId: string;
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
    const iframe = getCachedIframe(activeViewId);
    iframe?.focus();
    iframe?.contentWindow?.focus();
  });

  // Lazy-mount: only mount iframes for views the user has actually
  // visited. Switching back to a previously-visited view re-uses the
  // cached iframe (state preserved); never-visited views stay unmounted.
  const [visitedViewIds, setVisitedViewIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!activeViewId) return;
    setVisitedViewIds((prev) => {
      if (prev.has(activeViewId)) return prev;
      return new Set([...prev, activeViewId]);
    });
    requestAnimationFrame(() => {
      const iframe = getCachedIframe(activeViewId);
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
      const iframe = getCachedIframe(activeId);
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
            // Single-path resolution: scope is a hard FK into viewRegistry.
            // The renderer never branches on view.scope - it just looks up
            // the entry and builds the URL.
            const entry = registryMap.get(view.scope);
            if (!entry) return null;
            let entryPath = new URL(entry.url).pathname;
            const ownsServer = entryPath === "/" || entryPath === "";
            if (ownsServer) entryPath = "";
            else if (entryPath.endsWith("/")) entryPath = entryPath.slice(0, -1);
            // Aliased views (e.g. "chat") proxy through the kernel's wsPort.
            // Own-server views (e.g. plugin scopes) go directly to their
            // plugin's Vite port - the kernel HTTP proxy only routes to core.
            const targetPort = ownsServer ? entry.port : wsPort;
            const hostname = view.id.toLowerCase().replace(/[^a-z0-9]/g, "");
            // Standard query params + view.params (renderer-specific shape).
            const baseParams: Record<string, string> = {
              wsPort: String(wsPort),
              wsToken,
              windowId,
              viewId: view.id,
              ...view.params,
            };
            const qs = Object.entries(baseParams)
              .map(
                ([k, v]) =>
                  `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
              )
              .join("&");
            const src = `http://${hostname}.localhost:${targetPort}${entryPath}/index.html?${qs}`;
            knownViewIds.current.add(view.id);
            const isActive = view.id === activeViewId;
            return (
              <ViewCacheSlot
                key={view.id}
                cacheKey={view.id}
                src={src}
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
