import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BrowserWindow,
  WebContentsView,
  Menu,
  app,
  clipboard,
  dialog,
  globalShortcut,
  screen,
  shell,
} from "electron";
import * as Effect from "effect/Effect";
import { nanoid } from "nanoid";
import { makeCollection } from "@zenbu/kyju/schema";
import electronContextMenu from "electron-context-menu";
import { createLogger } from "../../../shared/log";
import { Service, runtime } from "../runtime";

const log = createLogger("window");
const zenbuLog = createLogger("zenbu");
import { DbService } from "./db";
import { HttpService } from "./http";
import { CoreRendererService } from "./core-renderer";
import { ReloaderService } from "./reloader";
import { RpcService } from "./rpc";
import { registerAdvice, registerContentScript } from "./advice-config";
import {
  insertHotAgent,
  validSelectionFromTemplate,
  findExistingViewForAgent,
  makeViewAppState,
  makeWindowAppState,
  type ArchivedAgent,
} from "../../../shared/agent-ops";
import { activateView } from "#zenbu/agent-manager/shared/schema";
import { MAIN_WINDOW_ID } from "../../../shared/schema";
import { bootBus } from "../../../shared/boot-bus";
import { mark } from "../../../shared/tracer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_VIEW_PATH = "/views/orchestrator/index.html";
const DEFAULT_CWD = path.join(os.homedir(), ".zenbu");

export class WindowService extends Service {
  static key = "window";
  static deps = {
    baseWindow: "base-window",
    db: DbService,
    http: HttpService,
    coreRenderer: CoreRendererService,
    reloader: ReloaderService,
    rpc: RpcService,
  };
  declare ctx: {
    baseWindow: any;
    db: DbService;
    http: HttpService;
    coreRenderer: CoreRendererService;
    reloader: ReloaderService;
    rpc: RpcService;
  };

  private views = new Map<
    string,
    { win: Electron.BaseWindow; view: WebContentsView }
  >();
  private _mountNewWindows: (() => void) | null = null;
  private previewWindows = new Map<string, BrowserWindow>();
  private pendingTearOffs = new Map<
    string,
    {
      sourceWindowId: string;
      viewId: string;
      agentId: string;
    }
  >();

  splitRegistration: { name: string; scope: string } | null = null;

  registerSplitPanel(opts: { name: string; scope: string }) {
    this.splitRegistration = opts;
    return () => {
      if (this.splitRegistration === opts) {
        this.splitRegistration = null;
      }
    };
  }

  async createWindowWithAgent() {
    const { baseWindow, db } = this.ctx;
    const client = db.effectClient;
    const kernel = client.readRoot().plugin.kernel;
    const selectedConfig =
      kernel.agentConfigs.find((c) => c.id === kernel.selectedConfigId) ??
      kernel.agentConfigs[0];
    if (!selectedConfig) return { windowId: "", agentId: "" };

    const windowId = nanoid();
    const agentId = nanoid();
    const viewId = nanoid();

    const seeded = validSelectionFromTemplate(selectedConfig);

    let evicted: ArchivedAgent[] = [];
    await Effect.runPromise(
      client.update((root) => {
        const k = root.plugin.kernel;
        evicted = insertHotAgent(k, {
          id: agentId,
          name: selectedConfig.name,
          startCommand: selectedConfig.startCommand,
          configId: selectedConfig.id,
          status: "idle",
          metadata: { cwd: DEFAULT_CWD },
          eventLog: makeCollection({
            collectionId: nanoid(),
            debugName: "eventLog",
          }),
          ...seeded,
          title: { kind: "not-available" },
          reloadMode: "keep-alive",
          sessionId: null,
          firstPromptSentAt: null,
          createdAt: Date.now(),
          queuedMessages: [],
        });
        k.windows = [...k.windows, { id: windowId, persisted: false }];
        k.windowState = {
          ...k.windowState,
          [windowId]: makeWindowAppState(windowId, { activeViewId: viewId }),
        };
        k.views = [
          ...k.views,
          {
            id: viewId,
            windowId,
            parentId: null,
            scope: "chat",
            props: { agentId },
            createdAt: Date.now(),
          },
        ];
        k.viewState = {
          ...k.viewState,
          [viewId]: makeViewAppState(viewId, { order: 0 }),
        };
      }),
    );
    if (evicted.length > 0) {
      await Effect.runPromise(
        client.plugin.kernel.archivedAgents.concat(evicted),
      ).catch(() => {});
    }

    baseWindow.createWindow({ windowId });
    this._mountNewWindows?.();
    return { windowId, agentId };
  }

