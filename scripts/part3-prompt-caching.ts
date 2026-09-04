// PART 3: does Anthropic prompt caching actually reduce latency, or only
// cost? Replays the SAME real 10-turn scripted playthrough's exact stored
// prompts (from turn_logs) against the raw API twice: once as a single plain
// system string (current behaviour, no caching), once split into
// [static prefix with cache_control][dynamic suffix] at the boundary
// identified in part1 (template + FRAME + WORLD + CANON is byte-identical
// across every turn of this quest; SCENE/CHARACTERS/INVENTED/HISTORY vary).
// Standalone script only — does not touch src/models/anthropic.ts.
import "dotenv/config";
import { createDbClientFromEnv, listTurnLogs } from "../src/db.ts";
import { splitActualPrompt } from "./lib/prompt-sections.ts";

const sessionId = process.argv[2]!;
const client = createDbClientFromEnv();
const logs = (await listTurnLogs(client, sessionId)).filter((l) => l.validation.valid);
console.log(`Replaying ${logs.length} real turns from session ${sessionId}\n`);

interface Turn {
  turnIndex: number;
  system: string;
  user: string;
  staticPrefix: string;
  dynamicSuffix: string;
}

const turns: Turn[] = logs.map((log) => {
  const m = log.prompt.match(/^\[SYSTEM\]\n([\s\S]*?)\n\n\[USER\]\n([\s\S]*)$/);
  if (!m) throw new Error(`turn_index=${log.turn_index}: could not parse stored prompt`);
  const system = m[1]!;
  const user = m[2]!.split("\n\n---\n\nYour previous response was rejected")[0]!;
  const split = splitActualPrompt(system);
  const [s0, s1, s2, s3, s4, s5, s6, s7, s8] = split.staticSpans;

  // Static (quest/template-constant, identical every turn of this session):
  // all template prose + FRAME + WORLD + CANON + the fixed INPUT-placeholder
  // text — reassembled CONTIGUOUSLY so a single cache breakpoint can cover
  // all of it. This deliberately reorders the document (the real template
  // interleaves FRAME/WORLD/CANON with SCENE/CHARACTERS/etc. inside "What
  // you receive", then puts the bulk of the static rules AFTER all of that)
  // — nothing is dropped or reworded, only regrouped for cache locality.
  const staticPrefix = [s0, split.sections.FRAME, s1, split.sections.WORLD, s2, split.sections.CANON, s3, s4, s5, s6, s7, split.sections.INPUT, s8].join(
    ""
  );
  // Dynamic (varies every turn): scene state, characters at current level,
  // invented details so far, recent history.
  const dynamicSuffix = [split.sections.SCENE, split.sections.CHARACTERS, split.sections.INVENTED, split.sections.HISTORY].join("\n\n");

  return { turnIndex: log.turn_index, system, user, staticPrefix, dynamicSuffix };
});

console.log(`Static prefix length (turn 0): ${turns[0]!.staticPrefix.length} chars`);
console.log(`Static prefix identical across all turns: ${turns.every((t) => t.staticPrefix === turns[0]!.staticPrefix)}`);
console.log(`Dynamic suffix length range: ${Math.min(...turns.map((t) => t.dynamicSuffix.length))}-${Math.max(...turns.map((t) => t.dynamicSuffix.length))} chars\n`);

async function callPlain(system: string, user: string) {
  const start = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 800,
      system,
      messages: [{ role: "user", content: user }],
      thinking: { type: "disabled" },
    }),
  });
  const latencyMs = Date.now() - start;
  const data = (await res.json()) as any;
  if (data.error) throw new Error(JSON.stringify(data.error));
  return { latencyMs, usage: data.usage };
}

async function callReorderedNoCache(staticPrefix: string, dynamicSuffix: string, user: string) {
  const start = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 800,
      system: staticPrefix + dynamicSuffix,
      messages: [{ role: "user", content: user }],
      thinking: { type: "disabled" },
    }),
  });
  const latencyMs = Date.now() - start;
  const data = (await res.json()) as any;
  if (data.error) throw new Error(JSON.stringify(data.error));
  return { latencyMs, usage: data.usage };
}

