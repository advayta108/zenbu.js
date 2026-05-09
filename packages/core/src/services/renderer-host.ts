import fsp from "node:fs/promises";
import path from "node:path";
import { Service, runtime } from "../runtime";
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

function parseJsonc(str: string): unknown {
  let result = "";
  let i = 0;
  while (i < str.length) {
    if (str[i] === "\"") {
      let j = i + 1;
      while (j < str.length) {
        if (str[j] === "\\") j += 2;
        else if (str[j] === "\"") {
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

async function resolveRendererRoot(): Promise<{
  rendererRoot: string;
  configFile: string | false;
}> {
  const configPath = process.env.ZENBU_CONFIG_PATH;
  if (!configPath) {
    throw new Error("ZENBU_CONFIG_PATH is required to resolve the app renderer");
  }

  const config = parseJsonc(await fsp.readFile(configPath, "utf8")) as {
    plugins?: string[];
  };
  const configDir = path.dirname(configPath);

  for (const manifestRel of config.plugins ?? []) {
    const resolvedManifest = path.isAbsolute(manifestRel)
      ? manifestRel
      : path.resolve(configDir, manifestRel);
    try {
      const manifest = JSON.parse(await fsp.readFile(resolvedManifest, "utf8"));
      if (!manifest.uiEntrypoint) continue;

      const projectDir = path.dirname(resolvedManifest);
      const rendererDir = path.resolve(projectDir, manifest.uiEntrypoint);
      const viteConfig = path.join(projectDir, "vite.config.ts");
      const configFile = (await pathExists(viteConfig)) ? viteConfig : false;
      if (!(await pathExists(rendererDir))) continue;

      return { rendererRoot: rendererDir, configFile };
    } catch {}
  }

  const rendererDir = path.resolve(configDir, "src", "renderer");
  const viteConfig = path.join(configDir, "vite.config.ts");
  if (await pathExists(rendererDir)) {
    return {
      rendererRoot: rendererDir,
      configFile: (await pathExists(viteConfig)) ? viteConfig : false,
    };
  }

  throw new Error(
    `No renderer entrypoint found. Add uiEntrypoint to the app plugin manifest or create ${rendererDir}.`,
  );
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
