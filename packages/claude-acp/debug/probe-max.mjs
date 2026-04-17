import { query } from "@anthropic-ai/claude-agent-sdk";

const PROMPT = "Solve: what's the smallest prime > 100 whose digits sum to a multiple of 7? Think step by step, and double-check your reasoning.";

const cfgs = [
  { label: "adaptive+summ, effort high", thinking: {type:"adaptive",display:"summarized"}, effort: "high" },
  { label: "adaptive+summ, effort max", thinking: {type:"adaptive",display:"summarized"}, effort: "max" },
  { label: "enabled 32000+summ, effort max", thinking: {type:"enabled",budgetTokens:32000,display:"summarized"}, effort: "max" },
];

for (const c of cfgs) {
  let chars=0, deltas=0;
  const q = query({prompt: PROMPT, options: {model:"opus", includePartialMessages:true, thinking:c.thinking, effort:c.effort, cwd:process.cwd()}});
  for await (const m of q) {
    if (m.type==="stream_event" && m.event.type==="content_block_delta" && m.event.delta?.type==="thinking_delta") { deltas++; chars += (m.event.delta.thinking??"").length; }
    if (m.type==="result") break;
  }
  console.log(`${c.label}: ${deltas} deltas, ${chars} chars`);
}
