// Quick quality spot-check for part3: same reordering used for the caching
// experiment, capturing actual narration text (not just latency/tokens) for
// a few turns, so "equivalent quality" isn't just asserted.
import "dotenv/config";
import { createDbClientFromEnv, listTurnLogs } from "../src/db.ts";
import { splitActualPrompt } from "./lib/prompt-sections.ts";

const sessionId = process.argv[2]!;
const client = createDbClientFromEnv();
const logs = (await listTurnLogs(client, sessionId)).filter((l) => l.validation.valid);
const sample = [logs[0]!, logs[3]!, logs[6]!, logs[9]!]; // spread across the session

async function callModel(system: string | any[], user: string) {
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
  const text = data.content?.find((b: any) => b.type === "text")?.text ?? "";
  return { latencyMs, text, usage: data.usage };
}

for (const log of sample) {
  const m = log.prompt.match(/^\[SYSTEM\]\n([\s\S]*?)\n\n\[USER\]\n([\s\S]*)$/)!;
  const system = m[1]!;
  const user = m[2]!.split("\n\n---\n\nYour previous response was rejected")[0]!;
  const split = splitActualPrompt(system);
  const [s0, s1, s2, s3, s4, s5, s6, s7, s8] = split.staticSpans;
  const staticPrefix = [s0, split.sections.FRAME, s1, split.sections.WORLD, s2, split.sections.CANON, s3, s4, s5, s6, s7, split.sections.INPUT, s8].join("");
  const dynamicSuffix = [split.sections.SCENE, split.sections.CHARACTERS, split.sections.INVENTED, split.sections.HISTORY].join("\n\n");

  console.log(`\n### turn_index=${log.turn_index}, input="${user}"`);

  const plain = await callModel(system, user);
  console.log(`  PLAIN:   ${plain.text.slice(0, 250)}`);

  const cached = await callModel(
    [
      { type: "text", text: staticPrefix, cache_control: { type: "ephemeral" } },
      { type: "text", text: dynamicSuffix },
    ],
    user
  );
  console.log(`  CACHED:  ${cached.text.slice(0, 250)}`);
}
