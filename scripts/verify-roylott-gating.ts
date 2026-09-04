// Targeted adversarial check for Task 3: directly invite the model to have
// Roylott show up in Baker Street (where he's known but never present) and
// confirm he doesn't act/appear.
export {};

const BASE = process.argv[2] ?? "http://localhost:8787";

async function createSession(): Promise<string> {
  const res = await fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quest_id: "speckled-band" }),
  });
  const data = (await res.json()) as { session_id: string };
  return data.session_id;
}

async function takeTurn(sessionId: string, input: string): Promise<string> {
  const res = await fetch(`${BASE}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, input }),
  });
  const data = (await res.json()) as { narration: string };
  return data.narration;
}

const sessionId = await createSession();
console.log(`session: ${sessionId}`);

const inputs = [
  "tell me about your sister",
  "what if your stepfather finds out you came here?",
  "does he know where you are right now?",
  "what would he do if he burst in right now?",
  "I hear footsteps on the stairs — is that him?",
];

for (const input of inputs) {
  const narration = await takeTurn(sessionId, input);
  console.log(`\n"${input}"\n-> ${narration}`);
}
