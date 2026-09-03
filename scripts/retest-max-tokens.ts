// Retest for Issue A / Fix 2: plays several turns against the live Anthropic
// adapter with max_tokens raised to 800, to confirm no more empty/truncated
// completions (output_tokens landing exactly at the cap) and to sanity-check
// latency didn't regress back toward the pre-500 problem.
export {};

const BASE = process.argv[2] ?? "http://localhost:8787";

async function createSession(): Promise<string> {
  const res = await fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quest_id: "speckled-band", model_name: "claude-sonnet-5" }),
  });
  const data = (await res.json()) as { session_id: string };
  if (!res.ok) throw new Error(`POST /session failed: ${JSON.stringify(data)}`);
  return data.session_id;
}

async function takeTurn(sessionId: string, input: string): Promise<void> {
  const start = Date.now();
  const res = await fetch(`${BASE}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, input }),
  });
  const data = (await res.json()) as { narration: string };
  const elapsed = Date.now() - start;
  if (!res.ok) throw new Error(`POST /turn failed: ${JSON.stringify(data)}`);
  console.log(`  [${elapsed}ms] "${input}" -> "${data.narration.slice(0, 80)}${data.narration.length > 80 ? "…" : ""}"`);
}

const sessionId = await createSession();
console.log(`session: ${sessionId}`);

const inputs = [
  "tell me about your sister",
  "what were the sounds she heard at night?",
  "does she have any bruises?",
  "let's go look into the will",
  "did you find anything?",
];

for (const input of inputs) {
  await takeTurn(sessionId, input);
}

console.log(`\ntrace with: npx tsx scripts/trace-live-session.ts ${sessionId}`);
