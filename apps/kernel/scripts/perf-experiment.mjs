#!/usr/bin/env node
/**
 * Diagnostic experiment: does UV_THREADPOOL_SIZE affect the slow-tail
 * kyju writes we see during the orchestrator-load-start → orchestrator-
 * dom-ready window?
 *
 * H1 (to confirm/reject): libuv threadpool (default 4) is saturated by
 * Vite/renderer fs work during window load, starving our kyju fs writes.
 *
 * Method: run N boots with 3 different UV_THREADPOOL_SIZE values, each
 * config interleaved so FS-cache drift hits them equally. Drop run #1
 * per config as warmup, summarise the rest.
 *
 * Does NOT apply any fix — pure measurement.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const KERNEL_DIR = path.resolve(new URL(".", import.meta.url).pathname, "..");
const TRACE_PATH = path.join(os.homedir(), ".zenbu", ".internal", "boot-trace.json");
const OUT_DIR = path.join(KERNEL_DIR, "scripts", "perf-experiment-out");

const RUNS_PER_CONFIG = 5;         // drop first as warmup
const PER_RUN_TIMEOUT_MS = 60_000; // kill if a boot hangs

const CONFIGS = [
  { name: "default(4)", env: {} },
  { name: "UV=16", env: { UV_THREADPOOL_SIZE: "16" } },
  { name: "UV=32", env: { UV_THREADPOOL_SIZE: "32" } },
];

const log = (...a) => console.error(...a);

const runOnce = async (envExtra, label) => {
  try { fs.unlinkSync(TRACE_PATH); } catch {}
  const start = Date.now();
  const child = spawn("pnpm", ["dev"], {
    cwd: KERNEL_DIR,
    env: {
      ...process.env,
      ...envExtra,
      ZENBU_PERF_EXIT_ON_READY: "1",
    },
    stdio: "ignore",
    detached: false,
  });

  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, 5_000);
  }, PER_RUN_TIMEOUT_MS);

  await new Promise((resolve) => {
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
  clearTimeout(timer);

  if (killed) throw new Error(`[${label}] timed out after ${PER_RUN_TIMEOUT_MS}ms`);
  if (!fs.existsSync(TRACE_PATH)) throw new Error(`[${label}] no boot-trace.json written`);
  const trace = JSON.parse(fs.readFileSync(TRACE_PATH, "utf-8"));
  const wallMs = Date.now() - start;
  return { trace, wallMs };
};

const extract = (trace) => {
  const boot = trace.bootStartedAt;
  const rootSpans = trace.rootSpans || [];
  const marks = trace.marks || [];
  const markAt = (name) => {
    const m = marks.find((x) => x.name === name);
    return m ? m.at - boot : null;
  };

  const loadStart = markAt("orchestrator-load-start");
  const domReady = markAt("orchestrator-dom-ready");
  const rendered = markAt("content-rendered");

  const inWindow = (startedAt) => {
    if (loadStart == null || domReady == null) return false;
    const o = startedAt - boot;
    return o >= loadStart && o <= domReady;
  };

  const flushes = rootSpans.filter((s) => s.name === "kyju:db.root.flush");
  const handles = rootSpans.filter((s) => s.name === "kyju:db.handleWrite");
  const concats = handles.filter((s) => s.meta && s.meta.op === "collection.concat");
  const rootSets = handles.filter((s) => s.meta && s.meta.op === "root.set");

  const stats = (arr) => ({
    n: arr.length,
    max: arr.length ? Math.max(...arr.map((s) => s.durationMs)) : 0,
    sum: arr.reduce((a, s) => a + s.durationMs, 0),
  });

  return {
    totalMs: trace.totalMs,
    viteReady: markAt("vite-ready"),
    loadStart,
    domReady,
    rendered,
    loadWindowMs: loadStart != null && domReady != null ? domReady - loadStart : null,
    flush: stats(flushes),
    flushInWindow: stats(flushes.filter((s) => inWindow(s.startedAt))),
    concat: stats(concats),
    concatInWindow: stats(concats.filter((s) => inWindow(s.startedAt))),
    rootSet: stats(rootSets),
  };
};

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const p95 = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : 0;
};

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Interleave configs: round 1 of all, round 2 of all, ...
  // Reduces drift bias from FS-cache / background processes.
  const all = {};
  for (const cfg of CONFIGS) all[cfg.name] = [];

  for (let round = 0; round < RUNS_PER_CONFIG; round++) {
    for (const cfg of CONFIGS) {
      const label = `${cfg.name} r${round + 1}`;
      process.stderr.write(`[${label}] running… `);
      try {
        const { trace, wallMs } = await runOnce(cfg.env, label);
        const m = extract(trace);
        all[cfg.name].push(m);
        fs.writeFileSync(
          path.join(OUT_DIR, `${cfg.name.replace(/[^\w]/g, "_")}_r${round + 1}.json`),
          JSON.stringify({ wallMs, metrics: m, trace }, null, 2),
        );
        process.stderr.write(
          `boot=${m.totalMs}ms loadWin=${m.loadWindowMs}ms flushMax=${m.flush.max}ms concatMax=${m.concat.max}ms concatInWin=${m.concatInWindow.max}ms\n`,
        );
      } catch (e) {
        process.stderr.write(`FAILED: ${e.message}\n`);
      }
    }
  }

  // Drop first sample per config (warmup)
  const measured = {};
  for (const [name, runs] of Object.entries(all)) measured[name] = runs.slice(1);

  console.log("\n=== Summary (warmup dropped) ===\n");
  console.log(
    `${"config".padEnd(14)} ${"n".padStart(3)} ${"boot p50".padStart(10)} ${"boot p95".padStart(10)} ${"loadWin p50".padStart(12)} ${"loadWin p95".padStart(12)} ${"flush max p50".padStart(14)} ${"flush max p95".padStart(14)} ${"concat max p50".padStart(15)} ${"concat max p95".padStart(15)} ${"concat-inWin max p95".padStart(22)}`,
  );
  for (const cfg of CONFIGS) {
    const runs = measured[cfg.name] || [];
    if (!runs.length) {
      console.log(`${cfg.name.padEnd(14)} (no successful runs)`);
      continue;
    }
    const boots = runs.map((r) => r.totalMs);
    const lw = runs.map((r) => r.loadWindowMs).filter((x) => x != null);
    const fmx = runs.map((r) => r.flush.max);
    const cmx = runs.map((r) => r.concat.max);
    const ciw = runs.map((r) => r.concatInWindow.max);
    const fmt = (a) => String(a).padStart(0);
    console.log(
      `${cfg.name.padEnd(14)} ${String(runs.length).padStart(3)} ${String(median(boots)).padStart(10)} ${String(p95(boots)).padStart(10)} ${String(median(lw)).padStart(12)} ${String(p95(lw)).padStart(12)} ${String(median(fmx)).padStart(14)} ${String(p95(fmx)).padStart(14)} ${String(median(cmx)).padStart(15)} ${String(p95(cmx)).padStart(15)} ${String(p95(ciw)).padStart(22)}`,
    );
  }

  console.log("\n=== Raw runs per config ===");
  for (const cfg of CONFIGS) {
    const runs = measured[cfg.name] || [];
    console.log(`\n${cfg.name} (${runs.length} runs):`);
    runs.forEach((r, i) => {
      console.log(
        `  r${i + 2}: boot=${r.totalMs}ms loadWin=${r.loadWindowMs}ms flushN=${r.flush.n} flushMax=${r.flush.max}ms concatN=${r.concat.n} concatMax=${r.concat.max}ms concatInWinN=${r.concatInWindow.n} concatInWinMax=${r.concatInWindow.max}ms`,
      );
    });
  }

  console.log(`\nRaw per-run traces saved under: ${OUT_DIR}`);
};

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