async function callCached(staticPrefix: string, dynamicSuffix: string, user: string) {
  const start = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 800,
      system: [
        { type: "text", text: staticPrefix, cache_control: { type: "ephemeral" } },
        { type: "text", text: dynamicSuffix },
      ],
      messages: [{ role: "user", content: user }],
      thinking: { type: "disabled" },
    }),
  });
  const latencyMs = Date.now() - start;
  const data = (await res.json()) as any;
  if (data.error) throw new Error(JSON.stringify(data.error));
  return { latencyMs, usage: data.usage };
}

console.log("=== Run 1: WITHOUT caching (plain system string, current behaviour) ===");
const plainResults: { turnIndex: number; latencyMs: number; usage: any }[] = [];
for (const t of turns) {
  const r = await callPlain(t.system, t.user);
  plainResults.push({ turnIndex: t.turnIndex, latencyMs: r.latencyMs, usage: r.usage });
  console.log(`  turn ${t.turnIndex}: ${r.latencyMs}ms  input_tokens=${r.usage?.input_tokens} cache_read=${r.usage?.cache_read_input_tokens ?? 0} cache_write=${r.usage?.cache_creation_input_tokens ?? 0}`);
}

console.log("\n=== Run 2: reordered content, NO cache_control (isolates reordering from caching) ===");
const reorderedResults: { turnIndex: number; latencyMs: number; usage: any }[] = [];
for (const t of turns) {
  const r = await callReorderedNoCache(t.staticPrefix, t.dynamicSuffix, t.user);
  reorderedResults.push({ turnIndex: t.turnIndex, latencyMs: r.latencyMs, usage: r.usage });
  console.log(`  turn ${t.turnIndex}: ${r.latencyMs}ms  input_tokens=${r.usage?.input_tokens}`);
}

console.log("\n=== Run 3: WITH caching (cache_control on the same reordered static prefix) ===");
const cachedResults: { turnIndex: number; latencyMs: number; usage: any }[] = [];
for (const t of turns) {
  const r = await callCached(t.staticPrefix, t.dynamicSuffix, t.user);
  cachedResults.push({ turnIndex: t.turnIndex, latencyMs: r.latencyMs, usage: r.usage });
  console.log(`  turn ${t.turnIndex}: ${r.latencyMs}ms  input_tokens=${r.usage?.input_tokens} cache_read=${r.usage?.cache_read_input_tokens ?? 0} cache_write=${r.usage?.cache_creation_input_tokens ?? 0}`);
}

console.log("\n=== Summary (3-way) ===");
console.log("turn  1_plain_ms  2_reordered_ms  3_cached_ms  1_in_tok  2_in_tok  3_in_tok  cache_read  cache_write");
for (let i = 0; i < turns.length; i++) {
  const p = plainResults[i]!;
  const ro = reorderedResults[i]!;
  const c = cachedResults[i]!;
  console.log(
    `${p.turnIndex.toString().padStart(4)}  ${p.latencyMs.toString().padStart(10)}  ${ro.latencyMs.toString().padStart(14)}  ${c.latencyMs.toString().padStart(11)}  ${(p.usage?.input_tokens ?? 0).toString().padStart(8)}  ${(ro.usage?.input_tokens ?? 0).toString().padStart(8)}  ${(c.usage?.input_tokens ?? 0).toString().padStart(8)}  ${(c.usage?.cache_read_input_tokens ?? 0).toString().padStart(10)}  ${(c.usage?.cache_creation_input_tokens ?? 0).toString().padStart(11)}`
  );
}

function avg(results: { latencyMs: number }[], skipFirst = false): number {
  const slice = skipFirst ? results.slice(1) : results;
  return slice.reduce((s, r) => s + r.latencyMs, 0) / slice.length;
}
console.log(`\navg latency, all turns:      1_plain=${avg(plainResults).toFixed(0)}ms  2_reordered=${avg(reorderedResults).toFixed(0)}ms  3_cached=${avg(cachedResults).toFixed(0)}ms`);
console.log(
  `avg latency, turns 2-N only: 1_plain=${avg(plainResults, true).toFixed(0)}ms  2_reordered=${avg(reorderedResults, true).toFixed(0)}ms  3_cached=${avg(
    cachedResults,
    true
  ).toFixed(0)}ms  (excludes turn 1's cache-write cost for run 3)`
);
