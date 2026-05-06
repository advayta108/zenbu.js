// Content script injected into every view iframe by ShortcutService.
//
// Responsibilities:
//   1. Listen for keydown in the iframe (capture phase, before app code).
//   2. If the combo is a known binding or chord prefix, preventDefault
//      synchronously — otherwise cmd+s / cmd+w / cmd+r would execute the
//      browser default before the orchestrator gets a chance to resolve.
//   3. Forward the stroke to window.parent via postMessage so the root
//      orchestrator can resolve against the full registry, match chords, and
//      dispatch via RPC.
//   4. Also re-forward inbound shortcut messages (from potential nested
//      iframes in the future) upward.
//
// Bindings are pushed down from the orchestrator via
// postMessage({ type: "zenbu-shortcut:bindings", ... }). Until the first push
// arrives, we forward everything but preventDefault nothing — small warm-up
// window where browser defaults win.

import { comboFromEvent } from "./shortcut-keys";

type BindingsMessage = {
  type: "zenbu-shortcut:bindings";
  exact: string[];
  prefixes: string[];
};

type KeydownMessage = {
  type: "zenbu-shortcut:keydown";
  scope: string;
  combo: string;
  armed: boolean;
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

function detectScope(): string {
  const m = window.location.pathname.match(/^\/views\/([^/]+)\//);
  if (m) return m[1]!;
  return "unknown";
}

const SCOPE = detectScope();
// Top frame (orchestrator) resolves shortcuts directly via its React
// forwarder — no need for a capture → postMessage round trip to itself.
const IS_TOP_FRAME = window.parent === window;

if (IS_TOP_FRAME) {
  console.log(
    `[shortcut-capture] skipped: top frame handles keys directly (scope=${SCOPE})`,
  );
}

// Local caches refreshed by parent pushes. We arm preventDefault when either
// set is non-empty.
let exactBindings = new Set<string>();
let prefixBindings = new Set<string>();
let armed = false; // true between the first key of a chord and the resolution

function shouldSwallow(combo: string): boolean {
  if (armed) return true;
  if (exactBindings.has(combo)) return true;
  if (prefixBindings.has(combo)) return true;
  return false;
}

if (!IS_TOP_FRAME) {
  // Cache the last bindings + armed messages so we can replay them to
  // iframes that mount after the orchestrator's initial broadcast (e.g.
  // a bottom-panel iframe opened on Cmd+J — created long after the
  // app shell received its bindings).
  let lastBindingsMsg: BindingsMessage | null = null;
  let lastArmedMsg: { type: "zenbu-shortcut:armed"; armed: boolean } | null =
    null;

  const childWindows = (): Window[] => {
    const out: Window[] = [];
    for (const f of Array.from(document.querySelectorAll("iframe"))) {
      const w = (f as HTMLIFrameElement).contentWindow;
      if (w) out.push(w);
    }
    return out;
  };
  const broadcastDown = (msg: unknown) => {
    for (const w of childWindows()) {
      try {
        w.postMessage(msg, "*");
      } catch {}
    }
  };
  const replayTo = (win: Window | null) => {
    if (!win) return;
    try {
      if (lastBindingsMsg) win.postMessage(lastBindingsMsg, "*");
      if (lastArmedMsg) win.postMessage(lastArmedMsg, "*");
    } catch {}
  };

  window.addEventListener("message", (e: MessageEvent) => {
    const data = e.data;
    if (!data || typeof data !== "object") return;

    if (data.type === "zenbu-shortcut:bindings") {
      const b = data as BindingsMessage;
      exactBindings = new Set(b.exact);
      prefixBindings = new Set(b.prefixes);
      lastBindingsMsg = b;
      // Relay to child iframes: the orchestrator only knows about
      // iframes registered through its ActiveView (chat/etc).
      // Iframes nested deeper (utility-sidebar plugins, bottom-panel
      // plugins) are mounted inside the app shell's React tree and
      // never get the orchestrator's direct push, so their local
      // bindings cache stays empty and `shouldSwallow` mis-fires.
      // Forwarding here closes the gap.
      broadcastDown(data);
      return;
    }

    if (data.type === "zenbu-shortcut:armed") {
      armed = Boolean((data as { armed: boolean }).armed);
      lastArmedMsg = data as { type: "zenbu-shortcut:armed"; armed: boolean };
      broadcastDown(data);
      return;
    }

    // Re-forward nested iframe messages upward (in case this iframe itself
    // contains further iframes).
    if (data.type === "zenbu-shortcut:keydown" && e.source !== window.parent) {
      try {
        window.parent.postMessage(data, "*");
      } catch {}
    }
  });

  // Replay bindings to iframes that mount after the initial push. The
  // <View> primitive creates iframes lazily (e.g. when the bottom panel
  // is first opened), so without this they boot with an empty bindings
  // cache and mis-handle the first few keystrokes.
  const onIframeAdded = (frame: HTMLIFrameElement) => {
    if (frame.contentWindow) replayTo(frame.contentWindow);
    frame.addEventListener("load", () => replayTo(frame.contentWindow));
  };
  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of Array.from(rec.addedNodes)) {
        if (node instanceof HTMLIFrameElement) {
          onIframeAdded(node);
        } else if (node instanceof HTMLElement) {
          for (const f of Array.from(node.querySelectorAll("iframe"))) {
            onIframeAdded(f as HTMLIFrameElement);
          }
        }
      }
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
  });

  const onKeydown = (event: KeyboardEvent) => {
    const combo = comboFromEvent(event);
    if (!combo) return;

    const swallow = shouldSwallow(combo);
    if (swallow) {
      event.preventDefault();
      event.stopPropagation();
    }

    const msg: KeydownMessage = {
      type: "zenbu-shortcut:keydown",
      scope: SCOPE,
      combo,
      armed,
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
    };

    try {
      window.parent.postMessage(msg, "*");
    } catch {}
  };

  window.addEventListener("keydown", onKeydown, true);
  document.addEventListener("keydown", onKeydown, true);

  console.log(`[shortcut-capture] installed scope=${SCOPE}`);
}
