import "dotenv/config";

const BASE = process.argv[2] ?? "http://localhost:8787";

async function createSession(): Promise<string> {
  const res = await fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quest_id: "speckled-band" }), // no model_name — uses server default
  });
  const data = (await res.json()) as { session_id: string };
  return data.session_id;
}

async function takeTurn(sessionId: string, input: string): Promise<{ elapsed: number; narration: string }> {
  const start = Date.now();
  const res = await fetch(`${BASE}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, input }),
  });
  const data = (await res.json()) as { narration: string };
  return { elapsed: Date.now() - start, narration: data.narration };
}

const sessionId = await createSession();
console.log(`session: ${sessionId}`);
const r1 = await takeTurn(sessionId, "who is she?");
console.log(`turn 0 ("who is she?"): ${r1.elapsed}ms -> "${r1.narration.slice(0, 80)}"`);
const r2 = await takeTurn(sessionId, "who am i?");
console.log(`turn 1 ("who am i?"): ${r2.elapsed}ms -> "${r2.narration.slice(0, 80)}"`);
