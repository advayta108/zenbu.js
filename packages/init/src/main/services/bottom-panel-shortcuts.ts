import { Service, runtime } from "../runtime";
import { ShortcutService } from "./shortcut";

/**
 * Registers the canonical Cmd+J shortcut for toggling the workspace's
 * bottom panel. The actual toggle logic lives in the workspace renderer
 * (`useShortcutHandler` flips
 * `plugin["agent-manager"].workspaceState[id].bottomPanelOpen`),
 * matching the renderer-handler pattern used by `chat.interrupt` /
 * `chat.openMode`. Registering here puts the binding in the settings UI
 * and makes it overridable.
 */
export class BottomPanelShortcutsService extends Service {
  static key = "bottom-panel-shortcuts";
  static deps = { shortcut: ShortcutService };
  declare ctx: { shortcut: ShortcutService };

  evaluate() {
    this.setup("register:toggleBottomPanel", () =>
      this.ctx.shortcut.register({
        id: "kernel.toggleBottomPanel",
        defaultBinding: "cmd+j",
        description: "Toggle the bottom panel",
        scope: "global",
      }),
    );
  }
}

runtime.register(BottomPanelShortcutsService, (import.meta as any).hot);
