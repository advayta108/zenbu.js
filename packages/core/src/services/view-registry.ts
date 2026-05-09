import * as Effect from "effect/Effect";
import { Service, runtime, getPlugins } from "../runtime";
import { ReloaderService, type ReloaderEntry } from "./reloader";
import { DbService } from "./db";
import { createLogger } from "../shared/log";

const log = createLogger("view-registry");

interface ViewEntry {
  type: string;
  url: string;
  port: number;
  ownsServer: boolean;
  meta?: {
    kind?: string;
    sidebar?: boolean;
    bottomPanel?: boolean;
    label?: string;
  };
}

export class ViewRegistryService extends Service {
  static key = "view-registry";
  static deps = { reloader: ReloaderService, db: DbService };
  declare ctx: { reloader: ReloaderService; db: DbService };

  private views = new Map<string, ViewEntry>();
  private manifestIcons = new Map<string, string>();

  async register(
    type: string,
    root: string,
    configFile?: string | false,
    meta?: {
      kind?: string;
      sidebar?: boolean;
      bottomPanel?: boolean;
      label?: string;
    },
  ): Promise<ViewEntry> {
    log.verbose(`register("${type}", root="${root}", config="${configFile}")`);
    const existing = this.views.get(type);
    if (existing) {
      log.verbose(`"${type}" already exists at ${existing.url}`);
      return existing;
    }

    log.verbose(`creating reloader for "${type}"...`);
    const reloaderEntry = await this.ctx.reloader.create(
      type,
      root,
      configFile,
    );
    log.verbose(`reloader created: ${reloaderEntry.url} (port ${reloaderEntry.port})`);
    const entry: ViewEntry = {
      type,
      url: reloaderEntry.url,
      port: reloaderEntry.port,
      ownsServer: true,
      meta,
    };
    this.views.set(type, entry);
    await this.syncToDb();
    log.verbose(`"${type}" registered at ${entry.url}`);
    return entry;
  }

  registerAlias(
    type: string,
    reloaderId: string,
    pathPrefix: string,
    meta?: {
      kind?: string;
      sidebar?: boolean;
      bottomPanel?: boolean;
      label?: string;
    },
  ): ViewEntry {
    const existing = this.views.get(type);
    if (existing) return existing;

    const reloaderEntry = this.ctx.reloader.get(reloaderId);
    if (!reloaderEntry)
      throw new Error(
        `Reloader "${reloaderId}" not found for alias "${type}"`,
      );

    const entry: ViewEntry = {
      type,
      url: `${reloaderEntry.url}${pathPrefix}`,
      port: reloaderEntry.port,
      ownsServer: false,
      meta,
    };
    this.views.set(type, entry);
    void this.syncToDb();
    return entry;
  }

  async unregister(type: string): Promise<void> {
    const entry = this.views.get(type);
    if (!entry) return;
    if (entry.ownsServer) {
      await this.ctx.reloader.remove(type);
    }
    this.views.delete(type);
    await this.syncToDb();
  }

  get(type: string): ViewEntry | undefined {
    return this.views.get(type);
  }

  evaluate() {
    this.loadManifestIcons();

    // Wipe stale rows from any prior session; ports are fresh on boot.
    void this.syncToDb();

    this.setup("view-registry-cleanup", () => {
      return async () => {
        for (const [type, entry] of this.views) {
          if (entry.ownsServer) {
            await this.ctx.reloader.remove(type);
          }
        }
        this.views.clear();
        await this.syncToDb();
      };
    });
  }

  private loadManifestIcons(): void {
    this.manifestIcons.clear();
    for (const plugin of getPlugins()) {
      if (!plugin.icons) continue;
      for (const [type, svg] of Object.entries(plugin.icons)) {
        this.manifestIcons.set(type, svg);
      }
    }
  }

  private async syncToDb(): Promise<void> {
    const client = this.ctx.db.effectClient;
    const snapshot = [...this.views.values()].map((e) => ({
      type: e.type,
      url: e.url,
      port: e.port,
      icon: this.manifestIcons.get(e.type),
      meta: e.meta,
    }));
    await Effect.runPromise(
      client.update((root) => {
        root.plugin.core.lastKnownViewRegistry = snapshot;
      }),
    ).catch((err) => {
      // log removed
    });
  }
}

runtime.register(ViewRegistryService, import.meta);
