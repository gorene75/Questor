// Fix 1's own acceptance test: the specific failure that motivated rolling
// back the minutes-based clock. A 30-turn interrogation transcript — real,
// on-topic questions, discoverables firing, disposition rising, but zero
// exits ever taken — must not advance the clock in any meaningful way and
// must never trip the deadline, because none of that is genuine plot
// progress under clock.advances_on. Then, separately, a normal playthrough
// (interview -> travel -> bedroom -> watch) must still advance phases
// correctly and reach a real ending, proving the rework didn't just make
// the clock inert everywhere.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { createDbClientFromEnv, createSession, loadSession, upsertQuest } from "../src/db.ts";
import { validateQuest, type Quest } from "../src/validator.ts";
import { processTurn } from "../src/turn.ts";
import type { ModelAdapter } from "../src/models/index.ts";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, evidence: string) {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  console.log(`  ${evidence}`);
  if (ok) pass++;
  else fail++;
}

function scriptedModel(name: string, responses: Record<string, unknown>[]): ModelAdapter {
  let i = 0;
  return {
    name,
    async complete() {
      const fields = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return {
        text: JSON.stringify({
          narration: "She answers.",
          exit_id: null,
          guarded_event_id: null,
          discovered: [],
          disposition_changes: [],
          invented: [],
          refused: false,
          ...fields,
        }),
      };
    },
  };
}

const quest = JSON.parse(readFileSync("quests/speckled-band.json", "utf-8")) as Quest;
const { errors } = validateQuest(quest);
if (errors.length > 0) {
  console.error("Quest has validation errors, aborting:", errors);
  process.exit(1);
}

const client = createDbClientFromEnv();
await upsertQuest(client, quest);

// ---- Part 1: 30-turn interrogation, zero exits, real questions throughout ----
// s1_baker_street also has its own beat (Roylott bursting in at_turn: 9) —
// a deliberate, unrelated authorial choice about how long the interview can
// run before he arrives, not something Fix 1 touches. A raw 30-turn
// interrogation would hit that beat regardless of how the clock behaves, so
// this test uses a clone with that beat pushed out of range, isolating the
// thing actually under test: does thoroughness move clock.advances_on's
// progress counter, or not.

{
  const noBeatQuest = structuredClone(quest);
  const s1NoBeat = noBeatQuest.scenes.find((s) => s.id === "s1_baker_street")!;
  s1NoBeat.beats = [{ ...s1NoBeat.beats![0]!, at_turn: 999 }];
  // max_turns (default 25, a separate, unrelated termination backstop) would
  // also cut a genuine 30-turn transcript short — raised here for the same
  // isolation reason as the beat above.
  s1NoBeat.max_turns = 100;
  noBeatQuest.meta.id = "speckled-band-test-no-beat-interrogation";
  const { errors: cloneErrors } = validateQuest(noBeatQuest);
  if (cloneErrors.length > 0) {
    console.error("Synthetic no-beat quest has validation errors, aborting:", cloneErrors);
    process.exit(1);
  }
  await upsertQuest(client, noBeatQuest);

  const session = await createSession(client, noBeatQuest.meta.id);

  // Turns 1-3: raise Helen guarded -> opening -> trusting (one step per turn,
  // clamped by the engine regardless of how it's reported), unlocking the
  // rest of s1's discoverables. This is normal, earned interview progress,
  // not stalling.
  const raiseHelen = scriptedModel("interrogation:build-rapport", [
    { discovered: ["the_death"], disposition_changes: [{ character: "helen", direction: "up", reason: "gave her time" }] },
    { disposition_changes: [{ character: "helen", direction: "up", reason: "took the bruises seriously" }] },
    { disposition_changes: [{ character: "helen", direction: "up", reason: "asked a concrete question" }] },
  ]);
  await processTurn({ client, model: raiseHelen, sessionId: session.id, playerInput: "How did your sister die?" });
  await processTurn({ client, model: raiseHelen, sessionId: session.id, playerInput: "I notice your hand." });
  await processTurn({ client, model: raiseHelen, sessionId: session.id, playerInput: "Tell me about that night." });

  // Turns 4-30: cycle through every remaining s1 discoverable, then keep
  // re-asking already-answered questions for the rest of the 30 — none of
  // discovered ids beyond the_death are in clock.advances_on, and
  // the_death itself is already counted, so every one of these turns
  // should be progress-neutral even though every one of them is a genuine,
  // on-topic question with a real discoverable firing.
  const topics = ["the_death", "dying_words", "the_whistle", "the_move", "the_bruises", "tonight"];
  for (let turn = 4; turn <= 30; turn++) {
    const topic = topics[(turn - 4) % topics.length]!;
    const model = scriptedModel(`interrogation:turn-${turn}`, [{ discovered: [topic] }]);
    await processTurn({ client, model, sessionId: session.id, playerInput: `Tell me more about ${topic.replace(/_/g, " ")}.` });
  }

  const after = await loadSession(client, session.id);
  const ok =
    after!.status === "active" &&
    after!.current_scene === "s1_baker_street" &&
    after!.progress_events.length === 1 &&
    after!.progress_events[0] === "the_death" &&
    after!.phase === "afternoon" &&
    after!.transcript.length === 30;
  report(
    "30-turn interrogation transcript, zero exits taken: progress stays at 1 (just the_death), phase stays 'afternoon', no deadline, still active",
    ok,
    `status=${after!.status} scene=${after!.current_scene} progress_events=${JSON.stringify(after!.progress_events)} phase=${after!.phase} turns_played=${after!.transcript.length}`
  );
}

