// Orchestrator-root shortcut forwarder + keydown resolver.
//
// Responsibilities:
//   1. Read `shortcutRegistry`, `shortcutOverrides`, `shortcutDisabled` from
//      Kyju and compute effective bindings.
//   2. Push the resolved binding set to every view iframe via postMessage,
//      so the iframe capture script can preventDefault synchronously.
//   3. Listen for keydown on the orchestrator window (capture phase) AND for
//      "zenbu-shortcut:keydown" messages from child iframes. Feed both into
//      a single ChordMatcher.
//   4. On match: call `rpc.shortcut.dispatch(id, scope, windowId)`.
//      Main process runs backend handler (if any) and emits the
//      `shortcut.dispatched` event, which `useShortcutHandler` subscribers
//      filter locally.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useDb } from "../../../lib/kyju-react";
import { useRpc } from "../../../lib/providers";
import { comboFromEvent } from "../../../lib/shortcut-keys";
import {
  ChordMatcher,
  bindingKeyUniverse,
  buildResolvedBindings,
  type ResolvedBinding,
} from "./chord-matcher";

type IframeRegistry = {
  register: (id: string, win: Window) => void;
  unregister: (id: string) => void;
};

const IframeRegistryContext = createContext<IframeRegistry | null>(null);

export function useShortcutIframeRegistry(): IframeRegistry {
  const ctx = useContext(IframeRegistryContext);
  if (!ctx)
    throw new Error(
      "useShortcutIframeRegistry must be used inside ShortcutForwarderProvider",
    );
  return ctx;
}

/**
 * No-throw variant for components that may be rendered outside a
 * `ShortcutForwarderProvider`. Currently used by `ActiveView`, which is
 * rendered both inside the orchestrator iframe (provider present) and
 * inside the workspace iframe (separate React tree, no provider). Iframe
 * shortcut forwarding is per-tree; the workspace iframe's children just
 * don't get registered with the orchestrator's matcher.
 */
export function useShortcutIframeRegistryOptional(): IframeRegistry | null {
  return useContext(IframeRegistryContext);
}

type CaptureLock = {
  acquire: () => () => void;
};

const CaptureLockContext = createContext<CaptureLock | null>(null);

/**
 * Temporarily suppress shortcut dispatch from the forwarder. Use this when
 * capturing raw keystrokes (e.g., the binding editor) so that pressing the
 * shortcut you're rebinding doesn't *fire* the shortcut.
 */
export function useShortcutCaptureLock(active: boolean) {
  const lock = useContext(CaptureLockContext);
  useEffect(() => {
    if (!active || !lock) return;
    const release = lock.acquire();
    return release;
  }, [active, lock]);
}

