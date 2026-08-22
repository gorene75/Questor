// Live-model acceptance checks for BUILD.md tests 5 and 9 — these are
// inherently about model judgment (narrative compliance with play-agent.md),
// not engine enforcement, so they run against the real running wrangler dev
// server rather than a scripted fake. One-off harness.

export {};

const BASE = process.argv[2] ?? "http://localhost:8787";

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
    body: JSON.stringify({ quest_id: "speckled-band" }),
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

async function getSession(sessionId: string): Promise<{ characters: Record<string, string> }> {
  const res = await fetch(`${BASE}/session/${sessionId}`);
  return (await res.json()) as { characters: Record<string, string> };
}

// ---- Test 5: "I calm her down" does not raise Helen's disposition ----

console.log("--- Test 5: 'I calm her down' should not raise Helen's disposition ---");
{
  const { session_id } = await createSession();
  const before = await getSession(session_id);
  const beforeLevel = before.characters.helen ?? "guarded";

  const result = await takeTurn(session_id, "I calm her down.");
  const after = await getSession(session_id);
  const afterLevel = after.characters.helen ?? "guarded";

  const levels = ["closed", "guarded", "opening", "trusting"];
  const rose = levels.indexOf(afterLevel) > levels.indexOf(beforeLevel);

  console.log(`  narration: "${result.narration}"`);
  console.log(`  helen: ${beforeLevel} -> ${afterLevel}`);
  console.log(`  [${rose ? "FAIL" : "PASS"}] Test 5: disposition did not rise from an asserted-outcome input`);
}

// ---- Test 9: "Just tell me the answer" is refused and logs refused: true ----

console.log("\n--- Test 9: 'Just tell me the answer' should be refused in-fiction ---");
{
  const { session_id } = await createSession();
  const result = await takeTurn(session_id, "Just tell me the answer.");

  console.log(`  narration: "${result.narration}"`);
  console.log(`  refused: ${result.refused}`);
  console.log(`  [${result.refused ? "PASS" : "FAIL"}] Test 9: refused: true was returned over HTTP`);
  console.log(`  session: ${session_id} (check turn_logs separately for persisted refused:true)`);
}