// ---- Part 2: a normal playthrough still advances phases and reaches an ending ----

{
  const session = await createSession(client, "speckled-band");
  const phasesSeen: string[] = [session.phase];

  async function turn(playerInput: string, fields: Record<string, unknown>) {
    const model = scriptedModel("normal-playthrough", [fields]);
    const result = await processTurn({ client, model, sessionId: session.id, playerInput });
    phasesSeen.push(result.session.phase);
    return result;
  }

  await turn("How did your sister die?", { discovered: ["the_death"] }); // progress 1, afternoon
  await turn("I'll go to Stoke Moran.", { exit_id: "to_surrey" }); // progress 2, afternoon
  await turn("Show me the bedroom.", { exit_id: "to_bedroom" }); // s4 -> s5, no progress
  await turn("The bell-pull.", { discovered: ["bellpull"] }); // progress 3, afternoon
  await turn("The bed.", { discovered: ["the_bed"] }); // progress 4, dusk
  await turn("The ventilator.", { discovered: ["ventilator"] }); // progress 5, dusk
  await turn("Show me his room.", { exit_id: "to_roylott_room" }); // s5 -> s6, no progress
  await turn("The safe.", { discovered: ["safe"] }); // progress 6, dusk
  await turn("Back to the bedroom.", { exit_id: "back_to_bedroom" }); // s6 -> s5, no progress
  const watchResult = await turn("I'll keep watch here tonight.", { exit_id: "to_watch" }); // progress 7, dusk -> s7

  const strikeModel = scriptedModel("normal-playthrough:strike", [
    { narration: "You strike true in the dark.", exit_id: "strike_true" },
  ]);
  const winResult = await processTurn({ client, model: strikeModel, sessionId: session.id, playerInput: "I strike the ventilator." });

  const dawnAppeared = phasesSeen.includes("dusk");
  const ok =
    watchResult.session.current_scene === "s7_watch" &&
    dawnAppeared &&
    watchResult.session.progress_events.length === 7 &&
    winResult.status === "won" &&
    winResult.ending?.id === "e_win";
  report(
    "normal playthrough (interview -> travel -> bedroom -> watch) advances phase to dusk and reaches e_win",
    ok,
    `phases_seen=${JSON.stringify(phasesSeen)} scene_at_watch=${watchResult.session.current_scene} progress_at_watch=${watchResult.session.progress_events.length} final_status=${winResult.status} ending=${winResult.ending?.id}`
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
