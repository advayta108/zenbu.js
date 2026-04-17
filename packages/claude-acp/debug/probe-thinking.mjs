#!/usr/bin/env node
// Probe whether Opus 4.7 emits cleartext thinking when we explicitly set
// `thinking: { type: 'adaptive', display: 'summarized' }` via the SDK.
//
// Runs two queries through @anthropic-ai/claude-agent-sdk against the local
// authenticated CLI, one per config, and reports how much cleartext thinking
// each produced.

import { query } from "@anthropic-ai/claude-agent-sdk";

const PROMPT =
  "Solve: what's the smallest prime > 100 whose digits sum to a multiple of 7? Think step by step.";

const configs = [
  { label: "default (no thinking override)", thinking: undefined },
  {
    label: "adaptive + summarized",
    thinking: { type: "adaptive", display: "summarized" },
  },
  {
    label: "enabled budgetTokens=8000 + summarized",
    thinking: { type: "enabled", budgetTokens: 8000, display: "summarized" },
  },
  {
    label: "adaptive + omitted (control)",
    thinking: { type: "adaptive", display: "omitted" },
  },
];

async function runOne(cfg, model) {
  const stats = {
    label: cfg.label,
    model,
    thinkingBlockEmpty: 0,
    thinkingBlockNonEmpty: 0,
    thinkingDeltaCount: 0,
    thinkingCleartextChars: 0,
    signatureDeltaCount: 0,
    firstThinkingBlock: null,
    error: null,
  };

  try {
    const q = query({
      prompt: PROMPT,
      options: {
        model,
        includePartialMessages: true,
        ...(cfg.thinking !== undefined ? { thinking: cfg.thinking } : {}),
        effort: "high",
        // No-op cwd — just a safe folder.
        cwd: process.cwd(),
      },
    });
    for await (const msg of q) {
      if (msg.type === "stream_event") {
        const ev = msg.event;
        if (ev.type === "content_block_start" && ev.content_block?.type === "thinking") {
          const cb = ev.content_block;
          if (!stats.firstThinkingBlock) stats.firstThinkingBlock = cb;
          if ((cb.thinking ?? "").length === 0) stats.thinkingBlockEmpty++;
          else stats.thinkingBlockNonEmpty++;
        }
        if (ev.type === "content_block_delta") {
          const d = ev.delta;
          if (d?.type === "thinking_delta") {
            stats.thinkingDeltaCount++;
            stats.thinkingCleartextChars += (d.thinking ?? "").length;
          }
          if (d?.type === "signature_delta") {
            stats.signatureDeltaCount++;
          }
        }
      }
      if (msg.type === "result") break;
    }
  } catch (err) {
    stats.error = err?.message || String(err);
  }

  return stats;
}

function fmt(rows) {
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)),
  );
  const pad = (v, w) => String(v ?? "").padEnd(w);
  const line = (r) => cols.map((c, i) => pad(r[c], widths[i])).join("  ");
  return [
    line(Object.fromEntries(cols.map((c) => [c, c]))),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map(line),
  ].join("\n");
}

async function main() {
  const models = (process.argv[2] || "opus,sonnet").split(",");
  const rows = [];
  for (const model of models) {
    for (const cfg of configs) {
      console.error(`→ ${model} / ${cfg.label}`);
      const s = await runOne(cfg, model);
      rows.push({
        model,
        config: cfg.label,
        "thinking blocks (0/1+)": `${s.thinkingBlockEmpty}/${s.thinkingBlockNonEmpty}`,
        thinking_delta: s.thinkingDeltaCount,
        chars: s.thinkingCleartextChars,
        signature_delta: s.signatureDeltaCount,
        error: s.error ?? "",
      });
    }
  }
  console.log("\n" + fmt(rows));
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exit(1);
});