export function ShortcutForwarderProvider({
  windowId,
  children,
}: {
  windowId: string;
  children: ReactNode;
}) {
  const rpc = useRpc();

  const registry = useDb((root) => root.plugin.kernel.shortcutRegistry) ?? [];
  const overrides =
    useDb((root) => root.plugin.kernel.shortcutOverrides) ?? {};
  const disabled = useDb((root) => root.plugin.kernel.shortcutDisabled) ?? [];

  // Focus is window-level only post-refactor (no panes).

  const resolved: ResolvedBinding[] = useMemo(
    () => buildResolvedBindings(registry, overrides, disabled),
    [registry, overrides, disabled],
  );
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;

  const iframeWindows = useRef<Map<string, Window>>(new Map());
  const iframeRegistry: IframeRegistry = useMemo(
    () => ({
      register: (id, win) => {
        iframeWindows.current.set(id, win);
        try {
          win.postMessage(buildBindingsMessage(resolvedRef.current), "*");
        } catch {}
      },
      unregister: (id) => {
        iframeWindows.current.delete(id);
      },
    }),
    [],
  );

  // Broadcast bindings whenever they change.
  useEffect(() => {
    const msg = buildBindingsMessage(resolved);
    for (const win of iframeWindows.current.values()) {
      try {
        win.postMessage(msg, "*");
      } catch {}
    }
  }, [resolved]);

  const matcherRef = useRef(new ChordMatcher(1000));
  const lastArmedRef = useRef(false);
  const captureLocksRef = useRef(0);
  const captureLock: CaptureLock = useMemo(
    () => ({
      acquire: () => {
        captureLocksRef.current += 1;
        return () => {
          captureLocksRef.current = Math.max(0, captureLocksRef.current - 1);
        };
      },
    }),
    [],
  );

  // Push armed state to child iframes so they swallow the next key during
  // an active chord even if it isn't in the binding set. Only broadcasts on
  // actual transitions — iframes are eventually-consistent, not watching
  // every keystroke.
  const broadcastArmed = useCallback((armed: boolean) => {
    if (lastArmedRef.current === armed) return;
    lastArmedRef.current = armed;
    const msg = { type: "zenbu-shortcut:armed", armed };
    for (const win of iframeWindows.current.values()) {
      try {
        win.postMessage(msg, "*");
      } catch {}
    }
  }, []);

  const dispatchMatch = useCallback(
    (binding: ResolvedBinding) => {
      console.log(
        `[shortcut-forwarder] match "${binding.id}" scope=${binding.scope}`,
      );
      void rpc.shortcut
        .dispatch(binding.id, binding.scope, windowId)
        .catch((err: unknown) => {
          console.error(`[shortcut-forwarder] dispatch failed:`, err);
        });
    },
    [rpc, windowId],
  );

  // Orchestrator-native keydown capture.
  useEffect(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (captureLocksRef.current > 0) return;
      const combo = comboFromEvent(e);
      if (!combo) return;
      const result = matcherRef.current.processCombo(combo, resolvedRef.current);
      if (result.kind === "match") {
        e.preventDefault();
        e.stopPropagation();
        broadcastArmed(false);
        dispatchMatch(result.binding);
        return;
      }
      if (result.kind === "prefix") {
        e.preventDefault();
        e.stopPropagation();
        broadcastArmed(true);
        return;
      }
      // Non-match — matcher has reset; ensure iframes know.
      broadcastArmed(false);
    };
    window.addEventListener("keydown", onKeydown, true);
    return () => window.removeEventListener("keydown", onKeydown, true);
  }, [broadcastArmed, dispatchMatch]);

  // Messages from child iframes.
  useEffect(() => {
    type IframeKeydownMessage = {
      type: "zenbu-shortcut:keydown";
      combo: string;
      scope: string;
    };
    const isIframeKeydownMessage = (
      v: unknown,
    ): v is IframeKeydownMessage => {
      if (!v || typeof v !== "object") return false;
      const m = v as Partial<IframeKeydownMessage>;
      return (
        m.type === "zenbu-shortcut:keydown" &&
        typeof m.combo === "string" &&
        typeof m.scope === "string"
      );
    };

    const onMessage = (e: MessageEvent) => {
      if (!isIframeKeydownMessage(e.data)) return;
      if (captureLocksRef.current > 0) return;

      const { combo, scope } = e.data;
      if (!combo) return;

      const result = matcherRef.current.processCombo(
        combo,
        resolvedRef.current,
      );

      if (result.kind === "match") {
        broadcastArmed(false);
        // Override scope with the iframe's reported scope so the event
        // routes to the right iframe via `useShortcutHandler` focus check.
        const b = result.binding;
        dispatchMatch({
          ...b,
          scope: b.scope === "global" ? scope : b.scope,
        });
        return;
      }
      if (result.kind === "prefix") {
        broadcastArmed(true);
        return;
      }
      broadcastArmed(false);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [broadcastArmed, dispatchMatch]);

  return (
    <CaptureLockContext.Provider value={captureLock}>
      <IframeRegistryContext.Provider value={iframeRegistry}>
        {children}
      </IframeRegistryContext.Provider>
    </CaptureLockContext.Provider>
  );
}

function buildBindingsMessage(resolved: ResolvedBinding[]) {
  const { exact, prefixes } = bindingKeyUniverse(resolved);
  return {
    type: "zenbu-shortcut:bindings",
    exact: [...exact],
    prefixes: [...prefixes],
  };
}
