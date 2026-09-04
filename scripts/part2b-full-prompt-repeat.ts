// Follow-up to part2: the full (~30K) prompt failed clean-JSON parsing in
// 3/4 single-shot trials while the narrowed (~4K) prompt was clean in 4/4.
// Repeat the full-prompt condition a few more times per case to check
// whether that's a real pattern or n=1 noise.
import "dotenv/config";
import { readFileSync } from "node:fs";

const SCRATCH = "C:/Users/EFI~1.GOR/AppData/Local/Temp/claude/c--projects-Questor/571d38eb-bfab-49f6-a7e8-eb2d20cc897e/scratchpad";

async function callModel(system: string, user: string) {
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
  let parseOk = true;
  try {
    JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\n?/, "")
        .replace(/\n?```$/, "")
    );
  } catch {
    parseOk = false;
  }
  return { latencyMs, parseOk, textPreview: text.slice(0, 60) };
}

function extractFullSystemAndUser(file: string) {
  const full = readFileSync(file, "utf8");
  const m = full.match(/^\[SYSTEM\]\n([\s\S]*?)\n\n\[USER\]\n([\s\S]*)$/);
  const user = m![2]!.split("\n\n---\n\nYour previous response was rejected")[0]!;
  return { system: m![1]!, user };
}

const cases = [
  { label: "A: reveal", file: `${SCRATCH}/turn0_reveal.txt` },
  { label: "B: deflect", file: `${SCRATCH}/turn2_deflect.txt` },
  { label: "C: exit", file: `${SCRATCH}/turn5_exit.txt` },
  { label: "D: conversation", file: `${SCRATCH}/turn8_conversation.txt` },
];

const REPEATS = 4;
for (const c of cases) {
  const { system, user } = extractFullSystemAndUser(c.file);
  console.log(`\n### ${c.label} — ${REPEATS} repeat calls, full prompt (${system.length} chars)`);
  let cleanCount = 0;
  for (let i = 0; i < REPEATS; i++) {
    const r = await callModel(system, user);
    if (r.parseOk) cleanCount++;
    console.log(`  trial ${i + 1}: ${r.latencyMs}ms  parse=${r.parseOk ? "OK" : "FAILED"}  preview="${r.textPreview}"`);
  }
  console.log(`  -> ${cleanCount}/${REPEATS} clean first-shot JSON`);
}
