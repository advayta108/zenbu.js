#!/usr/bin/env node
/**
 * Boot-perf harness.
 *
 * Spawns Electron N times with `ZENBU_PERF_EXIT_ON_READY=1`, waits for the
 * kernel's bootBus.ready handler to write `boot-trace.json` and call
 * `app.quit()`, then parses the JSON and reports p50/p95 of the metrics
 * we care about.
 *
 *   node apps/kernel/scripts/perf-boot.mjs            # 5 runs, default
 *   node apps/kernel/scripts/perf-boot.mjs --runs 10  # custom run count
 *   node apps/kernel/scripts/perf-boot.mjs --json     # JSON output for diffs
 *
 * Diff against a baseline:
 *   node apps/kernel/scripts/perf-boot.mjs --json > current.json
 *   diff <baseline> current.json
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const runsIdx = args.indexOf("--runs");
const RUNS = runsIdx >= 0 ? Number(args[runsIdx + 1]) : 5;
const JSON_OUTPUT = args.includes("--json");
const KEEP_OPEN = args.includes("--keep-open"); // for debugging

const KERNEL_DIR = path.resolve(new URL(".", import.meta.url).pathname, "..");
const TRACE_PATH = path.join(os.homedir(), ".zenbu", ".internal", "boot-trace.json");

const log = (...x) => { if (!JSON_OUTPUT) console.log(...x); };

const runOnce = async (i) => {
  // Remove any stale trace so we can detect when this run finishes.
  try { fs.unlinkSync(TRACE_PATH); } catch {}

  const env = { ...process.env };
  if (!KEEP_OPEN) env.ZENBU_PERF_EXIT_ON_READY = "1";

  log(`[perf-boot] run ${i + 1}/${RUNS} starting…`);
  const t0 = Date.now();

  await new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["dev"], {
      cwd: KERNEL_DIR,
      env,
      stdio: JSON_OUTPUT ? "ignore" : ["ignore", "inherit", "inherit"],
    });
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`electron exited with code ${code}`));
      } else {
        resolve();
      }
    });
    child.on("error", reject);
  });

  const wallMs = Date.now() - t0;

  if (!fs.existsSync(TRACE_PATH)) {
    throw new Error(`boot-trace.json not found at ${TRACE_PATH} after run ${i + 1}`);
  }
  const trace = JSON.parse(fs.readFileSync(TRACE_PATH, "utf-8"));
  log(`[perf-boot] run ${i + 1}/${RUNS} → boot ${trace.totalMs}ms (wall ${wallMs}ms)`);
  return trace;
};

const pickPhaseMs = (trace, name) => {
  const span = trace.rootSpans.find((s) => s.name === `phase:${name}`);
  return span ? span.durationMs : null;
};

const pickMarkOffset = (trace, name) => {
  const m = trace.marks.find((mk) => mk.name === name);
  return m ? m.at - trace.bootStartedAt : null;
};

const pickKyjuStat = (trace, name) => {
  // After bootBus.ready, Kyju spans are aggregated/hidden in the renderer
  // but the raw rootSpans still contain individual entries. Aggregate here.
  const matching = trace.rootSpans.filter((s) => s.name === name);
  if (matching.length === 0) return { count: 0, totalMs: 0, avgMs: 0 };
  const totalMs = matching.reduce((sum, s) => sum + s.durationMs, 0);
  return { count: matching.length, totalMs, avgMs: totalMs / matching.length };
};

const summary = (traces) => {
  const sortedTotals = traces.map((t) => t.totalMs).sort((a, b) => a - b);
  const p50 = (arr) => arr[Math.floor(arr.length * 0.5)];
  const p95 = (arr) => arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.95))];

  const reduceMetric = (extract) => {
    const values = traces.map(extract).filter((v) => v != null).sort((a, b) => a - b);
    return values.length ? { p50: p50(values), p95: p95(values), n: values.length } : null;
  };

  return {
    runs: traces.length,
    totalBoot: { p50: p50(sortedTotals), p95: p95(sortedTotals), all: sortedTotals },
    phases: {
      "plugin-import": reduceMetric((t) => pickPhaseMs(t, "plugin-import")),
      "runtime-drain": reduceMetric((t) => pickPhaseMs(t, "runtime-drain")),
      "env-bootstrap": reduceMetric((t) => pickPhaseMs(t, "env-bootstrap")),
    },
    marks: {
      "vite-ready": reduceMetric((t) => pickMarkOffset(t, "vite-ready")),
      "orchestrator-load-start": reduceMetric((t) => pickMarkOffset(t, "orchestrator-load-start")),
      "content-rendered": reduceMetric((t) => pickMarkOffset(t, "content-rendered")),
    },
    kyju: {
      "client.update": reduceMetric((t) => pickKyjuStat(t, "kyju:client.update").totalMs),
      "db.handleWrite": reduceMetric((t) => pickKyjuStat(t, "kyju:db.handleWrite").totalMs),
      "db.root.flush": reduceMetric((t) => pickKyjuStat(t, "kyju:db.root.flush").totalMs),
      "db.handleWrite.count": reduceMetric((t) => pickKyjuStat(t, "kyju:db.handleWrite").count),
      "db.root.flush.count": reduceMetric((t) => pickKyjuStat(t, "kyju:db.root.flush").count),
    },
  };
};

const printReport = (s) => {
  const ms = (v) => (v == null ? "n/a" : `${v}ms`);
  log(`\n=== perf-boot summary (${s.runs} runs) ===`);
  log(`Total boot:        p50 ${s.totalBoot.p50}ms  p95 ${s.totalBoot.p95}ms  (all: ${s.totalBoot.all.join(", ")})`);
  log(`\nPhases (p50 / p95):`);
  for (const [name, v] of Object.entries(s.phases)) {
    log(`  ${name.padEnd(20)} ${v ? `${ms(v.p50)} / ${ms(v.p95)}` : "n/a"}`);
  }
  log(`\nMarks (offset from boot, p50 / p95):`);
  for (const [name, v] of Object.entries(s.marks)) {
    log(`  ${name.padEnd(28)} ${v ? `${ms(v.p50)} / ${ms(v.p95)}` : "n/a"}`);
  }
  log(`\nKyju (p50 / p95):`);
  for (const [name, v] of Object.entries(s.kyju)) {
    log(`  ${name.padEnd(28)} ${v ? `${v.p50} / ${v.p95}` : "n/a"}`);
  }
};

const main = async () => {
  const traces = [];
  for (let i = 0; i < RUNS; i++) {
    try {
      traces.push(await runOnce(i));
    } catch (err) {
      console.error(`[perf-boot] run ${i + 1} failed:`, err.message);
    }
  }
  if (traces.length === 0) {
    console.error("[perf-boot] no successful runs");
    process.exit(1);
  }
  const s = summary(traces);
  if (JSON_OUTPUT) {
    process.stdout.write(JSON.stringify(s, null, 2) + "\n");
  } else {
    printReport(s);
  }
};

main().catch((err) => {
  console.error("[perf-boot] fatal:", err);
  process.exit(1);
});
