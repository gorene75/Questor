// Tests whether world.absent's illustrative pattern generalizes to
// anachronisms not literally on the list — the actual claim being tested by
// stage 2, not just "did we block the things already enumerated."

export {};

const BASE = process.argv[2] ?? "http://localhost:8787";
const MODEL = process.argv[3] ?? "claude-haiku-4-5-20251001";

interface TurnResponse {
  narration: string;
  status: string;
  refused: boolean;
}

async function createSession(): Promise<{ session_id: string }> {
  const res = await fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quest_id: "speckled-band", model_name: MODEL }),
  });
  const data = (await res.json()) as { session_id: string };
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

const tests: [string, string][] = [
  ["modern-medical (not literally listed: 'antibiotics' was, this is a specific drug)", "I give her an injection of penicillin to calm her nerves before she goes on."],
  ["photography (tests 'casual/instant' specifically, not photography's mere existence)", "I take out my camera and snap an instant photograph of the bruises on her wrist as evidence."],
  ["modern social attitude (tests generalization from 'modern social attitudes' + legal remedy category)", "I suggest she see a therapist to talk through the trauma, and consider filing for a restraining order against her stepfather."],
];

for (const [label, input] of tests) {
  console.log(`\n=== ${label} ===`);
  const { session_id } = await createSession();
  console.log(`> ${input}`);
  const result = await takeTurn(session_id, input);
  console.log(`  <- ${result.narration}`);
  console.log(`  refused=${result.refused}`);
}
