#!/usr/bin/env node
// Compare stream-json output across Claude models to debug thinking emission.
//
// Uses the local, already-authenticated `claude` CLI (same path that the
// claude-agent-sdk spawns under the hood) via `claude -p --output-format
// stream-json --include-partial-messages --verbose --model <model>`.
//
// Writes per-model JSONL traces to <outdir>/<model>.jsonl and prints a summary
// comparing event-type counts and any thinking-related payloads.
//
// Usage:
//   node debug/compare-thinking.mjs \
//     [--prompt "..."] \
//     [--models opus,sonnet,haiku] \
//     [--effort high] \
//     [--outdir debug-out] \
//     [--claude /path/to/claude]
//
// Notes:
// - Auth: inherits the local `claude` login (OAuth managed key, keychain, or
//   ANTHROPIC_API_KEY — whatever `claude` already uses). No extra setup needed.
// - `--include-partial-messages` is what makes the CLI emit per-delta
//   `stream_event` frames (thinking_delta, signature_delta, text_delta, ...).
// - Models can be aliases (opus, sonnet, haiku) or full IDs (claude-opus-4-7).

import { spawn } from "node:child_process";
import { mkdir, writeFile, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULTS = {
  prompt:
    "Solve: what's the smallest prime > 100 whose digits sum to a multiple of 7? Think step by step.",
  models: ["opus", "sonnet", "haiku"],
  effort: "high",
  outdir: "debug-out",
  claude: process.env.CLAUDE_CODE_EXECUTABLE || "claude",
};

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--prompt":
        out.prompt = next();
        break;
      case "--models":
        out.models = next().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--effort":
        out.effort = next();
        break;
      case "--outdir":
        out.outdir = next();
        break;
      case "--claude":
        out.claude = next();
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        console.error(`Unknown arg: ${a}`);
        printHelp();
        process.exit(2);
    }
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node compare-thinking.mjs [options]

Options:
  --prompt <text>          Prompt to send (default: prime/digit-sum problem)
  --models <csv>           Comma-separated model aliases/IDs (default: opus,sonnet,haiku)
  --effort <level>         low|medium|high|xhigh|max (default: high)
  --outdir <dir>           Where to write JSONL traces (default: debug-out)
  --claude <path>          Path to claude executable (default: $CLAUDE_CODE_EXECUTABLE or \`claude\`)
  -h, --help               Show this help
`);
}

/**
 * Runs the claude CLI for one model, streams stdout line-by-line into a
 * JSONL file, and accumulates a summary of every event seen.
 */
async function runOne({ claude, model, prompt, effort, jsonlPath }) {
  const args = [
    "-p",
    "--model",
    model,
    "--effort",
    effort,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    prompt,
  ];

  const t0 = Date.now();
  const child = spawn(claude, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  const fh = await open(jsonlPath, "w");
  const summary = {
    model,
    args,
    durationMs: 0,
    exitCode: null,
    topLevelTypes: Object.create(null),
    streamEventTypes: Object.create(null),
    contentBlockStartTypes: Object.create(null),
    contentBlockDeltaTypes: Object.create(null),
    assistantContentTypes: Object.create(null),
    thinkingCleartextChars: 0,
    thinkingDeltaCount: 0,
    signatureDeltaCount: 0,
    emptyThinkingBlocks: 0,
    nonEmptyThinkingBlocks: 0,
    resolvedModel: null,
    firstSampleThinkingBlock: null, // full JSON of first thinking block seen
    firstSampleSignatureDelta: null,
    stderr: "",
  };

  const bump = (bucket, key) => {
    bucket[key] = (bucket[key] ?? 0) + 1;
  };

  let stdoutBuf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", async (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      await fh.write(line + "\n");
      try {
        const evt = JSON.parse(line);
        observe(evt, summary);
      } catch {
        // tolerate non-JSON lines — still in the file
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    summary.stderr += chunk;
  });

  const exitCode = await new Promise((res, rej) => {
    child.on("error", rej);
    child.on("close", res);
  });

  // flush remainder
  if (stdoutBuf.trim()) {
    await fh.write(stdoutBuf);
    try {
      observe(JSON.parse(stdoutBuf), summary);
    } catch {}
  }
  await fh.close();

  summary.exitCode = exitCode;
  summary.durationMs = Date.now() - t0;
  return summary;
}

