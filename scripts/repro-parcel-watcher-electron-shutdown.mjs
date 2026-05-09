#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const defaults = {
  mode: "clean-process-exit",
  iterations: 20,
  watchers: 4,
  settleMs: 25,
  postUnsubscribeMs: 0,
  timeoutMs: 8000,
};

const options = parseArgs(process.argv.slice(2));
const electron = resolveElectron(options.electron);
const appDir = mkdtempSync(path.join(os.tmpdir(), "zenbu-parcel-watcher-electron-"));
const watchRoot = path.join(appDir, "watch");

writeFileSync(
  path.join(appDir, "package.json"),
  JSON.stringify(
    { name: "zenbu-parcel-watcher-electron-repro", version: "0.0.0", type: "module", main: "main.mjs" },
    null,
    2,
  ) + "\n",
);
writeFileSync(path.join(appDir, "main.mjs"), makeMainSource());

let failures = 0;
try {
  for (let i = 1; i <= options.iterations; i++) {
    const result = await runOne(i);
    if (result.ok) {
      console.log(`[${i}/${options.iterations}] ok (${result.elapsedMs}ms)`);
    } else {
      failures++;
      console.error(`[${i}/${options.iterations}] failed (${result.elapsedMs}ms)`);
      if (result.output.trim()) console.error(result.output.trim());
      if (options.stopOnFailure) break;
    }
  }
} finally {
  if (!options.keepTemp) rmSync(appDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} failure(s) in ${options.iterations} iteration(s)`);
  process.exit(1);
}

console.log(`\n${options.iterations} clean iteration(s)`);

function parseArgs(argv) {
  const parsed = { ...defaults, electron: undefined, keepTemp: false, stopOnFailure: true };
  for (const arg of argv) {
    const [key, rawValue] = arg.replace(/^--/, "").split("=", 2);
    const value = rawValue ?? "true";
    switch (key) {
      case "mode":
        parsed.mode = value;
        break;
      case "iterations":
      case "watchers":
      case "settle-ms":
      case "post-unsubscribe-ms":
      case "timeout-ms":
        parsed[toCamel(key)] = Number(value);
        break;
      case "electron":
        parsed.electron = value;
        break;
      case "keep-temp":
        parsed.keepTemp = value !== "false";
        break;
      case "no-stop-on-failure":
        parsed.stopOnFailure = false;
        break;
      case "help":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown option: --${key}`);
    }
  }
  return parsed;
}

function toCamel(key) {
  return key.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function printHelp() {
  console.log(`Usage: node scripts/repro-parcel-watcher-electron-shutdown.mjs [options]

Options:
  --mode=<name>                 clean-process-exit | clean-app-exit | clean-app-quit | zenbu-like | leak-process-exit
  --iterations=<n>              loop count (default ${defaults.iterations})
  --watchers=<n>                watcher subscription count per run (default ${defaults.watchers})
  --settle-ms=<n>               delay before shutdown starts (default ${defaults.settleMs})
  --post-unsubscribe-ms=<n>     delay after unsubscribe before exit (default ${defaults.postUnsubscribeMs})
  --timeout-ms=<n>              per-run timeout (default ${defaults.timeoutMs})
  --electron=<path>             Electron binary path
  --keep-temp                   keep generated Electron app
  --no-stop-on-failure          continue after a failed iteration`);
}

function resolveElectron(explicit) {
  const candidates = [
    explicit,
    process.env.ELECTRON_BIN,
    process.env.ZENBU_REPRO_ELECTRON_BIN,
    path.join(repoRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
    path.join(repoRoot, "node_modules", ".bin", "electron"),
    "/Users/robby/zenbu-make/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    "/Users/robby/zenbu-make/node_modules/.bin/electron",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (candidate && path.isAbsolute(candidate) && existsSync(candidate)) return candidate;
    } catch {}
  }
  throw new Error("Could not resolve Electron. Pass --electron=/path/to/Electron.");
}

function runOne(iteration) {
  const started = Date.now();
  const args = [
    appDir,
    `--mode=${options.mode}`,
    `--watch-root=${watchRoot}`,
    `--iteration=${iteration}`,
    `--watchers=${options.watchers}`,
    `--settle-ms=${options.settleMs}`,
    `--post-unsubscribe-ms=${options.postUnsubscribeMs}`,
  ];

  return new Promise((resolve) => {
    const child = spawn(electron, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ZENBU_REPRO_HMR_PACKAGE_JSON: path.join(repoRoot, "packages", "hmr", "package.json"),
      },
    });

    let output = "";
    const collect = (chunk) => {
      output += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        ok: false,
        elapsedMs: Date.now() - started,
        output: `${output}\nTimed out after ${options.timeoutMs}ms`,
      });
    }, options.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        ok: false,
        elapsedMs: Date.now() - started,
        output: `${output}\n${err.stack ?? err.message}`,
      });
    });

    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      const fatal = /FATAL ERROR|napi_throw|Trace\/BPT trap|SIGABRT/i.test(output);
      resolve({
        ok: code === 0 && signal == null && !fatal,
        elapsedMs: Date.now() - started,
        output,
      });
    });
  });
}

