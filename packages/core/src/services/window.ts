import {
  WebContentsView,
  clipboard,
  dialog,
  shell,
  type OpenDialogOptions,
  type WebPreferences,
} from "electron";
import electronContextMenu from "electron-context-menu";
import { URLSearchParams } from "node:url";
import { runtime, serviceWithDeps } from "../runtime";
import { BaseWindowService, MAIN_WINDOW_ID } from "./base-window";
import { ViewRegistryService } from "./view-registry";
import { HttpService } from "./http";
import { RendererHostService } from "./renderer-host";
import { createLogger } from "../shared/log";

const log = createLogger("window");

type MountedView = {
  windowId: string;
  scope: string;
  view: WebContentsView;
  disposeContextMenu: () => void;
};

function queryString(query?: Record<string, string | number | boolean | null | undefined>): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export class WindowService extends serviceWithDeps({
  baseWindow: BaseWindowService,
  viewRegistry: ViewRegistryService,
  http: HttpService,
  rendererHost: RendererHostService,
}) {
  static key = "window";

  private mounted = new Map<string, MountedView>();

  evaluate() {
    this.setup("window-view-cleanup", () => {
      return () => {
        for (const mounted of this.mounted.values()) {
          const win = this.ctx.baseWindow.windows.get(mounted.windowId);
          try {
            win?.contentView.removeChildView(mounted.view);
          } catch {}
          try {
            mounted.disposeContextMenu();
          } catch {}
          mounted.view.webContents.close();
        }
        this.mounted.clear();
      };
    });
  }

  async openView(args: {
    scope: string;
    windowId?: string;
    query?: Record<string, string | number | boolean | null | undefined>;
    view?: {
      backgroundColor?: string;
      webPreferences?: WebPreferences;
    };
  }): Promise<{ windowId: string }> {
    const entry = this.ctx.viewRegistry.get(args.scope);
    if (!entry) throw new Error(`No registered view for scope "${args.scope}"`);

    const windowId = args.windowId ?? MAIN_WINDOW_ID;
    let win = this.ctx.baseWindow.windows.get(windowId);
    if (!win) {
      win = this.ctx.baseWindow.createWindow({ windowId }).win;
    }

    const existing = this.mounted.get(windowId);
    if (existing) {
      try {
        win.contentView.removeChildView(existing.view);
      } catch {}
      try {
        existing.disposeContextMenu();
      } catch {}
      existing.view.webContents.close();
      this.mounted.delete(windowId);
    }

    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        ...args.view?.webPreferences,
      },
    });
    view.setBackgroundColor(args.view?.backgroundColor ?? "#F4F4F4");
    win.contentView.addChildView(view);

    // Right-click → standard browser context menu with "Inspect Element" so
    // the framework's iframes are debuggable out of the box.
    const disposeContextMenu = electronContextMenu({
      window: view,
      showInspectElement: true,
      showSearchWithGoogle: false,
      showSelectAll: true,
    });

    // Keyboard shortcut to toggle devtools without right-clicking. Mirrors
    // Chrome / Electron's defaults, which a `WebContentsView` doesn't get
    // automatically (those defaults only fire on a top-level `BrowserWindow`).
    const handleInput = (
      _event: Electron.Event,
      input: Electron.Input,
    ) => {
      const isToggle =
        (input.key === "I" || input.key === "i") &&
        ((process.platform === "darwin" && input.alt && input.meta) ||
          (process.platform !== "darwin" && input.shift && input.control));
      if (isToggle || input.key === "F12") {
        if (view.webContents.isDevToolsOpened()) {
          view.webContents.closeDevTools();
        } else {
          view.webContents.openDevTools({ mode: "detach" });
        }
      }
    };
    view.webContents.on("before-input-event", handleInput);

    const layout = () => {
      const { width, height } = win.getContentBounds();
      view.setBounds({ x: 0, y: 0, width, height });
    };
    layout();
    win.on("resize", layout);
    view.webContents.once("destroyed", () => {
      win.off("resize", layout);
      try {
        disposeContextMenu();
      } catch {}
    });

    const url = `${entry.url.replace(/\/$/, "")}/index.html${queryString({
      ...args.query,
      wsPort: this.ctx.http.port,
      wsToken: this.ctx.http.authToken,
      windowId,
      // The advice/content-script prelude reads `?scope=` to pick which
      // registrations apply to this iframe (mirrors how Chrome extensions
      // match content scripts to URLs).
      scope: args.scope,
    })}`;
    await view.webContents.loadURL(url);

    this.mounted.set(windowId, {
      windowId,
      scope: args.scope,
      view,
      disposeContextMenu,
    });
    if (!win.isVisible()) win.show();
    win.focus();
    log.verbose(`mounted "${args.scope}" in window "${windowId}"`);

    return { windowId };
  }

  async focusWindow(windowId: string): Promise<{ ok: true }> {
    const win = this.ctx.baseWindow.windows.get(windowId);
    if (win && !win.isDestroyed()) {
      if (!win.isVisible()) win.show();
      win.focus();
    }
    return { ok: true };
  }

  async pickFiles(): Promise<string[] | null> {
    const focusedWin = [...this.ctx.baseWindow.windows.values()].find((win) =>
      win.isFocused(),
    );
    const result = await dialog.showOpenDialog({
      ...(focusedWin ? { window: focusedWin } : {}),
      properties: ["openFile", "multiSelections"],
      title: "Choose Files",
    } as OpenDialogOptions);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths;
  }

  async pickDirectory(): Promise<string | null> {
    const focusedWin = [...this.ctx.baseWindow.windows.values()].find((win) =>
      win.isFocused(),
    );
    const result = await dialog.showOpenDialog({
      ...(focusedWin ? { window: focusedWin } : {}),
      properties: ["openDirectory", "createDirectory"],
      title: "Choose Directory",
    } as OpenDialogOptions);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0]!;
  }

  async openExternal(url: string): Promise<void> {
    await shell.openExternal(url);
  }

  async openPath(filePath: string): Promise<void> {
    await shell.openPath(filePath);
  }

  copyToClipboard(text: string): void {
    clipboard.writeText(text);
  }
}

runtime.register(WindowService, import.meta);
