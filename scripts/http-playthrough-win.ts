// Same idea as http-playthrough.ts, but deliberately routed to avoid the
// s6_roylotts_room#7 "caught searching" beat and grind out the 10
// consecutive turns_in_scene needed to reach dusk, then strike promptly
// in the watch scene. One-off harness, not part of the permanent suite.

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

const script: [string, string][] = [
  ["Tell me about the night your sister died.", "learn the account"],
  ["I'll set off for Stoke Moran now.", "travel to Surrey"],
  ["Let's go in and see the bedroom.", "enter bedroom"],
  ["I examine the bell-pull by the pillow.", "examine bell-pull"],
  ["I examine the bed.", "examine bed"],
  ["I examine the ventilator above the bed.", "examine ventilator"],
  ["Can I see Dr Roylott's room?", "enter Roylott's room"],
  ["I examine the dog lash hanging on the bedstead.", "examine lash (only clue we take here)"],
  ["I leave this room now and go back to the bedroom.", "leave before turn 7 in Roylott's room"],
  // 10 consecutive non-triggering turns in s5_bedroom to hit turns_in_scene:10 -> dusk.
  ["I sit quietly and think over what we've learned.", "filler 1"],
  ["I glance at Watson.", "filler 2"],
  ["I check my pocket watch.", "filler 3"],
  ["I listen to the house settling.", "filler 4"],
  ["I look out at the darkening sky.", "filler 5"],
  ["I go over the facts again in my head.", "filler 6"],
  ["I wait, saying nothing for a moment.", "filler 7"],
  ["I ask Watson if he's noticed anything else.", "filler 8"],
  ["I stretch and pace a little.", "filler 9"],
  ["I settle back and wait for evening.", "filler 10 (expect dusk after this)"],
  ["I'll keep watch here tonight.", "begin the watch"],
  ["I strike hard at the ventilator with my cane, right now, in the dark!", "strike"],
];

const { session_id, narration } = await createSession();
console.log(`Session: ${session_id}`);
console.log(`Opens with: ${narration}\n`);

for (const [input, label] of script) {
  const result = await takeTurn(session_id, input);
  console.log(`[${label}] > ${input}`);
  console.log(`  <- ${result.narration}${result.refused ? "  [refused: true]" : ""}`);

  const state = await getSession(session_id);
  console.log(
    `  state: scene=${state.current_scene} phase=${state.phase} scene_turn_count=${state.scene_turn_count} helen=${state.characters.helen ?? "?"}`
  );

  if (result.status !== "active") {
    console.log(
      `\n*** Session ended: status=${result.status}` +
        (result.ending ? ` ending=${result.ending.id} ("${result.ending.title}")` : "") +
        " ***"
    );
    console.log(`Direction: ${result.ending?.direction ?? "(none)"}`);
    break;
  }

  // Safety net: if we're still in Roylott's room after asking to leave, the
  // model missed the exit — retry immediately, since turn 7 there ends the
  // game via roylott_suspects/on_fail.
  if (label.includes("leave before turn 7") && state.current_scene === "s6_roylotts_room") {
    console.log("  (exit not taken — retrying with more explicit phrasing)");
    const retry = await takeTurn(session_id, "I walk out of this room, back into the bedroom next door.");
    console.log(`  <- ${retry.narration}${retry.refused ? "  [refused: true]" : ""}`);
    const retryState = await getSession(session_id);
    console.log(`  state: scene=${retryState.current_scene} phase=${retryState.phase} scene_turn_count=${retryState.scene_turn_count}`);
    if (retry.status !== "active") {
      console.log(`\n*** Session ended: status=${retry.status}` + (retry.ending ? ` ending=${retry.ending.id}` : "") + " ***");
      break;
    }
  }
}

console.log("\n--- final session state ---");
console.log(JSON.stringify(await getSession(session_id), null, 2));