function makeMainSource() {
  return String.raw`
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const requireFromHmr = createRequire(process.env.ZENBU_REPRO_HMR_PACKAGE_JSON);
const { app } = require("electron");
const { subscribe } = requireFromHmr("@parcel/watcher");

const args = Object.fromEntries(
  process.argv
    .filter((arg) => arg.startsWith("--") && arg.includes("="))
    .map((arg) => {
      const [key, value] = arg.slice(2).split("=", 2);
      return [key, value];
    }),
);

const mode = args.mode ?? "clean-process-exit";
const watchRoot = args["watch-root"];
const iteration = Number(args.iteration ?? 0);
const watchers = Number(args.watchers ?? 4);
const settleMs = Number(args["settle-ms"] ?? 25);
const postUnsubscribeMs = Number(args["post-unsubscribe-ms"] ?? 0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.error("[harness child] start", JSON.stringify({ mode, iteration, watchers, settleMs }));

app.on("will-quit", () => {
  console.error("[harness child] will-quit");
});

void main().catch((err) => {
  console.error("[harness child] fatal", err);
  process.exit(1);
});

async function main() {
  await app.whenReady();
  console.error("[harness child] ready");
  mkdirSync(watchRoot, { recursive: true });

  const subscriptionPromises = [];
  for (let i = 0; i < watchers; i++) {
    const dir = path.join(watchRoot, String(iteration), String(i));
    mkdirSync(dir, { recursive: true });
    subscriptionPromises.push(subscribe(dir, (err) => {
      if (err) console.error("[harness child] watcher error", err);
    }));
  }
  console.error("[harness child] subscribe requested");

  async function cleanup() {
    console.error("[harness child] cleanup start");
    const subscriptions = await Promise.all(subscriptionPromises);
    console.error("[harness child] subscribed");
    await Promise.all(subscriptions.map((sub) => sub.unsubscribe()));
    console.error("[harness child] unsubscribed");
    if (postUnsubscribeMs > 0) await sleep(postUnsubscribeMs);
  }

  async function exitAfterCleanup(exitFn) {
    await sleep(settleMs);
    await cleanup();
    exitFn();
  }

  if (mode === "zenbu-like") {
    let cleaned = false;
    app.on("before-quit", (event) => {
      if (cleaned) return;
      event.preventDefault();
      void cleanup().then(() => {
        cleaned = true;
        process.exit(0);
      });
    });
    await sleep(settleMs);
    app.quit();
  } else if (mode === "clean-app-quit") {
    await exitAfterCleanup(() => app.quit());
  } else if (mode === "clean-app-exit") {
    await exitAfterCleanup(() => app.exit(0));
  } else if (mode === "clean-process-exit") {
    await exitAfterCleanup(() => process.exit(0));
  } else if (mode === "leak-process-exit") {
    await sleep(settleMs);
    process.exit(0);
  } else {
    console.error("[harness child] unknown mode", mode);
    process.exit(2);
  }
}
`;
}