  async createWindowWithLastOrNewAgent() {
    const { baseWindow, db } = this.ctx;
    const client = db.effectClient;
    const kernel = client.readRoot().plugin.kernel;
    const lastAgent = kernel.agents
      .filter((a) => a.lastUserMessageAt != null)
      .sort(
        (a, b) => (b.lastUserMessageAt ?? 0) - (a.lastUserMessageAt ?? 0),
      )[0];

    if (!lastAgent) return this.createWindowWithAgent();

    const existing = findExistingViewForAgent(kernel.views, lastAgent.id);
    if (existing) {
      await Effect.runPromise(
        client.update((root) => {
          activateView(root, existing);
        }),
      );
      const win = baseWindow.windows.get(existing.windowId);
      if (win && !win.isDestroyed()) win.focus();
      return { windowId: existing.windowId, agentId: lastAgent.id };
    }

    const windowId = nanoid();
    const viewId = nanoid();
    await Effect.runPromise(
      client.update((root) => {
        const k = root.plugin.kernel;
        k.windows = [...k.windows, { id: windowId, persisted: false }];
        k.windowState = {
          ...k.windowState,
          [windowId]: makeWindowAppState(windowId, { activeViewId: viewId }),
        };
        k.views = [
          ...k.views,
          {
            id: viewId,
            windowId,
            parentId: null,
            scope: "chat",
            props: { agentId: lastAgent.id },
            createdAt: Date.now(),
          },
        ];
        k.viewState = {
          ...k.viewState,
          [viewId]: makeViewAppState(viewId, { order: 0 }),
        };
      }),
    );

    baseWindow.createWindow({ windowId });
    this._mountNewWindows?.();
    return { windowId, agentId: lastAgent.id };
  }

  private getFocusedWebContents(): Electron.WebContents | undefined {
    for (const { win, view } of this.views.values()) {
      if (win.isFocused()) return view.webContents;
    }
    return undefined;
  }

