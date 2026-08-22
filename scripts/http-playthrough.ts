// Drives a real playthrough against a running `wrangler dev` server over
// genuine HTTP — proving /session, /turn, and GET /session/:id work through
// the actual Worker, not just via direct function calls like the other test
// scripts. Not part of the permanent test suite; a one-off harness for this
// walkthrough.

export {};

const BASE = process.argv[2] ?? "http://localhost:8787";

interface TurnResponse {
  narration: string;
  status: string;
  ending?: { id: string; title: string; direction: string };
  refused: boolean;
  error?: string;
}

interface SessionRow {
  current_scene: string;
  phase: string;
  flags: Record<string, boolean>;
  characters: Record<string, string>;
  invented: string[];
  scene_turn_count: number;
  status: string;
  ending_id: string | null;
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

async function getSession(sessionId: string): Promise<SessionRow> {
  const res = await fetch(`${BASE}/session/${sessionId}`);
  const data = (await res.json()) as SessionRow;
  if (!res.ok) throw new Error(`GET /session/${sessionId} failed: ${JSON.stringify(data)}`);
  return data;
}

// [input, label] pairs. Filler turns pad out s6's turns_in_scene:10 clock
// threshold since leaving a scene resets its counter — we can't just grab
// one clue and go back, the clock needs 10 consecutive turns in one room.
const script: [string, string][] = [
  ["How did your sister die?", "learn the account"],
  ["I'll set off for Stoke Moran now.", "travel to Surrey"],
  ["Let's go in and see the bedroom.", "enter bedroom"],
  ["I examine the bell-pull by the pillow.", "examine bell-pull"],
  ["I examine the bed.", "examine bed"],
  ["I examine the ventilator above the bed.", "examine ventilator"],
  ["Can I see Dr Roylott's room?", "enter Roylott's room"],
  ["I examine the dog lash hanging on the bedstead.", "examine lash"],
  ["I look at the safe again.", "filler 1"],
  ["I check the saucer of milk once more.", "filler 2"],
  ["I look closely at the marks on the chair.", "filler 3"],
  ["I ask again whether there's really no dog on the property.", "filler 4"],
  ["I look over the books on the shelf.", "filler 5"],
  ["I glance around the room once more.", "filler 6"],
  ["I check the safe's lock again.", "filler 7"],
  ["I look under the camp bed.", "filler 8"],
  ["I take one more look at the whole room.", "filler 9"],
  ["Let's head back to the bedroom.", "return to bedroom"],
  ["I'll keep watch here tonight.", "begin the watch"],
  ["I strike hard at the ventilator with my cane!", "strike"],
];

const { session_id, narration } = await createSession();
console.log(`Session: ${session_id}`);
console.log(`Opens with: ${narration}\n`);

for (const [input, label] of script) {
  const result = await takeTurn(session_id, input);
  console.log(`[${label}] > ${input}`);
  console.log(`  <- ${result.narration}${result.refused ? "  [refused: true]" : ""}`);

  if (result.status !== "active") {
    console.log(`\n*** Session ended: status=${result.status}` + (result.ending ? ` ending=${result.ending.id} ("${result.ending.title}")` : "") + " ***");
    console.log(`Direction: ${result.ending?.direction ?? "(none)"}`);
    break;
  }
}

console.log("\n--- final session state ---");
const finalState = await getSession(session_id);
console.log(JSON.stringify(finalState, null, 2));
