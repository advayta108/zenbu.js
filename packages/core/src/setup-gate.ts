import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register as registerLoader, createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { register as registerTsx } from "tsx/esm/api";
import { bootstrapEnv } from "./env-bootstrap";
import { defaultServices } from "./services";

type PackageJson = {
  name?: string;
  repository?: string | { url?: string };
  zenbu?: {
    host?: string;
    branch?: string;
    updateUrl?: string;
  };
};

type ElectronApp = {
  getAppPath(): string;
  whenReady(): Promise<void>;
};

const verbose = process.env.ZENBU_VERBOSE === "1";

function projectArg(): string | null {
  const arg = process.argv.find((item) => item.startsWith("--project="));
  return arg ? path.resolve(arg.slice("--project=".length)) : null;
}

function appDirName(name: string): string {
  return name.replace(/^@/, "").replace(/[\\/]/g, "__");
}

function readPackageJson(packageDir: string): PackageJson {
  const pkgPath = path.join(packageDir, "package.json");
  return JSON.parse(fs.readFileSync(pkgPath, "utf8")) as PackageJson;
}

function repositoryUrl(pkg: PackageJson): string | null {
  if (typeof pkg.repository === "string") return pkg.repository;
  return pkg.repository?.url ?? null;
}

function zenbuCacheRoot(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "Zenbu");
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "Zenbu",
    );
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "Zenbu");
}

function requiredManagedTool(name: string): string {
  const toolPath = path.join(zenbuCacheRoot(), "bin", name);
  if (!fs.existsSync(toolPath)) {
    throw new Error(
      `Zenbu managed tool is missing: ${toolPath}. ` +
        "Run `zen doctor` or reinstall @zenbujs/core to provision the bundled toolchain.",
    );
  }
  return toolPath;
}

function findProjectRoot(projectDir: string): string {
  let dir = path.resolve(projectDir);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(projectDir);
}

function resolveConfigPath(projectRoot: string): string {
  const configPath = path.join(projectRoot, "config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`config.json not found at ${configPath}`);
  }
  return configPath;
}

function findTsconfig(projectRoot: string): string | false {
  const candidate = path.join(projectRoot, "tsconfig.json");
  return fs.existsSync(candidate) ? candidate : false;
}

async function cloneIfMissing(projectDir: string, repoUrl: string | null): Promise<void> {
  if (fs.existsSync(projectDir)) return;
  if (!repoUrl) {
    throw new Error(
      `Project directory ${projectDir} does not exist and package.json#repository.url is missing`,
    );
  }
  const git = requiredManagedTool("git");
  const { spawn } = await import("node:child_process");
  await fs.promises.mkdir(path.dirname(projectDir), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(git, ["clone", repoUrl, projectDir], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git clone failed with exit code ${code}`));
    });
  });
}

async function runZenInstall(projectDir: string): Promise<void> {
  const pnpm = process.env.ZENBU_SKIP_INSTALL === "1" ? null : "pnpm";
  if (!pnpm) return;
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(pnpm, ["install"], {
      cwd: projectDir,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pnpm install failed with exit code ${code}`));
    });
  });
}

function loadElectronApp(): ElectronApp {
  const requireFromCore = createRequire(import.meta.url);
  const electron = requireFromCore("electron") as { app?: ElectronApp };
  if (!electron.app) {
    throw new Error("Electron app API is unavailable; setup-gate must run inside Electron");
  }
  return electron.app;
}

async function registerLoaders(tsconfig: string | false): Promise<void> {
  registerLoader(import.meta.resolve("@zenbujs/core/loaders/zenbu"));

  const requireFromCore = createRequire(import.meta.url);
  const dynohotRegisterPath = requireFromCore.resolve("dynohot/register");
  const dynohot = await import(pathToFileURL(dynohotRegisterPath).href);
  if (typeof dynohot.register === "function") {
    dynohot.register({ ignore: /[/\\]node_modules[/\\]/ });
  }

  await import("@zenbu/advice/node");
  registerTsx({ tsconfig });
}

export async function setupGate(): Promise<void> {
  const app = loadElectronApp();
  await app.whenReady();
  bootstrapEnv();

  const bundledAppPath = app.getAppPath();
  const bundledPkg = readPackageJson(bundledAppPath);
  const appName = bundledPkg.name ?? path.basename(bundledAppPath);
  const resolvedProjectDir =
    projectArg() ??
    path.join(
      process.env.ZENBU_APPS_DIR ?? path.join(os.homedir(), ".zenbu", "apps"),
      appDirName(appName),
    );

  await cloneIfMissing(resolvedProjectDir, repositoryUrl(bundledPkg));
  await runZenInstall(resolvedProjectDir);

  const projectRoot = findProjectRoot(resolvedProjectDir);
  const configPath = resolveConfigPath(projectRoot);
  const tsconfig = findTsconfig(projectRoot);

  process.chdir(projectRoot);
  process.env.ZENBU_CONFIG_PATH = configPath;

  if (!process.argv.some((arg) => arg.startsWith("--project="))) {
    process.argv.push(`--project=${resolvedProjectDir}`);
  }

  if (verbose) {
    console.log("[setup-gate] project:", resolvedProjectDir);
    console.log("[setup-gate] config:", configPath);
  }

  await registerLoaders(tsconfig);
  await defaultServices();

  const url = `zenbu:plugins?config=${encodeURIComponent(configPath)}`;
  await import(url, { with: { hot: "import" } });

  const runtime = (globalThis as { __zenbu_service_runtime__?: { whenIdle(): Promise<void> } })
    .__zenbu_service_runtime__;
  await runtime?.whenIdle();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await setupGate();
}
