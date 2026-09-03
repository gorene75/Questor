// Fix 3's acceptance test: play into act 2 of a synthetic two-act quest,
// reach a loss ending, call rewindToCheckpoint, and confirm session state
// exactly matches what it was at act 2's entry — not approximately, not
// "the important fields," every field a later turn or the model's next
// prompt could read. Then confirm a fresh turn from there is coherent and
// carries no trace of the failed attempt.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { createDbClientFromEnv, createSession, loadSession, upsertQuest, listTurnLogs } from "../src/db.ts";
import { validateQuest, type Quest } from "../src/validator.ts";
import { processTurn, rewindToCheckpoint } from "../src/turn.ts";
import type { ModelAdapter } from "../src/models/index.ts";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, evidence: string) {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  console.log(`  ${evidence}`);
  if (ok) pass++;
  else fail++;
}

function modelReturning(name: string, fields: Record<string, unknown>): ModelAdapter {
  return {
    name,
    async complete() {
      return {
        text: JSON.stringify({
          narration: "Something happens.",
          exit_id: null,
          guarded_event_id: null,
          discovered: [],
          disposition_changes: [],
          invented: [],
          refused: false,
          narration_implies_departure: false,
          ...fields,
        }),
      };
    },
  };
}

const baseQuest = JSON.parse(readFileSync("quests/speckled-band.json", "utf-8")) as Quest;

// ---- build the synthetic two-act quest ----
const quest = structuredClone(baseQuest);
quest.meta.id = "speckled-band-test-two-act";
const act1Scenes = ["s1_baker_street", "s2_intrusion", "s3_commons"];
const act2Scenes = ["s4_exterior", "s5_bedroom", "s6_roylotts_room", "s7_watch"];
for (const scene of quest.scenes) {
  if (act1Scenes.includes(scene.id)) scene.act = "act1";
  else if (act2Scenes.includes(scene.id)) scene.act = "act2";
}
const { errors } = validateQuest(quest);
if (errors.length > 0) {
  console.error("Synthetic two-act quest has validation errors, aborting:", errors);
  process.exit(1);
}

const client = createDbClientFromEnv();
await upsertQuest(client, quest);

const session = await createSession(client, quest.meta.id);

// Turn 1: hear the account (act1, no transition yet)
await processTurn({
  client,
  model: modelReturning("playthrough:hear-account", { discovered: ["the_death"] }),
  sessionId: session.id,
  playerInput: "How did your sister die?",
});

// Turn 2: travel to Stoke Moran — s1 (act1) -> s4_exterior (act2). This is
// the act transition: a checkpoint should be written here, at s4_exterior's
// entry, and nowhere else for the rest of this test.
await processTurn({
  client,
  model: modelReturning("playthrough:travel", { exit_id: "to_surrey" }),
  sessionId: session.id,
  playerInput: "I'll go to Stoke Moran.",
});

const atCheckpoint = await loadSession(client, session.id);
const checkpointOk =
  atCheckpoint!.current_scene === "s4_exterior" &&
  atCheckpoint!.checkpoint !== null &&
  atCheckpoint!.checkpoint!.scene === "s4_exterior" &&
  JSON.stringify(atCheckpoint!.checkpoint!.flags) === JSON.stringify(atCheckpoint!.flags) &&
  JSON.stringify(atCheckpoint!.checkpoint!.transcript) === JSON.stringify(atCheckpoint!.transcript);
report(
  "entering s4_exterior (act2, differing from act1) writes a checkpoint matching session state at that exact moment",
  checkpointOk,
  `scene=${atCheckpoint!.current_scene} checkpoint_scene=${atCheckpoint!.checkpoint?.scene} checkpoint_flags_match_session=${JSON.stringify(atCheckpoint!.checkpoint!.flags) === JSON.stringify(atCheckpoint!.flags)}`
);

// Record the exact expected post-rewind state now, before going any further.
const expected = {
  current_scene: atCheckpoint!.current_scene,
  phase: atCheckpoint!.phase,
  progress_events: atCheckpoint!.progress_events,
  story_time: atCheckpoint!.story_time,
  flags: atCheckpoint!.flags,
  characters: atCheckpoint!.characters,
  invented: atCheckpoint!.invented,
  transcript: atCheckpoint!.transcript,
  scene_turn_count: atCheckpoint!.scene_turn_count,
  fired_beats: atCheckpoint!.fired_beats,
  active_degradations: atCheckpoint!.active_degradations,
  idle_turns: atCheckpoint!.idle_turns,
};