  async showContextMenu(
    items: { id: string; label: string; enabled?: boolean }[],
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const template = items.map((item) => ({
        label: item.label,
        enabled: item.enabled ?? true,
        click: () => resolve(item.id),
      }));
      const menu = Menu.buildFromTemplate(template);
      menu.popup({ callback: () => resolve(null) });
    });
  }

  async pickFiles(): Promise<string[] | null> {
    const focusedWin = [...this.ctx.baseWindow.windows.values()].find(
      (w: Electron.BaseWindow) => w.isFocused(),
    );
    const result = await dialog.showOpenDialog({
      ...(focusedWin ? { window: focusedWin } : {}),
      properties: ["openFile", "multiSelections"],
      title: "Add Context Files",
    } as Electron.OpenDialogOptions);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths;
  }

  async pickDirectory(): Promise<string | null> {
    const focusedWin = [...this.ctx.baseWindow.windows.values()].find(
      (w: Electron.BaseWindow) => w.isFocused(),
    );
    const result = await dialog.showOpenDialog({
      ...(focusedWin ? { window: focusedWin } : {}),
      properties: ["openDirectory", "createDirectory"],
      title: "Choose Directory",
    } as Electron.OpenDialogOptions);

    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0]!;
  }

  async moveTabToNewWindow(opts: {
    sourceWindowId: string;
    viewId: string;
  }): Promise<{ windowId: string } | null> {
    const { baseWindow, db } = this.ctx;
    const client = db.effectClient;
    const kernel = client.readRoot().plugin.kernel;

    const sourceWindow = kernel.windows.find(
      (w) => w.id === opts.sourceWindowId,
    );
    if (!sourceWindow) return null;

    const view = kernel.views.find(
      (v) => v.id === opts.viewId && v.windowId === opts.sourceWindowId,
    );
    if (!view) return null;

    const windowId = nanoid();

    const sourceWin = baseWindow.windows.get(opts.sourceWindowId);
    const bounds = sourceWin?.getBounds();

    await Effect.runPromise(
      client.update((root) => {
        const k = root.plugin.kernel;
        k.windows = [...k.windows, { id: windowId, persisted: false }];
        k.windowState = {
          ...k.windowState,
          [windowId]: makeWindowAppState(windowId, {
            activeViewId: opts.viewId,
          }),
        };
        // Move the view to the new window: just rewrite its windowId.
        k.views = k.views.map((v) =>
          v.id === opts.viewId ? { ...v, windowId } : v,
        );
        // Source window's activeViewId may have pointed at the moved view;
        // clear it to fall back to whatever else is in that window.
        const srcWs = k.windowState[opts.sourceWindowId];
        if (srcWs && srcWs.activeViewId === opts.viewId) {
          k.windowState = {
            ...k.windowState,
            [opts.sourceWindowId]: { ...srcWs, activeViewId: null },
          };
        }
      }),
    );

    baseWindow.createWindow({
      windowId,
      ...(bounds
        ? {
            x: bounds.x + 30,
            y: bounds.y + 30,
            width: bounds.width,
            height: bounds.height,
          }
        : {}),
    });
    this._mountNewWindows?.();
    return { windowId };
  }

  async beginTabTearOff(opts: {
    sourceWindowId: string;
    viewId: string;
    screenX: number;
    screenY: number;
  }): Promise<{ previewWindowId: string } | null> {
    const { baseWindow, db } = this.ctx;
    const client = db.effectClient;
    const kernel = client.readRoot().plugin.kernel;

    const view = kernel.views.find(
      (v) => v.id === opts.viewId && v.windowId === opts.sourceWindowId,
    );
    if (!view) return null;

    const agentId = view.props.agentId ?? "";

    // Hide the view from the source window during the drag preview by
    // moving it to a sentinel windowId we keep in pendingTearOffs. On
    // cancel, we restore. On finalize, we move it to the new real window.
    await Effect.runPromise(
      client.update((root) => {
        const k = root.plugin.kernel;
        const srcWs = k.windowState[opts.sourceWindowId];
        if (srcWs && srcWs.activeViewId === opts.viewId) {
          k.windowState = {
            ...k.windowState,
            [opts.sourceWindowId]: { ...srcWs, activeViewId: null },
          };
        }
        // Park the view: clear its windowId so the source's tab bar
        // (filtered by windowId) drops it. We restore on cancel.
        k.views = k.views.map((v) =>
          v.id === opts.viewId ? { ...v, windowId: "__tearoff__" } : v,
        );
      }),
    );

    const viewEntry = this.views.get(opts.sourceWindowId);
    if (!viewEntry) return null;

    const sourceWin = baseWindow.windows.get(opts.sourceWindowId);
    const sourceBounds = sourceWin?.getBounds();
    const srcWidth = sourceBounds?.width ?? 1200;
    const srcHeight = sourceBounds?.height ?? 800;

    const scale = 0.4;
    const previewWidth = Math.round(srcWidth * scale);
    const previewHeight = Math.round(srcHeight * scale);

    const previewId = nanoid();
    const x = Math.round(opts.screenX - previewWidth / 2);
    const y = Math.round(opts.screenY - 20);

    const preview = new BrowserWindow({
      width: previewWidth,
      height: previewHeight,
      x,
      y,
      frame: false,
      hasShadow: true,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      resizable: false,
      roundedCorners: true,
      backgroundColor: "#F4F4F4",
      webPreferences: { sandbox: true, contextIsolation: true },
    });

    const blankHtml = `<!DOCTYPE html>
<html><head><style>
  *{margin:0;padding:0}
  body{overflow:hidden;background:#F4F4F4}
  img{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}
</style></head><body></body></html>`;

    await preview.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(blankHtml)}`,
    );
    preview.setIgnoreMouseEvents(true);
    preview.showInactive();

    // Capture chat view screenshot in the background and swap it in
    const captureScreenshot = async () => {
      try {
        const { reloader, http } = this.ctx;
        const coreEntry = reloader.get("core");
        const chatRegistry = (kernel.viewRegistry ?? []).find(
          (v) => v.scope === "chat",
        );
        let screenshotDataUrl = "";
        if (coreEntry && chatRegistry) {
          const chatPath = new URL(chatRegistry.url).pathname;
          const chatUrl = `http://localhost:${http.port}${chatPath}/index.html?agentId=${agentId}&viewId=${opts.viewId}&wsPort=${http.port}&wsToken=${encodeURIComponent(http.authToken)}`;

          const offscreen = new WebContentsView({
            webPreferences: {
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              offscreen: true,
            },
          });
          offscreen.setBounds({
            x: 0,
            y: 0,
            width: srcWidth,
            height: srcHeight,
          });

          const sourceWinRef = baseWindow.windows.get(opts.sourceWindowId);
          if (sourceWinRef) {
            sourceWinRef.contentView.addChildView(offscreen, 0);
          }

          await offscreen.webContents.loadURL(chatUrl);
          await new Promise((r) => setTimeout(r, 500));

          const image = await offscreen.webContents.capturePage();
          screenshotDataUrl = image.toDataURL();

          if (sourceWinRef) {
            sourceWinRef.contentView.removeChildView(offscreen);
          }
          offscreen.webContents.close();
        } else {
          const image = await viewEntry.view.webContents.capturePage();
          screenshotDataUrl = image.toDataURL();
        }

        if (screenshotDataUrl && !preview.isDestroyed()) {
          preview.webContents.executeJavaScript(
            `document.body.innerHTML = '<img src="${screenshotDataUrl}">'`,
          );
        }
      } catch {}
    };
    captureScreenshot();

    this.previewWindows.set(previewId, preview);
    this.pendingTearOffs.set(previewId, {
      sourceWindowId: opts.sourceWindowId,
      viewId: opts.viewId,
      agentId,
    });

    preview.on("closed", () => {
      this.previewWindows.delete(previewId);
      this.pendingTearOffs.delete(previewId);
    });

    return { previewWindowId: previewId };
  }

  updateDragWindowPosition(opts: {
    windowId: string;
    screenX: number;
    screenY: number;
  }) {
    const preview = this.previewWindows.get(opts.windowId);
    if (preview && !preview.isDestroyed()) {
      const { width, height } = preview.getBounds();
      preview.setBounds({
        x: Math.round(opts.screenX - width / 2),
        y: Math.round(opts.screenY - 20),
        width,
        height,
      });
      return;
    }
    const win = this.ctx.baseWindow.windows.get(opts.windowId);
    if (!win) return;
    const bounds = win.getBounds();
    win.setPosition(
      Math.round(opts.screenX - bounds.width / 2),
      Math.round(opts.screenY - 20),
    );
  }

  async finalizeTearOff(opts: {
    previewWindowId: string;
    screenX: number;
    screenY: number;
  }): Promise<{ windowId: string } | null> {
    const pending = this.pendingTearOffs.get(opts.previewWindowId);
    if (!pending) return null;

    const preview = this.previewWindows.get(opts.previewWindowId);
    if (preview && !preview.isDestroyed()) preview.close();

    const { baseWindow, db } = this.ctx;
    const client = db.effectClient;

    const windowId = nanoid();

    const sourceWin = baseWindow.windows.get(pending.sourceWindowId);
    const sourceBounds = sourceWin?.getBounds();
    const width = sourceBounds?.width ?? 1200;
    const height = sourceBounds?.height ?? 800;

    await Effect.runPromise(
      client.update((root) => {
        const k = root.plugin.kernel;
        k.windows = [...k.windows, { id: windowId, persisted: false }];
        k.windowState = {
          ...k.windowState,
          [windowId]: makeWindowAppState(windowId, {
            activeViewId: pending.viewId,
          }),
        };
        // Move the parked view to the new window.
        k.views = k.views.map((v) =>
          v.id === pending.viewId ? { ...v, windowId } : v,
        );
      }),
    );

    const x = Math.round(opts.screenX - width / 2);
    const y = Math.round(opts.screenY - 20);

    baseWindow.createWindow({ windowId, x, y, width, height, show: false });
    const newWin = baseWindow.windows.get(windowId);
    if (newWin) {
      newWin.showInactive();
      newWin.focus();
    }

    this._mountNewWindows?.();
    this.pendingTearOffs.delete(opts.previewWindowId);
    this.previewWindows.delete(opts.previewWindowId);
    return { windowId };
  }

  async cancelTearOff(opts: { previewWindowId: string }) {
    const pending = this.pendingTearOffs.get(opts.previewWindowId);

    const preview = this.previewWindows.get(opts.previewWindowId);
    if (preview && !preview.isDestroyed()) preview.close();
    this.pendingTearOffs.delete(opts.previewWindowId);
    this.previewWindows.delete(opts.previewWindowId);

    if (pending) {
      const client = this.ctx.db.effectClient;
      await Effect.runPromise(
        client.update((root) => {
          const k = root.plugin.kernel;
          // Restore the parked view back to its source window.
          k.views = k.views.map((v) =>
            v.id === pending.viewId
              ? { ...v, windowId: pending.sourceWindowId }
              : v,
          );
          // Re-activate it in the source window.
          const srcWs = k.windowState[pending.sourceWindowId];
          if (srcWs) {
            k.windowState = {
              ...k.windowState,
              [pending.sourceWindowId]: {
                ...srcWs,
                activeViewId: pending.viewId,
              },
            };
          }
        }),
      );
    }
  }

  async openInFinder(dirPath: string) {
    await shell.openPath(dirPath);
  }

  async openExternal(url: string) {
    await shell.openExternal(url);
  }

  async copyToClipboard(text: string) {
    clipboard.writeText(text);
  }

  async confirm(opts: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    windowId?: string;
  }): Promise<boolean> {
    const win = opts.windowId
      ? this.ctx.baseWindow.windows.get(opts.windowId)
      : [...this.ctx.baseWindow.windows.values()].find(
          (w: Electron.BaseWindow) => w.isFocused(),
        );
    const msgOpts: Electron.MessageBoxOptions = {
      type: "question",
      message: opts.title,
      detail: opts.message,
      buttons: [opts.cancelLabel ?? "Cancel", opts.confirmLabel ?? "OK"],
      defaultId: 1,
      cancelId: 0,
    };
    const result = win
      ? await dialog.showMessageBox(win, msgOpts)
      : await dialog.showMessageBox(msgOpts);
    return result.response === 1;
  }

  evaluate() {
    const { baseWindow, db, http, reloader, rpc } = this.ctx;

    this.setup("preview-cleanup", () => {
      return () => {
        for (const preview of this.previewWindows.values()) {
          if (!preview.isDestroyed()) preview.close();
        }
        this.previewWindows.clear();
        this.pendingTearOffs.clear();
      };
    });

    this.setup("content-views", () => {
      const viewEntries = this.views;
      const scrollTouchHandlers = new Map<
        Electron.WebContents,
        { begin: () => void; end: () => void }
      >();
      const contextMenuDisposers = new Map<string, () => void>();
      const splitPanels = new Map<
        string,
        {
          panel: WebContentsView;
          separator: WebContentsView;
          overlay: WebContentsView | null;
          ratio: number;
          layout: () => void;
        }
      >();

      const SEPARATOR_WIDTH = 4;
      const MIN_RATIO = 0.2;
      const MAX_RATIO = 0.8;

      const openSplit = (windowId: string) => {
        const entry = viewEntries.get(windowId);
        if (!entry || splitPanels.has(windowId) || !this.splitRegistration) return;
        const { win, view } = entry;

        const panel = new WebContentsView({
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        panel.setBackgroundColor("#1e1e1e");

        const separator = new WebContentsView({
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        separator.setBackgroundColor("#2d2d2d");

        const state = { panel, separator, overlay: null as WebContentsView | null, ratio: 0.5, layout: () => {} };

        const doLayout = () => {
          if (win.isDestroyed()) return;
          const { width, height } = win.getContentBounds();
          const mainWidth = Math.round(width * state.ratio);
          const panelWidth = width - mainWidth - SEPARATOR_WIDTH;
          view.setBounds({ x: 0, y: 0, width: mainWidth, height });
          separator.setBounds({ x: mainWidth, y: 0, width: SEPARATOR_WIDTH, height });
          panel.setBounds({ x: mainWidth + SEPARATOR_WIDTH, y: 0, width: panelWidth, height });
        };
        state.layout = doLayout;

        win.contentView.addChildView(separator);
        win.contentView.addChildView(panel);
        doLayout();
        win.on("resize", doLayout);

        const sepHtml = `<!DOCTYPE html><html><head><style>
          *{margin:0;padding:0}body{height:100vh;cursor:col-resize;background:#2d2d2d;-webkit-app-region:no-drag}
        </style><script>
          document.addEventListener('mousedown',()=>console.log('__split_drag_start__'));
        </script></head><body></body></html>`;
        separator.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(sepHtml)}`);

        separator.webContents.on("console-message", (e) => {
          if (e.message !== "__split_drag_start__") return;

          const startPoint = screen.getCursorScreenPoint();
          const startRatio = state.ratio;

          const overlay = new WebContentsView({
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
          });
          overlay.setBackgroundColor("#00000000");
          const overlayHtml = `<!DOCTYPE html><html><head><style>
            *{margin:0;padding:0}html,body{height:100%;background:transparent;cursor:col-resize}
          </style><script>
            document.addEventListener('mouseup',()=>console.log('__split_drag_end__'));
          </script></head><body></body></html>`;
          const { width: cw, height: ch } = win.getContentBounds();
          overlay.setBounds({ x: 0, y: 0, width: cw, height: ch });
          win.contentView.addChildView(overlay);
          overlay.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml)}`);
          state.overlay = overlay;

          const poll = setInterval(() => {
            if (win.isDestroyed()) { clearInterval(poll); return; }
            const cur = screen.getCursorScreenPoint();
            const dx = cur.x - startPoint.x;
            const contentWidth = win.getContentBounds().width;
            const newRatio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, startRatio + dx / contentWidth));
            state.ratio = newRatio;
            doLayout();
          }, 16);

          const cleanup = () => {
            clearInterval(poll);
            if (!win.isDestroyed() && state.overlay) {
              win.contentView.removeChildView(state.overlay);
              if (!state.overlay.webContents.isDestroyed()) state.overlay.webContents.close();
              state.overlay = null;
            }
          };

          overlay.webContents.on("console-message", (e2) => {
            if (e2.message === "__split_drag_end__") cleanup();
          });
          overlay.webContents.once("destroyed", cleanup);
        });

        const registry = (
          db.effectClient.readRoot().plugin.kernel.viewRegistry ?? []
        ).find((v) => v.scope === this.splitRegistration!.scope);
        if (!registry) return;

        const viewUrl = new URL(registry.url);
        viewUrl.searchParams.set("wsPort", String(http.port));
        viewUrl.searchParams.set("wsToken", http.authToken);
        viewUrl.searchParams.set("windowId", windowId);
        panel.webContents.loadURL(viewUrl.toString());

        contextMenuDisposers.set(
          `${windowId}:panel`,
          electronContextMenu({ window: panel, showInspectElement: true }),
        );

        splitPanels.set(windowId, state);
      };

      const closeSplit = (windowId: string) => {
        const entry = viewEntries.get(windowId);
        const split = splitPanels.get(windowId);
        if (!entry || !split) return;
        const { win, view } = entry;

        if (split.overlay && !split.overlay.webContents.isDestroyed()) {
          win.contentView.removeChildView(split.overlay);
          split.overlay.webContents.close();
        }
        win.contentView.removeChildView(split.separator);
        win.contentView.removeChildView(split.panel);
        if (!split.separator.webContents.isDestroyed()) split.separator.webContents.close();
        if (!split.panel.webContents.isDestroyed()) split.panel.webContents.close();
        win.off("resize", split.layout);

        contextMenuDisposers.get(`${windowId}:panel`)?.();
        contextMenuDisposers.delete(`${windowId}:panel`);

        splitPanels.delete(windowId);

        const { width, height } = win.getContentBounds();
        view.setBounds({ x: 0, y: 0, width, height });
      };

      let currentViewPath =
        db.effectClient.readRoot().plugin.kernel.orchestratorViewPath ??
        DEFAULT_VIEW_PATH;
      log.verbose("currentViewPath:", currentViewPath);
      log.verbose("boot windows:", (globalThis as any).__zenbu_boot_windows__?.length ?? 0);
      log.verbose("baseWindow windows:", baseWindow.windows.size);

      const attachView = (
        windowId: string,
        win: Electron.BaseWindow,
        viewPath: string,
      ) => {
        const partition = (globalThis as any).__zenbu_renderer_partition__ ?? "persist:renderer";
        const view = new WebContentsView({
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            partition,
          },
        });

        view.setBackgroundColor("#000000");
        contextMenuDisposers.set(
          windowId,
          electronContextMenu({
            window: view,
            showInspectElement: true,
            append: () => {
              const reg = this.splitRegistration;
              if (!reg) return [];
              return [
                { type: "separator" as const },
                splitPanels.has(windowId)
                  ? { label: `Close ${reg.name}`, click: () => closeSplit(windowId) }
                  : { label: `Open ${reg.name}`, click: () => openSplit(windowId) },
              ];
            },
          }),
        );

        // If the kernel pre-populated this window with a loading view, keep it
        // on top and add the orchestrator beneath (index 0 = bottom of stack).
        // When the orchestrator finishes loading we remove the loading view so
        // there's no flash of blank content during Vite's boot.
        const loadingView = (win as any).__zenbu_loading_view__ as
          | WebContentsView
          | undefined;
        if (loadingView) {
          win.contentView.addChildView(view, 0);
        } else {
          win.contentView.addChildView(view);
          view.webContents.once("did-finish-load", () => {
            if (!win.isDestroyed() && !win.isVisible()) win.show();
            bootBus.emit("ready", { windowId });
          });
        }

        const layout = () => {
          const split = splitPanels.get(windowId);
          if (split) {
            split.layout();
            return;
          }
          const { width, height } = win.getContentBounds();
          view.setBounds({ x: 0, y: 0, width, height });
        };
        layout();
        win.on("resize", layout);

        if (loadingView) {
          view.webContents.once("did-start-loading", () => {
            mark("orchestrator-did-start-loading", { windowId });
          });
          view.webContents.once("did-start-navigation", () => {
            mark("orchestrator-did-start-navigation", { windowId });
          });
          view.webContents.once("did-navigate", () => {
            mark("orchestrator-did-navigate", { windowId });
          });
          view.webContents.once("dom-ready", () => {
            mark("orchestrator-dom-ready", { windowId });
          });
          const swap = () => {
            mark("content-rendered", { windowId });
            try {
              if (!win.isDestroyed()) {
                win.contentView.removeChildView(loadingView);
              }
              if (!loadingView.webContents.isDestroyed()) {
                loadingView.webContents.close();
              }
            } catch (err) {
              log.warn("loading view swap failed:", err);
            }
            (win as any).__zenbu_loading_view__ = null;
            bootBus.emit("ready", { windowId });
          };
          view.webContents.once("did-finish-load", swap);
          // Failsafe: if the orchestrator errors out, still swap so the user
          // isn't stuck staring at the loading spinner forever.
          view.webContents.once("did-fail-load", (_e, code, desc) => {
            log.error(
              `orchestrator failed to load (${code}): ${desc}`,
            );
            swap();
          });
        }

        const emitScrollTouch = (phase: "begin" | "end") => {
          rpc.emit.orchestrator.scrollTouch({
            webContentsId: view.webContents.id,
            phase,
          });
        };
        const onScrollTouchBegin = () => emitScrollTouch("begin");
        const onScrollTouchEnd = () => emitScrollTouch("end");
        const scrollTouchWebContents = view.webContents as any;
        scrollTouchHandlers.set(view.webContents, {
          begin: onScrollTouchBegin,
          end: onScrollTouchEnd,
        });
        scrollTouchWebContents.on("scroll-touch-begin", onScrollTouchBegin);
        scrollTouchWebContents.on("scroll-touch-end", onScrollTouchEnd);

        const cwd = process.cwd();
        const qs = `wsPort=${http.port}&wsToken=${encodeURIComponent(
          http.authToken,
        )}&cwd=${encodeURIComponent(
          cwd,
        )}&defaultCwd=${encodeURIComponent(DEFAULT_CWD)}&webContentsId=${
          view.webContents.id
        }&windowId=${encodeURIComponent(windowId)}`;
        let url: string;
        if (viewPath.startsWith("http://") || viewPath.startsWith("https://")) {
          const sep = viewPath.includes("?") ? "&" : "?";
          url = `${viewPath}${sep}${qs}`;
        } else {
          const coreEntry = reloader.get("core");
          if (!coreEntry) return;
          const base = coreEntry.url.replace(/\/$/, "");
          url = `${base}${viewPath}?${qs}`;
        }
        mark("orchestrator-load-start", { windowId });
        if (windowId === MAIN_WINDOW_ID) {
          zenbuLog.verbose(`open in browser: ${url}`);
        }
        view.webContents.loadURL(url);

        viewEntries.set(windowId, { win, view });

        let closeDialogOpen = false;
        const onClose = (event: Electron.Event) => {
          event.preventDefault();
          if (closeDialogOpen) return;
          closeDialogOpen = true;
          dialog
            .showMessageBox(win, {
              type: "question",
              message: "Close window?",
              detail: "This will close any active sessions in this window.",
              buttons: ["Cancel", "Close"],
              defaultId: 1,
              cancelId: 0,
            })
            .then((result) => {
              closeDialogOpen = false;
              if (result.response === 1) {
                (win as any).__zenbu_on_close = null;
                win.close();
              }
            });
        };
        const onClosed = () => {
          Effect.runPromise(
            db.effectClient.update((root) => {
              const k = root.plugin.kernel;
              const win = k.windows.find((w) => w.id === windowId);
              // Persisted windows survive close (e.g. the main window).
              if (win?.persisted) return;
              k.windows = k.windows.filter((w) => w.id !== windowId);
              const nextWindowState = { ...k.windowState };
              delete nextWindowState[windowId];
              k.windowState = nextWindowState;
              // Drop views belonging to this window, plus their state.
              const droppedViewIds = new Set<string>(
                k.views.filter((v) => v.windowId === windowId).map((v) => v.id),
              );
              if (droppedViewIds.size > 0) {
                k.views = k.views.filter((v) => v.windowId !== windowId);
                const nextViewState = { ...k.viewState };
                for (const id of droppedViewIds) delete nextViewState[id];
                k.viewState = nextViewState;
              }
            }),
          ).catch(() => {});
        };

        /**
         * nonsense will be deleted
         */
        if (!(win as any).__zenbu_close_attached) {
          (win as any).__zenbu_close_attached = true;
          win.on("close", (event: Electron.Event) => {
            const cb = (win as any).__zenbu_on_close;
            if (cb) cb(event);
          });
          win.on("closed", () => {
            const cb = (win as any).__zenbu_on_closed;
            if (cb) cb();
          });
        }
        (win as any).__zenbu_on_close = onClose;
        (win as any).__zenbu_on_closed = onClosed;
      };

      const teardownAllViews = () => {
        for (const windowId of [...splitPanels.keys()]) closeSplit(windowId);
        for (const { win, view } of viewEntries.values()) {
          try {
            if (!win.isDestroyed()) {
              (win as any).__zenbu_on_close = null;
              (win as any).__zenbu_on_closed = null;
            }
            const wc = view.webContents;
            if (wc) {
              const handlers = scrollTouchHandlers.get(wc);
              if (handlers) {
                (wc as any).off("scroll-touch-begin", handlers.begin);
                (wc as any).off("scroll-touch-end", handlers.end);
              }
              if (!wc.isDestroyed()) wc.close();
            }
            if (!win.isDestroyed()) {
              win.contentView.removeChildView(view);
            }
          } catch {}
        }
        scrollTouchHandlers.clear();
        for (const dispose of contextMenuDisposers.values()) dispose();
        contextMenuDisposers.clear();
        this.views = new Map();
      };

      const mountNew = () => {
        for (const [windowId, win] of baseWindow.windows) {
          if (viewEntries.has(windowId)) continue;
          attachView(windowId, win, currentViewPath);
        }
      };

      this._mountNewWindows = mountNew;
      mountNew();

      const unsub =
        db.effectClient.plugin.kernel.orchestratorViewPath.subscribe(
          (newPath) => {
            const resolved = newPath || DEFAULT_VIEW_PATH;
            if (resolved === currentViewPath) return;
            currentViewPath = resolved;
            teardownAllViews();
            mountNew();
          },
        );

      return () => {
        unsub();
        this._mountNewWindows = null;
        teardownAllViews();
      };
    });

    this.setup("no-minimap-advice", () => {
      return registerAdvice("chat", {
        moduleId: "views/chat/components/Minimap.tsx",
        name: "Minimap",
        type: "replace",
        modulePath: path.resolve(
          __dirname,
          "..",
          "..",
          "renderer",
          "views",
          "orchestrator",
          "advice",
          "no-minimap.tsx",
        ),
        exportName: "MinimapNoOp",
      });
    });

    this.setup("devtools-shortcut", () => {
      const accelerator =
        process.platform === "darwin"
          ? "CommandOrControl+Option+I"
          : "CommandOrControl+Shift+I";
      globalShortcut.register(accelerator, () => {
        this.getFocusedWebContents()?.toggleDevTools();
      });
      return () => {
        globalShortcut.unregister(accelerator);
      };
    });

    this.setup("dock-menu", () => {
      if (process.platform !== "darwin") return;
      app.dock?.setMenu(
        Menu.buildFromTemplate([
          {
            label: "New Window",
            click: () => {
              this.createWindowWithAgent();
            },
          },
        ]),
      );
    });

    this.setup("activate", () => {
      const handler = () => {
        if (baseWindow.windows.size === 0) {
          this.createWindowWithLastOrNewAgent();
        }
      };
      app.on("activate", handler);
      return () => {
        app.off("activate", handler);
      };
    });

    this.setup("focused-window-tracking", () => {
      const tracked = new Map<
        Electron.BaseWindow,
        { windowId: string; onFocus: () => void; onBlur: () => void }
      >();

      const writeFocusedWindowId = (id: string | null) => {
        Effect.runPromise(
          db.effectClient.update((root) => {
            if (root.plugin.kernel.focusedWindowId !== id) {
              root.plugin.kernel.focusedWindowId = id;
            }
          }),
        ).catch(() => {});
      };

      const attachIfNew = (windowId: string, win: Electron.BaseWindow) => {
        if (tracked.has(win)) return;
        const onFocus = () => writeFocusedWindowId(windowId);
        const onBlur = () => {
          // Only clear if no other window immediately takes focus. Electron
          // delivers focus on the new window synchronously after blur, so a
          // microtask is enough to debounce.
          queueMicrotask(() => {
            const anyFocused = [...baseWindow.windows.values()].some(
              (w: Electron.BaseWindow) => !w.isDestroyed() && w.isFocused(),
            );
            if (!anyFocused) writeFocusedWindowId(null);
          });
        };
        win.on("focus", onFocus);
        win.on("blur", onBlur);
        tracked.set(win, { windowId, onFocus, onBlur });
        if (win.isFocused()) writeFocusedWindowId(windowId);
      };

      const sweep = () => {
        for (const [windowId, win] of baseWindow.windows) {
          attachIfNew(windowId, win);
        }
        for (const [win, entry] of tracked) {
          if (!baseWindow.windows.get(entry.windowId)) {
            tracked.delete(win);
          }
        }
      };
      sweep();

      const interval = setInterval(sweep, 500);

      return () => {
        clearInterval(interval);
        for (const [win, { onFocus, onBlur }] of tracked) {
          try {
            win.off("focus", onFocus);
            win.off("blur", onBlur);
          } catch {}
        }
        tracked.clear();
      };
    });

    log.verbose(`service ready (${baseWindow.windows.size} windows)`);
  }
}

runtime.register(WindowService, import.meta);
