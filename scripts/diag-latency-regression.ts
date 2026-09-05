import "dotenv/config";

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

for (let i = 0; i < 2; i++) {
  const sessionId = await createSession();
  const result = await takeTurn(sessionId, "tell me about your sister");
  console.log(`session ${i + 1}: ${sessionId}  http_elapsed=${result.elapsed}ms`);
}
