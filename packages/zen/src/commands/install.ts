import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function toolchainRoot(projectDir: string): string {
  return path.join(projectDir, ".zenbu", "toolchain");
}

function managedTool(projectDir: string, name: string): string {
  const toolPath = path.join(toolchainRoot(projectDir), "bin", name);
  if (!fs.existsSync(toolPath)) {
    throw new Error(
      `Zenbu managed tool is missing: ${toolPath}. Run \`npx @zenbujs/init --yes\` in this project.`,
    );
  }
  return toolPath;
}

function parseArgs(argv: string[]): { projectDir: string; force: boolean } {
  let projectDir = process.cwd();
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--project" && argv[i + 1]) {
      projectDir = path.resolve(argv[++i]!);
    } else if (arg.startsWith("--project=")) {
      projectDir = path.resolve(arg.slice("--project=".length));
    } else if (arg === "--force") {
      force = true;
    } else if (!arg.startsWith("-")) {
      projectDir = path.resolve(arg);
    } else {
      throw new Error(`unknown zen install flag: ${arg}`);
    }
  }
  return { projectDir, force };
}

async function fileHash(hash: crypto.Hash, filePath: string): Promise<void> {
  hash.update(filePath);
  hash.update("\0");
  try {
    hash.update(await fsp.readFile(filePath));
  } catch {}
  hash.update("\0");
}

async function installSignature(projectDir: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await fileHash(hash, path.join(projectDir, "package.json"));
  await fileHash(hash, path.join(projectDir, "pnpm-lock.yaml"));
  await fileHash(hash, path.join(toolchainRoot(projectDir), "bin", ".pnpm.version"));
  await fileHash(hash, path.join(toolchainRoot(projectDir), "bin", ".bun.version"));
  hash.update(process.versions.electron ?? "no-electron");
  hash.update("\0");
  hash.update(process.platform);
  hash.update("\0");
  hash.update(process.arch);
  return hash.digest("hex");
}

function electronTargetVersion(projectDir: string): string {
  if (process.versions.electron) return process.versions.electron;
  const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const version =
    pkg.devDependencies?.electron ??
    pkg.dependencies?.electron ??
    "";
  return version.replace(/^[^\d]*/, "") || "42.0.0";
}

async function runPnpmInstall(projectDir: string): Promise<void> {
  const pnpm = managedTool(projectDir, "pnpm");
  const target = electronTargetVersion(projectDir);
  // We pass `CI=true` to stop pnpm from prompting (approve-builds, modules-purge,
  // etc.) so that `zen install` can be driven from non-TTY callers without
  // hanging. `CI=true` also implicitly turns on `--frozen-lockfile`, which is
  // wrong for an editable-source dev tool: when the user legitimately edits a
  // dep in `package.json`, frozen mode rejects the install. So we explicitly
  // override that one knob with `--no-frozen-lockfile`. (For strict CI installs,
  // expose a separate `--frozen` flag; not needed for the dev path.)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(pnpm, ["install", "--no-frozen-lockfile"], {
      cwd: projectDir,
      stdio: "inherit",
      env: {
        ...process.env,
        CI: "true",
        HOME: path.join(projectDir, ".zenbu", ".node-gyp"),
        npm_config_runtime: "electron",
        npm_config_target: target,
        npm_config_disturl: "https://electronjs.org/headers",
        npm_config_arch: process.arch,
      },
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pnpm install exited with code ${code}`));
    });
  });
}

async function walk(dir: string, visit: (filePath: string) => Promise<void>): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git") continue;
      await walk(full, visit);
    } else if (entry.isFile()) {
      await visit(full);
    }
  }
}

function packageRootForNativeMarker(nodeModules: string, filePath: string): string | null {
  const rel = path.relative(nodeModules, filePath);
  if (rel.startsWith("..")) return null;
  const parts = rel.split(path.sep);
  const nodeModulesIdx = parts.lastIndexOf("node_modules");
  const start = nodeModulesIdx >= 0 ? nodeModulesIdx + 1 : 0;
  if (!parts[start]) return null;
  if (parts[start]!.startsWith("@")) {
    if (!parts[start + 1]) return null;
    return path.join(nodeModules, ...parts.slice(0, start + 2));
  }
  return path.join(nodeModules, ...parts.slice(0, start + 1));
}

async function packageHasPrebuildEvidence(packageDir: string): Promise<boolean> {
  if (fs.existsSync(path.join(packageDir, "prebuilds"))) return true;
  if (fs.existsSync(path.join(packageDir, "prebuild"))) return true;
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(packageDir, "package.json"), "utf8")) as {
      binary?: unknown;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    if (pkg.binary && typeof pkg.binary === "object") return true;
    const deps = { ...pkg.dependencies, ...pkg.optionalDependencies };
    if (
      deps["node-gyp-build"] ||
      deps["prebuild-install"] ||
      deps["@mapbox/node-pre-gyp"] ||
      deps["node-pre-gyp"]
    ) {
      return true;
    }
    const installScript = pkg.scripts?.install ?? "";
    return /prebuild|node-gyp-build|node-pre-gyp/.test(installScript);
  } catch {
    return false;
  }
}

async function enforceNativeDependencyPolicy(projectDir: string): Promise<void> {
  const nodeModules = path.join(projectDir, "node_modules");
  const nativePackageDirs = new Set<string>();
  await walk(nodeModules, async (filePath) => {
    const base = path.basename(filePath);
    if (base !== "binding.gyp") return;
    const pkgRoot = packageRootForNativeMarker(nodeModules, filePath);
    if (pkgRoot) nativePackageDirs.add(pkgRoot);
  });

  const offenders: string[] = [];
  for (const pkgRoot of nativePackageDirs) {
    if (await packageHasPrebuildEvidence(pkgRoot)) continue;
    let name = path.basename(pkgRoot);
    try {
      const pkg = JSON.parse(await fsp.readFile(path.join(pkgRoot, "package.json"), "utf8")) as { name?: string };
      name = pkg.name ?? name;
    } catch {}
    offenders.push(name);
  }

  if (offenders.length === 0) return;
  throw new Error(
    [
      "zen install: native dependencies without prebuild evidence are not supported in editable-source apps.",
      "",
      "Offending packages:",
      ...offenders.sort().map((name) => `  - ${name}`),
      "",
      "Use a pure JS/WASM package, or a package that ships Electron-compatible prebuilds.",
    ].join("\n"),
  );
}

export async function runInstall(argv: string[]): Promise<void> {
  const { projectDir, force } = parseArgs(argv);
  const pkgPath = path.join(projectDir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`package.json not found at ${pkgPath}`);
  }

  const marker = path.join(projectDir, ".zenbu", "deps-sig");
  const nodeModules = path.join(projectDir, "node_modules");
  const nextSig = await installSignature(projectDir);
  if (!force) {
    try {
      if (fs.existsSync(nodeModules) && fs.readFileSync(marker, "utf8") === nextSig) {
        console.log("zen install: dependencies are up to date");
        return;
      }
    } catch {}
  }

  await runPnpmInstall(projectDir);
  await enforceNativeDependencyPolicy(projectDir);
  await fsp.mkdir(path.dirname(marker), { recursive: true });
  await fsp.writeFile(marker, nextSig);
}
