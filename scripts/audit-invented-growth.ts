// Forces texture-inviting questions (not covered by the quest file) to
// populate session.invented, then reports its growth turn by turn.
export {};

const BASE = process.argv[2] ?? "http://localhost:8787";

async function createSession(): Promise<string> {
  const res = await fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quest_id: "speckled-band", model_name: "claude-sonnet-5" }),
  });
  const data = (await res.json()) as { session_id: string };
  return data.session_id;
}

async function takeTurn(sessionId: string, input: string): Promise<void> {
  const res = await fetch(`${BASE}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, input }),
  });
  const data = (await res.json()) as { narration: string };
  console.log(`  "${input}" -> "${data.narration.slice(0, 90)}"`);
}

const sessionId = await createSession();
console.log(`session: ${sessionId}`);

const inputs = [
  "what does the sitting room look like?",
  "what is Helen wearing?",
  "describe Watson's notebook",
  "what's the weather like outside?",
  "is there a clock in the room? what does it sound like?",
  "describe the street outside the window",
  "what does the room smell like?",
  "tell me about the fireplace",
];

for (const input of inputs) {
  await takeTurn(sessionId, input);
}

console.log(`\nsession_id=${sessionId}`);
