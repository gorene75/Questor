// Diagnostic: replay one exact prompt against the raw Anthropic API (not
// through the adapter) and dump the full response — content block types,
// stop_reason, usage — to see what's actually consuming the output budget
// on turns that come back empty/truncated.
import "dotenv/config";
import { readFileSync } from "node:fs";

const promptFile = process.argv[2]!;
const maxTokens = Number(process.argv[3] ?? 800);

const full = readFileSync(promptFile, "utf8");
const match = full.match(/^\[SYSTEM\]\n([\s\S]*?)\n\n\[USER\]\n([\s\S]*)$/);
if (!match) throw new Error("Could not split system/user from prompt file");
const system = match[1]!;
const user = match[2]!;

console.log(`system_len=${system.length} user_len=${user.length} max_tokens=${maxTokens}`);

const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": process.env.ANTHROPIC_API_KEY!,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: "claude-sonnet-5",
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  }),
});

const data = await res.json();
console.log(`http_status=${res.status}`);
console.log(`stop_reason=${JSON.stringify((data as any).stop_reason)}`);
console.log(`usage=${JSON.stringify((data as any).usage)}`);
console.log(`content block types: ${JSON.stringify(((data as any).content ?? []).map((b: any) => b.type))}`);
console.log(`full content array:\n${JSON.stringify((data as any).content, null, 2)}`);
