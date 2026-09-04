// Drives one real, scripted playthrough against the live server (unmodified
// engine) to produce fresh turn_logs data for the Part 1/2/3 audit scripts.
// Mix of turn types on purpose: reveals, a deflection, an exit, plain
// conversation — so later analysis isn't drawing conclusions from one shape
// of turn.
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
  const res = await fetch(`${BASE}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, input }),
  });
  const data = (await res.json()) as { narration: string };
  if (!res.ok) throw new Error(`POST /turn failed: ${JSON.stringify(data)}`);
  console.log(`  "${input}" -> "${data.narration.slice(0, 90)}${data.narration.length > 90 ? "…" : ""}"`);
}

const sessionId = await createSession();
console.log(`session: ${sessionId}`);

const inputs = [
  "tell me about your sister", // reveal: the_death
  "does she have any bruises?", // reveal: the_bruises
  "what should I do?", // deflection (refusal)
  "tell me more about the move to the manor house", // reveal: the_move (if heard_the_account true)
  "what was that whistling sound she mentioned?", // reveal: the_whistle, or gated deflect
  "let's go look into the will at the commons", // exit: to_commons
  "did you find anything about the money?", // conversation / reveal in new scene
  "let's head down to surrey now", // exit or deflect depending on scene graph
  "what do you make of the house?", // plain conversation
  "is there anything unusual about her room?", // plain conversation / possible reveal
];

for (const input of inputs) {
  await takeTurn(sessionId, input);
}

console.log(`\nsession_id=${sessionId}`);
