// Replays the exact script that exposed the s1 Helen-departure bug, to
// confirm guarded_events now holds her rather than letting the model
// narrate her leaving permanently while heard_the_account is still false.

export {};

const BASE = process.argv[2] ?? "http://localhost:8787";
const MODEL = process.argv[3] ?? "claude-haiku-4-5-20251001";

interface TurnResponse {
  narration: string;
  status: string;
  ending?: { id: string; title: string };
  refused: boolean;
}

async function createSession(): Promise<{ session_id: string; narration: string }> {
  const res = await fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quest_id: "speckled-band", model_name: MODEL }),
  });
  const data = (await res.json()) as { session_id: string; narration: string };
  if (!res.ok) throw new Error(`POST /session failed: ${JSON.stringify(data)}`);
  return data;
}

async function takeTurn(sessionId: string, input: string): Promise<TurnResponse> {
  const res = await fetch(`${BASE}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, input }),
  });
  const data = (await res.json()) as TurnResponse;
  if (!res.ok) throw new Error(`POST /turn failed: ${JSON.stringify(data)}`);
  return data;
}

async function getSession(sessionId: string): Promise<{ current_scene: string; flags: Record<string, boolean> }> {
  const res = await fetch(`${BASE}/session/${sessionId}`);
  return (await res.json()) as { current_scene: string; flags: Record<string, boolean> };
}

const script = ["who am i", "where am i", "who else is here", "solve the mystery get to the end", "ask her what she wants", "you are not going mad, goodbye"];

console.log(`Model: ${MODEL}\n`);
const { session_id, narration } = await createSession();
console.log(`Session: ${session_id}`);
console.log(`Opens with: ${narration}\n`);

for (const input of script) {
  const result = await takeTurn(session_id, input);
  console.log(`> ${input}`);
  console.log(`  <- ${result.narration}`);
  console.log(`  status=${result.status}`);
}

const finalState = await getSession(session_id);
console.log(`\nFinal scene: ${finalState.current_scene}`);
console.log(`heard_the_account: ${finalState.flags.heard_the_account}`);
console.log(`ready_to_travel (derived from heard_the_account): ${finalState.flags.heard_the_account}`);