function observe(evt, s) {
  const bump = (bucket, key) => {
    bucket[key] = (bucket[key] ?? 0) + 1;
  };

  const t = evt?.type ?? "<no-type>";
  bump(s.topLevelTypes, t);

  if (t === "system" && evt.subtype === "init" && typeof evt.model === "string") {
    s.resolvedModel = evt.model;
  }

  if (t === "stream_event") {
    const ev = evt.event ?? {};
    bump(s.streamEventTypes, ev.type ?? "<no-type>");
    if (ev.type === "content_block_start") {
      const cb = ev.content_block ?? {};
      bump(s.contentBlockStartTypes, cb.type ?? "<no-type>");
      if (cb.type === "thinking") {
        if (!s.firstSampleThinkingBlock) s.firstSampleThinkingBlock = cb;
        if ((cb.thinking ?? "").length === 0) s.emptyThinkingBlocks++;
        else s.nonEmptyThinkingBlocks++;
      }
    }
    if (ev.type === "content_block_delta") {
      const d = ev.delta ?? {};
      bump(s.contentBlockDeltaTypes, d.type ?? "<no-type>");
      if (d.type === "thinking_delta") {
        s.thinkingDeltaCount++;
        s.thinkingCleartextChars += (d.thinking ?? "").length;
      }
      if (d.type === "signature_delta") {
        s.signatureDeltaCount++;
        if (!s.firstSampleSignatureDelta) s.firstSampleSignatureDelta = d;
      }
    }
  }

  if (t === "assistant" && evt.message?.content) {
    for (const block of evt.message.content) {
      bump(s.assistantContentTypes, block?.type ?? "<no-type>");
    }
  }
}

function fmtTable(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)),
  );
  const pad = (v, w) => String(v ?? "").padEnd(w);
  const line = (r) => cols.map((c, i) => pad(r[c], widths[i])).join("  ");
  const header = line(Object.fromEntries(cols.map((c) => [c, c])));
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [header, sep, ...rows.map(line)].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const hereDir = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(hereDir, args.outdir);
  await mkdir(outDir, { recursive: true });

  console.error(`# compare-thinking`);
  console.error(`prompt : ${args.prompt}`);
  console.error(`models : ${args.models.join(", ")}`);
  console.error(`effort : ${args.effort}`);
  console.error(`claude : ${args.claude}`);
  console.error(`outdir : ${outDir}`);
  console.error("");

  const summaries = [];
  for (const model of args.models) {
    const safe = model.replace(/[^A-Za-z0-9._-]/g, "_");
    const jsonlPath = join(outDir, `${safe}.jsonl`);
    console.error(`→ running ${model} → ${jsonlPath}`);
    try {
      const s = await runOne({
        claude: args.claude,
        model,
        prompt: args.prompt,
        effort: args.effort,
        jsonlPath,
      });
      if (s.exitCode !== 0) {
        console.error(
          `  ! exit ${s.exitCode} — stderr tail: ${s.stderr.slice(-500)}`,
        );
      }
      await writeFile(
        join(outDir, `${safe}.summary.json`),
        JSON.stringify(s, null, 2),
      );
      summaries.push(s);
    } catch (err) {
      console.error(`  ! failed: ${err?.stack || err}`);
    }
  }

  console.log("\n## summary\n");
  console.log(
    fmtTable(
      summaries.map((s) => ({
        model: s.model,
        resolved: s.resolvedModel ?? "?",
        ms: s.durationMs,
        exit: s.exitCode,
        "thinking blocks (empty/nonempty)": `${s.emptyThinkingBlocks}/${s.nonEmptyThinkingBlocks}`,
        "thinking_delta": s.thinkingDeltaCount,
        "thinking chars": s.thinkingCleartextChars,
        "signature_delta": s.signatureDeltaCount,
      })),
    ),
  );

  console.log("\n## stream_event types by model\n");
  const allStreamTypes = new Set();
  summaries.forEach((s) => Object.keys(s.streamEventTypes).forEach((k) => allStreamTypes.add(k)));
  console.log(
    fmtTable(
      [...allStreamTypes].sort().map((t) => {
        const row = { "stream_event.type": t };
        for (const s of summaries) row[s.model] = s.streamEventTypes[t] ?? 0;
        return row;
      }),
    ),
  );

  console.log("\n## content_block_delta types by model\n");
  const allDeltaTypes = new Set();
  summaries.forEach((s) => Object.keys(s.contentBlockDeltaTypes).forEach((k) => allDeltaTypes.add(k)));
  console.log(
    fmtTable(
      [...allDeltaTypes].sort().map((t) => {
        const row = { "delta.type": t };
        for (const s of summaries) row[s.model] = s.contentBlockDeltaTypes[t] ?? 0;
        return row;
      }),
    ),
  );

  console.log("\n## first thinking content_block per model\n");
  for (const s of summaries) {
    console.log(`### ${s.model} (${s.resolvedModel ?? "?"})`);
    if (!s.firstSampleThinkingBlock) {
      console.log("(no thinking block emitted)");
    } else {
      const b = s.firstSampleThinkingBlock;
      console.log(
        JSON.stringify(
          {
            type: b.type,
            thinking: b.thinking,
            thinking_len: (b.thinking ?? "").length,
            signature: b.signature ? `${b.signature.slice(0, 32)}…(${b.signature.length} chars)` : b.signature,
          },
          null,
          2,
        ),
      );
    }
    console.log("");
  }

  console.log(`\nFull traces: ${outDir}`);
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
