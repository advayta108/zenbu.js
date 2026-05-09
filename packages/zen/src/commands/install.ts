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

/**
 * `zen install` has two modes:
 *
 *   Dev (default):  thin pass-through to the bundled pnpm. No flag injection,
 *                   no deps-sig caching, no policy enforcement. Behaves the
 *                   way `pnpm install` does in your terminal.
 *
 *                     zen install                  -> pnpm install
 *                     zen install tailwindcss      -> pnpm install tailwindcss
 *                     zen install -D vite          -> pnpm install -D vite
 *
 *   CI (`--ci`):    programmatic mode for non-TTY callers (launchers, build
 *                   pipelines, tests). Forces `CI=true` so pnpm doesn't
 *                   prompt, redirects `HOME` so node-gyp's header cache stays
 *                   inside the project, auto-appends `--no-frozen-lockfile`
 *                   on bare installs (so a legitimate package.json edit
 *                   doesn't get rejected by CI=true's implicit frozen mode),
 *                   short-circuits when the deps-sig matches, and enforces
 *                   the no-native-without-prebuild policy at the end.
 *
 *                     zen install --ci             -> ensure deps installed
 *                                                     (used by launcher / CI)
 *
 *   `--zen-force` bypasses the deps-sig short-circuit (CI mode only).
 *   `--project=<dir>` overrides the cwd for either mode.
 *
 * Electron-targeting env vars (`npm_config_runtime=electron`, `_target`,
 * `_disturl`, `_arch`) are set in both modes so native deps build against
 * the right runtime regardless of how the install was invoked.
 */
function parseArgs(argv: string[]): {
  projectDir: string;
  ci: boolean;
  force: boolean;
  pnpmArgs: string[];
} {
  let projectDir = process.cwd();
  let ci = false;
  let force = false;
  const pnpmArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--project" && argv[i + 1]) {
      projectDir = path.resolve(argv[++i]!);
    } else if (arg.startsWith("--project=")) {
      projectDir = path.resolve(arg.slice("--project=".length));
    } else if (arg === "--ci") {
      ci = true;
    } else if (arg === "--zen-force") {
      force = true;
    } else {
      pnpmArgs.push(arg);
    }
  }
  return { projectDir, ci, force, pnpmArgs };
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

async function runPnpmInstall(
  projectDir: string,
  pnpmArgs: string[],
  opts: { ci: boolean },
): Promise<void> {
  const pnpm = managedTool(projectDir, "pnpm");
  const target = electronTargetVersion(projectDir);

  const args = ["install", ...pnpmArgs];
  if (opts.ci) {
    // CI=true forces `--frozen-lockfile` for the bare-install codepath.
    // That's wrong for an editable-source dev tool: when the user (or a
    // launcher / postinstall) legitimately edits a dep in `package.json`,
    // frozen mode rejects the install. Override that knob explicitly,
    // but only for bare installs — pnpm's `add`/`remove`/etc. codepaths
    // reject the flag entirely.
    const isBareInstall = !pnpmArgs.some((a) => !a.startsWith("-"));
    const explicitFrozen = args.some(
      (a) => a === "--frozen-lockfile" || a === "--no-frozen-lockfile",
    );
    if (isBareInstall && !explicitFrozen) args.push("--no-frozen-lockfile");
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_runtime: "electron",
    npm_config_target: target,
    npm_config_disturl: "https://electronjs.org/headers",
    npm_config_arch: process.arch,
  };
  if (opts.ci) {
    env.CI = "true";
    // Keep node-gyp's header cache scoped to the project so non-TTY
    // launchers don't pollute the user's global ~/.node-gyp.
    env.HOME = path.join(projectDir, ".zenbu", ".node-gyp");
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(pnpm, args, { cwd: projectDir, stdio: "inherit", env });
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
  const { projectDir, ci, force, pnpmArgs } = parseArgs(argv);
  const pkgPath = path.join(projectDir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`package.json not found at ${pkgPath}`);
  }

  // Dev mode: pure pnpm pass-through. No caching, no policy. The bundled
  // pnpm still gets the electron-target env vars so any native dep the
  // user adds builds against the right runtime.
  if (!ci) {
    await runPnpmInstall(projectDir, pnpmArgs, { ci: false });
    return;
  }

  // CI mode: deps-sig short-circuit on bare installs, then pnpm, then
  // the no-native-without-prebuild policy enforcement.
  const isBareInstall = pnpmArgs.length === 0;
  const marker = path.join(projectDir, ".zenbu", "deps-sig");
  const nodeModules = path.join(projectDir, "node_modules");
  if (isBareInstall && !force) {
    try {
      const nextSig = await installSignature(projectDir);
      if (
        fs.existsSync(nodeModules) &&
        fs.readFileSync(marker, "utf8") === nextSig
      ) {
        console.log("zen install: dependencies are up to date");
        return;
      }
    } catch {}
  }

  await runPnpmInstall(projectDir, pnpmArgs, { ci: true });
  await enforceNativeDependencyPolicy(projectDir);
  if (isBareInstall) {
    const nextSig = await installSignature(projectDir);
    await fsp.mkdir(path.dirname(marker), { recursive: true });
    await fsp.writeFile(marker, nextSig);
  }
}
