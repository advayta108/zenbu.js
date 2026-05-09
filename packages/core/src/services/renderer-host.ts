import fsp from "node:fs/promises";
import path from "node:path";
import { Service, runtime, getAppEntrypoint } from "../runtime";
import { ReloaderService } from "./reloader";
import { ViewRegistryService } from "./view-registry";
import { createLogger } from "../shared/log";

const log = createLogger("renderer-host");

export const APP_RENDERER_RELOADER_ID = "app";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * The app's renderer root is the `uiEntrypoint` directory in
 * `zenbu.config.ts`. Vite's `root` resolves to it, and `index.html` inside
 * it is served through Vite. `splash.html` (sibling) is loaded raw — see
 * `setup-gate.spawnSplashWindow`.
 *
 * `vite.config.ts` is picked up from the project root if present (sibling
 * of `zenbu.config.ts`).
 */
async function resolveRendererRoot(): Promise<{
  rendererRoot: string;
  configFile: string | false;
}> {
  const rendererRoot = getAppEntrypoint();
  if (!rendererRoot) {
    throw new Error(
      "[renderer-host] no `uiEntrypoint` registered. " +
        "Set `uiEntrypoint` in zenbu.config.ts before starting the app.",
    );
  }
  if (!(await pathExists(rendererRoot))) {
    throw new Error(
      `[renderer-host] uiEntrypoint directory does not exist: ${rendererRoot}.`,
    );
  }

  const configPath = process.env.ZENBU_CONFIG_PATH;
  const projectDir = configPath ? path.dirname(configPath) : rendererRoot;
  const viteConfig = path.join(projectDir, "vite.config.ts");
  const configFile = (await pathExists(viteConfig)) ? viteConfig : false;

  return { rendererRoot, configFile };
}

export class RendererHostService extends Service {
  static key = "renderer-host";
  static deps = { reloader: ReloaderService, viewRegistry: ViewRegistryService };
  declare ctx: { reloader: ReloaderService; viewRegistry: ViewRegistryService };

  url = "";
  port = 0;

  async evaluate() {
    const { rendererRoot, configFile } = await resolveRendererRoot();
    const entry = await this.ctx.reloader.create(
      APP_RENDERER_RELOADER_ID,
      rendererRoot,
      configFile,
    );
    this.url = entry.url;
    this.port = entry.port;
    this.ctx.viewRegistry.registerAlias("app", APP_RENDERER_RELOADER_ID, "", {
      kind: "app",
      label: "App",
    });

    log.verbose(`ready at ${this.url}`);
  }
}

runtime.register(RendererHostService, import.meta);