// Turns 3-6: go deep into act 2 — bedroom, examine clues, commit to the
// watch — well past the checkpoint, exactly as the user described ("play
// into act 2", not "immediately at its threshold").
await processTurn({
  client,
  model: modelReturning("playthrough:to-bedroom", { exit_id: "to_bedroom" }),
  sessionId: session.id,
  playerInput: "Show me the bedroom.",
});
await processTurn({
  client,
  model: modelReturning("playthrough:bellpull", { discovered: ["bellpull"] }),
  sessionId: session.id,
  playerInput: "The bell-pull.",
});
await processTurn({
  client,
  model: modelReturning("playthrough:bed", { discovered: ["the_bed"] }),
  sessionId: session.id,
  playerInput: "The bed.",
});
await processTurn({
  client,
  model: modelReturning("playthrough:ventilator", { discovered: ["ventilator"] }),
  sessionId: session.id,
  playerInput: "The ventilator.",
});
const atWatch = await processTurn({
  client,
  model: modelReturning("playthrough:to-watch", { exit_id: "to_watch" }),
  sessionId: session.id,
  playerInput: "I'll keep watch here tonight.",
});
const stillAct2 = atWatch.session.current_scene === "s7_watch" && atWatch.session.checkpoint?.scene === "s4_exterior";
report(
  "s7_watch is also act2 — no new checkpoint overwrite; still points at act2's actual entry (s4_exterior)",
  stillAct2,
  `scene=${atWatch.session.current_scene} checkpoint_scene=${atWatch.session.checkpoint?.scene}`
);

// The loss: light the lamp during the watch.
const lossResult = await processTurn({
  client,
  model: modelReturning("playthrough:fatal-mistake", { narration: "You light the lamp.", exit_id: "light_lamp" }),
  sessionId: session.id,
  playerInput: "I light the lamp to see better.",
});
const lostOk = lossResult.status === "lost" && lossResult.ending?.id === "e_too_late";
report("reaches a real loss ending (e_too_late) well into act 2", lostOk, `status=${lossResult.status} ending=${lossResult.ending?.id}`);

// ---- rewind ----
const rewound = await rewindToCheckpoint(client, session.id);

const exactMatch =
  rewound.current_scene === expected.current_scene &&
  rewound.phase === expected.phase &&
  JSON.stringify(rewound.progress_events) === JSON.stringify(expected.progress_events) &&
  rewound.story_time === expected.story_time &&
  JSON.stringify(rewound.flags) === JSON.stringify(expected.flags) &&
  JSON.stringify(rewound.characters) === JSON.stringify(expected.characters) &&
  JSON.stringify(rewound.invented) === JSON.stringify(expected.invented) &&
  JSON.stringify(rewound.transcript) === JSON.stringify(expected.transcript) &&
  rewound.scene_turn_count === expected.scene_turn_count &&
  JSON.stringify(rewound.fired_beats) === JSON.stringify(expected.fired_beats) &&
  JSON.stringify(rewound.active_degradations) === JSON.stringify(expected.active_degradations) &&
  rewound.idle_turns === expected.idle_turns &&
  rewound.status === "active" &&
  rewound.ending_id === null &&
  rewound.ending_trigger === null;

report(
  "rewindToCheckpoint restores session state to exactly what it was at act 2's entry, field for field",
  exactMatch,
  `scene=${rewound.current_scene} (expected ${expected.current_scene}) transcript_len=${rewound.transcript.length} (expected ${expected.transcript.length}) ` +
    `status=${rewound.status} ending_id=${rewound.ending_id} progress_events=${JSON.stringify(rewound.progress_events)} (expected ${JSON.stringify(expected.progress_events)})`
);

// ---- a fresh turn from the rewound state is coherent and carries no trace of the failed attempt ----
const freshResult = await processTurn({
  client,
  model: modelReturning("post-rewind:examine-wall", { discovered: ["the_wall"] }),
  sessionId: session.id,
  playerInput: "Let me look at that wall again.",
});
const logs = await listTurnLogs(client, session.id);
const freshTurnLog = logs.filter((r) => r.turn_index === expected.transcript.length).pop()!;
const promptSentForFreshTurn = freshTurnLog.prompt;

// Check for the exact player inputs from the failed attempt's own turns —
// not looser substrings like "bell-pull", which also appears in
// canon.secrets and is shown in every prompt regardless of what's actually
// been explored, unrelated to rewind at all.
const noTraceOfFailedAttempt =
  !promptSentForFreshTurn.includes("I'll keep watch here tonight.") &&
  !promptSentForFreshTurn.includes("I light the lamp to see better.") &&
  !promptSentForFreshTurn.includes("You light the lamp.") &&
  !promptSentForFreshTurn.includes("The ventilator.");

const freshTurnCoherent =
  freshResult.session.transcript.length === expected.transcript.length + 1 &&
  freshResult.session.current_scene === "s4_exterior" &&
  freshResult.session.flags.saw_sham_repairs === true;

report(
  "a fresh turn after rewind produces coherent narration and its prompt carries no reference to anything from the failed act-2 attempt",
  noTraceOfFailedAttempt && freshTurnCoherent,
  `transcript_len=${freshResult.session.transcript.length} (expected ${expected.transcript.length + 1}) scene=${freshResult.session.current_scene} ` +
    `prompt_mentions_watch_or_lamp_or_bellpull=${!noTraceOfFailedAttempt}`
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
