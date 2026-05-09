#!/usr/bin/env node
import { spawn } from "node:child_process";

const defaults = {
  project: "/Users/robby/zenbu-make",
  iterations: 10,
  autoQuitMs: 250,
  autoQuitMinMs: null,
  autoQuitMaxMs: null,
  quitPhase: "idle",
  timeoutMs: 20000,
};

const options = parseArgs(process.argv.slice(2));
let failures = 0;

for (let i = 1; i <= options.iterations; i++) {
  const autoQuitMs = pickAutoQuitMs();
  const result = await runOne(i, autoQuitMs);
  if (result.ok) {
    console.log(`[${i}/${options.iterations}] ok (${result.elapsedMs}ms, quit=${autoQuitMs}ms)`);
  } else {
    failures++;
    console.error(`[${i}/${options.iterations}] failed (${result.elapsedMs}ms, quit=${autoQuitMs}ms)`);
    if (result.output.trim()) console.error(lastLines(result.output, 80));
    if (options.stopOnFailure) break;
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s) in ${options.iterations} iteration(s)`);
  process.exit(1);
}

console.log(`\n${options.iterations} clean iteration(s)`);

function parseArgs(argv) {
  const parsed = { ...defaults, stopOnFailure: true };
  for (const arg of argv) {
    const [key, rawValue] = arg.replace(/^--/, "").split("=", 2);
    const value = rawValue ?? "true";
    switch (key) {
      case "project":
        parsed.project = value;
        break;
      case "quit-phase":
        parsed.quitPhase = value;
        break;
      case "iterations":
      case "auto-quit-ms":
      case "auto-quit-min-ms":
      case "auto-quit-max-ms":
      case "timeout-ms":
        parsed[toCamel(key)] = Number(value);
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
  console.log(`Usage: node scripts/repro-zenbu-dev-quit.mjs [options]

Options:
  --project=<path>              Zenbu app project (default ${defaults.project})
  --iterations=<n>              loop count (default ${defaults.iterations})
  --auto-quit-ms=<n>            delay after setup-gate idle before app.quit() (default ${defaults.autoQuitMs})
  --auto-quit-min-ms=<n>        random minimum delay after idle
  --auto-quit-max-ms=<n>        random maximum delay after idle
  --quit-phase=<idle|ready>     schedule quit after setup-gate idle or Electron ready
  --timeout-ms=<n>              per-run timeout (default ${defaults.timeoutMs})
  --no-stop-on-failure          continue after a failed iteration`);
}

function pickAutoQuitMs() {
  if (options.autoQuitMinMs == null && options.autoQuitMaxMs == null) {
    return options.autoQuitMs;
  }
  const min = options.autoQuitMinMs ?? 0;
  const max = options.autoQuitMaxMs ?? min;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
    throw new Error(`Invalid auto-quit range: ${min}..${max}`);
  }
  return min + Math.floor(Math.random() * (max - min + 1));
}

function runOne(iteration, autoQuitMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["dev"], {
      cwd: options.project,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(options.quitPhase === "ready"
          ? { ZENBU_AUTO_QUIT_AFTER_READY_MS: String(autoQuitMs) }
          : { ZENBU_AUTO_QUIT_AFTER_IDLE_MS: String(autoQuitMs) }),
      },
    });

    let output = "";
    const collect = (chunk) => {
      output += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
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

function lastLines(text, count) {
  return text.split(/\r?\n/).slice(-count).join("\n");
}
