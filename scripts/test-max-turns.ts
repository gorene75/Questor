// Deterministic proof that the max_turns termination backstop fires and
// records ending_trigger correctly. Adversarial scripted model that never
// takes an exit, never fires a discoverable, never triggers anything —
// exactly the "player circles a scene indefinitely" case max_turns exists
// to catch.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { createDbClientFromEnv, createSession, commitTurn, loadSession, upsertQuest, type DbClient } from "../src/db.ts";
import { validateQuest, type Quest } from "../src/validator.ts";
import { processTurn } from "../src/turn.ts";
import type { ModelAdapter } from "../src/models/index.ts";

function idleModel(name: string): ModelAdapter {
  return {
    name,
    async complete(_system: string, _user: string) {
      return {
        text: JSON.stringify({
          narration: "Nothing in particular happens.",
          exit_id: null,
          guarded_event_id: null,
          discovered: [],
          disposition_changes: [],
          invented: [],
          refused: false,
        }),
      };
    },
  };
}

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, evidence: string) {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  console.log(`  ${evidence}`);
  if (ok) pass++;
  else fail++;
}

const quest = JSON.parse(readFileSync("quests/speckled-band.json", "utf-8")) as Quest;
const { errors } = validateQuest(quest);
if (errors.length > 0) {
  console.error("Quest has validation errors, aborting:", errors);
  process.exit(1);
}

const client = createDbClientFromEnv();
await upsertQuest(client, quest);

// Force the session to scene_turn_count=25 (one below the default cap) in
// s3_commons — deliberately not s1_baker_street, which has its own beat at
// at_turn=9 that would fire first at this turn count (correctly — beats are
// checked before max_turns) and mask what this test is actually after.
// s3_commons has no beats or on_fail to interfere.
const session = await createSession(client, "speckled-band");
await commitTurn(client, session.id, {
  current_scene: "s3_commons",
  phase: session.phase,
  story_time: session.story_time,
  flags: session.flags,
  characters: session.characters,
  invented: session.invented,
  transcript: session.transcript,
  scene_turn_count: 25,
  fired_beats: session.fired_beats,
  active_degradations: session.active_degradations,
  idle_turns: session.idle_turns,
  progress_events: session.progress_events,
});

const model = idleModel("adversarial:idle-forever");
const result = await processTurn({ client, model, sessionId: session.id, playerInput: "I look around some more." });
const after = await loadSession(client, session.id);

const expectedEndingId = quest.universal_endings![0]!.id;

const ok =
  result.status === "lost" &&
  result.ending?.id === expectedEndingId &&
  result.ending?.trigger === "max_turns_exceeded" &&
  after!.ending_id === expectedEndingId &&
  after!.ending_trigger === "max_turns_exceeded";

report(
  "max_turns exceeded (26 > default 25) forces the first universal_ending, with ending_trigger='max_turns_exceeded'",
  ok,
  `status=${result.status} ending_id=${result.ending?.id} ending_trigger=${result.ending?.trigger} ` +
    `session.ending_id=${after!.ending_id} session.ending_trigger=${after!.ending_trigger}`
);

// ---- Control: an ending reached through ordinary play gets no trigger ----

{
  const controlSession = await createSession(client, "speckled-band");
  await commitTurn(client, controlSession.id, {
    current_scene: "s7_watch",
    phase: "night",
    story_time: "1883-04-06T21:00:00",
    flags: { ...controlSession.flags, saw_dummy_bellpull: true, saw_clamped_bed: true, saw_ventilator: true, saw_lash: true },
    characters: controlSession.characters,
    invented: controlSession.invented,
    transcript: controlSession.transcript,
    scene_turn_count: 0,
    fired_beats: controlSession.fired_beats,
    active_degradations: controlSession.active_degradations,
    idle_turns: controlSession.idle_turns,
    progress_events: controlSession.progress_events,
  });

  const strikeModel: ModelAdapter = {
    name: "control:legitimate-win",
    async complete() {
      return {
        text: JSON.stringify({
          narration: "You strike true in the dark.",
          exit_id: "strike_true",
          guarded_event_id: null,
          discovered: [],
          disposition_changes: [],
          invented: [],
          refused: false,
        }),
      };
    },
  };

  const controlResult = await processTurn({ client, model: strikeModel, sessionId: controlSession.id, playerInput: "I strike the ventilator." });
  const controlAfter = await loadSession(client, controlSession.id);

  const controlOk = controlResult.ending?.id === "e_win" && controlResult.ending?.trigger === undefined && controlAfter!.ending_trigger === null;
  report(
    "an ending reached through ordinary play (e_win via a real exit) gets no ending_trigger",
    controlOk,
    `ending_id=${controlResult.ending?.id} ending_trigger=${controlResult.ending?.trigger} session.ending_trigger=${controlAfter!.ending_trigger}`
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
