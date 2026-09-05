// Replays a stored turn's exact system/user against the live Anthropic API
// with the same cache_control structure as src/models/anthropic.ts, to get
// the real cache_read_input_tokens / cache_creation_input_tokens breakdown
// turn_logs doesn't itself store.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { splitActualPrompt } from "./lib/prompt-sections.ts";

const promptFile = process.argv[2]!;
const model = process.argv[3] ?? "claude-sonnet-5";

const full = readFileSync(promptFile, "utf8");
const m = full.match(/^\[SYSTEM\]\n([\s\S]*?)\n\n\[USER\]\n([\s\S]*)$/);
if (!m) throw new Error("Could not parse prompt file");
const system = m[1]!;
const user = m[2]!.split("\n\n---\n\nYour previous response was rejected")[0]!;

const split = splitActualPrompt(system);
const [s0, s1, s2] = split.staticSpans;
// Same static/dynamic boundary src/prompt.ts's fillTemplateParts uses:
// template + FRAME + WORLD + CANON is static; SCENE onward is dynamic.
const systemStatic = [s0, split.sections.FRAME, s1, split.sections.WORLD, s2, split.sections.CANON].join("");
const systemDynamic = system.slice(systemStatic.length);

console.log(`static block: ${systemStatic.length} chars, dynamic: ${systemDynamic.length} chars`);

const start = Date.now();
const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": process.env.ANTHROPIC_API_KEY!,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model,
    max_tokens: 800,
    system: [
      { type: "text", text: systemStatic, cache_control: { type: "ephemeral" } },
      { type: "text", text: systemDynamic },
    ],
    messages: [{ role: "user", content: user }],
    thinking: { type: "disabled" },
  }),
});
const latencyMs = Date.now() - start;
const data = (await res.json()) as any;
console.log(`model=${model} latency=${latencyMs}ms`);
if (data.error) {
  console.log(`error=${JSON.stringify(data.error)}`);
} else {
  console.log(`usage=${JSON.stringify(data.usage)}`);
}
