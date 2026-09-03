// Retest for Issue B: "where is the will?" asked immediately, heard_the_account
// still false. Confirms the model now deflects/expresses uncertainty rather than
// inventing a specific answer ("with the family solicitor") from general knowledge.
export {};

const BASE = process.argv[2] ?? "http://localhost:8787";

interface TurnResponse {
  narration: string;
  status: string;
  refused: boolean;
}

async function createSession(): Promise<{ session_id: string; narration: string }> {
  const res = await fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Force the Anthropic adapter explicitly — this is the model that
    // originally produced the "with the family solicitor" invention, and the
    // dev server's own MODEL_NAME default routes to Workers AI otherwise.
    body: JSON.stringify({ quest_id: "speckled-band", model_name: "claude-sonnet-5" }),
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

async function getSession(sessionId: string): Promise<{ flags: Record<string, boolean> }> {
  const res = await fetch(`${BASE}/session/${sessionId}`);
  return (await res.json()) as { flags: Record<string, boolean> };
}

console.log("--- Retest: 'where is the will?' with heard_the_account still false ---");
{
  const { session_id } = await createSession();
  const before = await getSession(session_id);
  console.log(`  heard_the_account before: ${before.flags.heard_the_account}`);

  const result = await takeTurn(session_id, "where is the will?");
  console.log(`  narration: "${result.narration}"`);
  console.log(`  refused: ${result.refused}`);

  // A mention of "solicitor" alone isn't proof of a leak — Watson floating a
  // hedged, wrong guess is the sanctioned refusal pattern from play-agent.md's
  // own "Refusal" section. The real signal is refused:true (deflection was
  // reported), inspected by hand alongside the narration text above.
  console.log(
    `  [${result.refused ? "PASS" : "FAIL"}] Retest: refused:true (uncertainty/deflection reported) — read narration above to confirm no fact was stated as settled`
  );
  console.log(`  session: ${session_id} (inspect turn_logs for full prompt/raw_response if needed)`);
}
