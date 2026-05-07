import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register as registerLoader, createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { register as registerTsx } from "tsx/esm/api";
import { bootstrapEnv } from "./env-bootstrap";

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

function requiredManagedTool(projectDir: string, name: string): string {
  const root = process.env.ZENBU_TOOLCHAIN_ROOT
    ? path.resolve(process.env.ZENBU_TOOLCHAIN_ROOT)
    : path.join(projectDir, ".zenbu", "toolchain");
  const toolPath = path.join(root, "bin", name);
  if (!fs.existsSync(toolPath)) {
    throw new Error(
      `Zenbu managed tool is missing: ${toolPath}. ` +
        "Run `npx @zenbujs/init --yes` in this project to provision the local runtime.",
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

async function cloneIfMissing(
  projectDir: string,
  repoUrl: string | null,
): Promise<void> {
  if (fs.existsSync(projectDir)) return;
  if (!repoUrl) {
    throw new Error(
      `Project directory ${projectDir} does not exist and package.json#repository.url is missing`,
    );
  }
  const git = requiredManagedTool(projectDir, "git");
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
  const pnpm =
    process.env.ZENBU_SKIP_INSTALL === "1"
      ? null
      : requiredManagedTool(projectDir, "pnpm");
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
    throw new Error(
      "Electron app API is unavailable; setup-gate must run inside Electron",
    );
  }
  return electron.app;
}

async function registerLoaders(tsconfig: string | false, projectRoot: string): Promise<void> {
  registerLoader(import.meta.resolve("@zenbujs/core/loaders/zenbu"));

  registerTsx({ tsconfig });

  process.env.ZENBU_ADVICE_ROOT = projectRoot;
  await import("@zenbu/advice/node");

  const requireFromCore = createRequire(import.meta.url);
  const dynohotRegisterPath = requireFromCore.resolve("dynohot/register");
  const dynohot = await import(pathToFileURL(dynohotRegisterPath).href);
  if (typeof dynohot.register === "function") {
    // Ignore both `node_modules/` and any `dist/` directory. The latter
    // covers `@zenbujs/core` when it's `link:`'d for development — its
    // built `dist/*.mjs` chunks are framework code that the app shouldn't
    // be hot-reloading. Without this, an entry can be loaded twice (once
    // hot-wrapped via the user's plugin barrel, once non-hot via setup-gate's
    // own dynamic imports), producing two distinct hot module URLs and
    // double-evaluating services like `ServerService`.
    dynohot.register({ ignore: /[/\\](?:node_modules|dist)[/\\]/ });
  }
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

  await registerLoaders(tsconfig, projectRoot);
  const { defaultServices } = await import("./services/default");
  await defaultServices();

  const url = `zenbu:plugins?config=${encodeURIComponent(configPath)}`;
  const mod = await import(url, { with: { hot: "import" } });
  if (typeof mod.default === "function") {
    const controller = mod.default();
    if (controller && typeof controller.main === "function") {
      await controller.main();
    }
  }

  const runtime = (
    globalThis as { __zenbu_service_runtime__?: { whenIdle(): Promise<void> } }
  ).__zenbu_service_runtime__;
  await runtime?.whenIdle();
}

void setupGate().catch((error) => {
  console.error(error);
  process.exit(1);
});
