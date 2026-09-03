// Diagnostic: does thinking: {type:"disabled"} stop claude-sonnet-5 from
// spending the whole output budget on an opaque thinking block with no text?
import "dotenv/config";
import { readFileSync } from "node:fs";

const promptFile = process.argv[2]!;
const maxTokens = Number(process.argv[3] ?? 800);

const full = readFileSync(promptFile, "utf8");
const match = full.match(/^\[SYSTEM\]\n([\s\S]*?)\n\n\[USER\]\n([\s\S]*)$/);
if (!match) throw new Error("Could not split system/user from prompt file");
const system = match[1]!;
const user = match[2]!;

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
    thinking: { type: "disabled" },
  }),
});

const data = (await res.json()) as any;
console.log(`http_status=${res.status}`);
if (data.error) console.log(`error=${JSON.stringify(data.error)}`);
console.log(`stop_reason=${JSON.stringify(data.stop_reason)}`);
console.log(`usage=${JSON.stringify(data.usage)}`);
console.log(`content block types: ${JSON.stringify((data.content ?? []).map((b: any) => b.type))}`);
console.log(`text content: ${JSON.stringify((data.content ?? []).find((b: any) => b.type === "text"))}`);
