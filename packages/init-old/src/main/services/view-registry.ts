import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import * as Effect from "effect/Effect";
import { Service, runtime } from "../runtime";
import { ReloaderService, type ReloaderEntry } from "./reloader";
import { DbService } from "./db";
import { createLogger } from "../../../shared/log";

const log = createLogger("view-registry");

interface ViewEntry {
  scope: string;
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
    scope: string,
    root: string,
    configFile?: string | false,
    meta?: {
      kind?: string;
      sidebar?: boolean;
      bottomPanel?: boolean;
      label?: string;
    },
  ): Promise<ViewEntry> {
    log.verbose(`register("${scope}", root="${root}", config="${configFile}")`);
    const existing = this.views.get(scope);
    if (existing) {
      log.verbose(`"${scope}" already exists at ${existing.url}`);
      return existing;
    }

    log.verbose(`creating reloader for "${scope}"...`);
    const reloaderEntry = await this.ctx.reloader.create(
      scope,
      root,
      configFile,
    );
    log.verbose(`reloader created: ${reloaderEntry.url} (port ${reloaderEntry.port})`);
    const entry: ViewEntry = {
      scope,
      url: reloaderEntry.url,
      port: reloaderEntry.port,
      ownsServer: true,
      meta,
    };
    this.views.set(scope, entry);
    await this.syncToDb();
    log.verbose(`"${scope}" registered at ${entry.url}`);
    return entry;
  }

  registerAlias(
    scope: string,
    reloaderId: string,
    pathPrefix: string,
    meta?: {
      kind?: string;
      sidebar?: boolean;
      bottomPanel?: boolean;
      label?: string;
    },
  ): ViewEntry {
    const existing = this.views.get(scope);
    if (existing) return existing;

    const reloaderEntry = this.ctx.reloader.get(reloaderId);
    if (!reloaderEntry)
      throw new Error(
        `Reloader "${reloaderId}" not found for alias "${scope}"`,
      );

    const entry: ViewEntry = {
      scope,
      url: `${reloaderEntry.url}${pathPrefix}`,
      port: reloaderEntry.port,
      ownsServer: false,
      meta,
    };
    this.views.set(scope, entry);
    void this.syncToDb();
    return entry;
  }

  async unregister(scope: string): Promise<void> {
    const entry = this.views.get(scope);
    if (!entry) return;
    if (entry.ownsServer) {
      await this.ctx.reloader.remove(scope);
    }
    this.views.delete(scope);
    await this.syncToDb();
  }

  get(scope: string): ViewEntry | undefined {
    return this.views.get(scope);
  }

  evaluate() {
    this.loadManifestIcons().catch((err) => {
      // log removed
    });

    // Wipe stale rows from any prior session; ports are fresh on boot.
    void this.syncToDb();

    this.setup("view-registry-cleanup", () => {
      return async () => {
        for (const [scope, entry] of this.views) {
          if (entry.ownsServer) {
            await this.ctx.reloader.remove(scope);
          }
        }
        this.views.clear();
        await this.syncToDb();
      };
    });
  }

  private async loadManifestIcons(): Promise<void> {
    this.manifestIcons.clear();
    try {
      const configPath = await resolveConfigPath();
      let raw: string;
      try {
        raw = await fsp.readFile(configPath, "utf8");
      } catch {
        return;
      }
      const config = parseJsonc(raw) as { plugins?: string[] };
      for (const manifestPath of config.plugins ?? []) {
        try {
          const manifestRaw = await fsp.readFile(manifestPath, "utf8");
          const manifest = JSON.parse(manifestRaw);
          const icons: Record<string, string> = manifest.icons ?? {};
          for (const [scope, svg] of Object.entries(icons)) {
            this.manifestIcons.set(scope, svg);
          }
        } catch {}
      }
    } catch {}
  }

  private async syncToDb(): Promise<void> {
    const client = this.ctx.db.effectClient;
    const snapshot = [...this.views.values()].map((e) => ({
      scope: e.scope,
      url: e.url,
      port: e.port,
      icon: this.manifestIcons.get(e.scope),
      meta: e.meta,
    }));
    await Effect.runPromise(
      client.update((root) => {
        root.plugin.kernel.viewRegistry = snapshot;
      }),
    ).catch((err) => {
      // log removed
    });
  }
}

async function resolveConfigPath(): Promise<string> {
  if (process.env.ZENBU_CONFIG_PATH) return process.env.ZENBU_CONFIG_PATH;
  const jsonc = path.join(os.homedir(), ".zenbu", "config.jsonc");
  try {
    await fsp.access(jsonc);
    return jsonc;
  } catch {
    return path.join(os.homedir(), ".zenbu", "config.json");
  }
}

function parseJsonc(str: string): unknown {
  let result = "";
  let i = 0;
  while (i < str.length) {
    if (str[i] === '"') {
      let j = i + 1;
      while (j < str.length) {
        if (str[j] === "\\") {
          j += 2;
        } else if (str[j] === '"') {
          j++;
          break;
        } else {
          j++;
        }
      }
      result += str.slice(i, j);
      i = j;
    } else if (str[i] === "/" && str[i + 1] === "/") {
      i += 2;
      while (i < str.length && str[i] !== "\n") i++;
    } else if (str[i] === "/" && str[i + 1] === "*") {
      i += 2;
      while (i < str.length && !(str[i] === "*" && str[i + 1] === "/")) i++;
      i += 2;
    } else {
      result += str[i];
      i++;
    }
  }
  return JSON.parse(result.replace(/,\s*([\]}])/g, "$1"));
}

runtime.register(ViewRegistryService, import.meta);
