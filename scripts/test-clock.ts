// Deterministic proof of the event-driven clock (Fix 1): phases and any
// deadline are derived purely from clock.advances_on events — an exit
// taken, a discoverable found, a beat fired — never from elapsed turns or
// idle conversation. Replaces the old minutes-based clock's test suite
// entirely; that mechanism no longer exists.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { createDbClientFromEnv, createSession, commitTurn, loadSession, upsertQuest, type DbClient } from "../src/db.ts";
import { validateQuest, type Quest } from "../src/validator.ts";
import { processTurn } from "../src/turn.ts";
import { derivePhaseFromProgress } from "../src/clock.ts";
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

// ---- derivePhaseFromProgress: pure unit test, no DB ----
// quest phases: morning until 1, afternoon until 4, dusk until 10, night until 999
{
  const cases: [number, string][] = [
    [0, "morning"],
    [1, "afternoon"],
    [3, "afternoon"],
    [4, "dusk"],
    [9, "dusk"],
    [10, "night"],
    [500, "night"], // beyond every threshold falls into the last-declared phase
  ];
  let allOk = true;
  const details: string[] = [];
  for (const [progress, expected] of cases) {
    const got = derivePhaseFromProgress(quest.clock.phases, progress);
    const ok = got === expected;
    if (!ok) allOk = false;
    details.push(`${progress}->${got}${ok ? "" : `(expected ${expected})`}`);
  }
  report("derivePhaseFromProgress: correct at every threshold, including well beyond the last one", allOk, details.join(" "));
}

// ---- an advances_on-listed exit increments progress by exactly 1 ----
{
  const session = await createSession(client, "speckled-band");
  const model = modelReturning("adversarial:take-commons", { exit_id: "to_commons" });
  const result = await processTurn({ client, model, sessionId: session.id, playerInput: "I'll look into the will." });
  const ok = result.session.progress_events.length === 1 && result.session.progress_events.includes("to_commons");
  report(
    "taking exit 'to_commons' (in advances_on) advances progress by 1",
    ok,
    `progress_events=${JSON.stringify(result.session.progress_events)}`
  );
}

// ---- a discoverable NOT in advances_on never advances progress ----
{
  const session = await createSession(client, "speckled-band");
  // 'the_move' is a real s1 discoverable but deliberately not in advances_on
  // — asking about it is genuine, on-topic interrogation, not idling, and it
  // still must not move the clock. This is the core of Fix 1: thoroughness
  // that isn't plot progress costs nothing.
  const model = modelReturning("adversarial:ask-off-clock-question", { discovered: ["the_move"] });
  const result = await processTurn({ client, model, sessionId: session.id, playerInput: "Why did you change rooms?" });
  const ok = result.session.progress_events.length === 0 && result.session.phase === "morning";
  report(
    "a real, on-topic discoverable that isn't in advances_on never advances progress or phase",
    ok,
    `progress_events=${JSON.stringify(result.session.progress_events)} phase=${result.session.phase}`
  );
}

// ---- re-reporting an already-counted event doesn't double-advance ----
{
  const session = await createSession(client, "speckled-band");
  const model = modelReturning("adversarial:report-the-death-twice", { discovered: ["the_death"] });
  await processTurn({ client, model, sessionId: session.id, playerInput: "How did your sister die?" });
  const result = await processTurn({ client, model, sessionId: session.id, playerInput: "Tell me again, how did she die?" });
  const ok = result.session.progress_events.length === 1 && result.session.progress_events[0] === "the_death";
  report(
    "reporting the same advances_on discoverable twice across turns counts it once",
    ok,
    `progress_events=${JSON.stringify(result.session.progress_events)}`
  );
}

// ---- a beat with a declared id advances progress when it fires (synthetic — no real beat declares one) ----
{
  const synthetic = structuredClone(quest);
  synthetic.meta.id = "speckled-band-test-beat-progress";
  const s3 = synthetic.scenes.find((s) => s.id === "s3_commons")!;
  s3.beats = [{ at_turn: 1, event: "test beat", id: "test_progress_beat", once: true }];
  synthetic.clock.advances_on.push("test_progress_beat");
  const { errors: cloneErrors } = validateQuest(synthetic);
  if (cloneErrors.length > 0) {
    console.error("Synthetic beat-progress quest has validation errors, aborting:", cloneErrors);
    process.exit(1);
  }
  await upsertQuest(client, synthetic);

  const session = await createSession(client, synthetic.meta.id);
  await commitTurn(client, session.id, {
    current_scene: "s3_commons",
    phase: session.phase,
    progress_events: session.progress_events,
    story_time: session.story_time,
    flags: session.flags,
    characters: session.characters,
    invented: session.invented,
    transcript: session.transcript,
    scene_turn_count: 1, // at the beat's own at_turn already, so it fires on the very next turn
    fired_beats: session.fired_beats,
    active_degradations: session.active_degradations,
    idle_turns: 0,
  });
  const model = modelReturning("adversarial:idle-to-trigger-beat", {});
  const result = await processTurn({ client, model, sessionId: session.id, playerInput: "I wait." });
  const ok = result.session.progress_events.includes("test_progress_beat");
  report(
    "a beat declaring an id in advances_on advances progress when it fires, even with no exit or discoverable involved",
    ok,
    `progress_events=${JSON.stringify(result.session.progress_events)}`
  );
}

// ---- deadline fires once progress reaches clock.deadline.at ----
{
  const session = await createSession(client, "speckled-band");
  // Fast-forward progress to one below the real deadline, all via ids
  // actually declared in advances_on (excluding "lash", saved for the final
  // triggering turn below), with current_scene set to where "lash" actually
  // lives so that final discoverable validates normally.
  const priorEvents = quest.clock.advances_on.filter((id) => id !== "lash").slice(0, quest.clock.deadline!.at - 1);
  await commitTurn(client, session.id, {
    current_scene: "s6_roylotts_room",
    phase: session.phase,
    progress_events: priorEvents,
    story_time: session.story_time,
    flags: session.flags,
    characters: session.characters,
    invented: session.invented,
    transcript: session.transcript,
    scene_turn_count: 0,
    fired_beats: session.fired_beats,
    active_degradations: session.active_degradations,
    idle_turns: 0,
  });
  const model = modelReturning("adversarial:cross-the-deadline", { discovered: ["lash"] });
  const result = await processTurn({ client, model, sessionId: session.id, playerInput: "One more thing." });

  const ok = result.status === "lost" && result.ending?.id === "e_too_late" && result.ending?.trigger === "deadline_reached";
  report(
    `clock.deadline (at=${quest.clock.deadline!.at}) fires once progress reaches it, forcing the authored ending`,
    ok,
    `status=${result.status} ending_id=${result.ending?.id} ending_trigger=${result.ending?.trigger} progress_events=${JSON.stringify(result.session.progress_events)}`
  );
}

// ---- Fix 2: a quest with no clock.deadline declared has no time-based ending, ever ----
{
  const noDeadlineQuest = structuredClone(quest);
  delete noDeadlineQuest.clock.deadline;
  noDeadlineQuest.meta.id = "speckled-band-test-no-deadline";
  const { errors: cloneErrors } = validateQuest(noDeadlineQuest);
  const validatesClean = cloneErrors.length === 0;
  const noDeadlineErrorEvenIfDirty = !cloneErrors.some((e) => e.toLowerCase().includes("deadline"));
  report(
    "clock.deadline omitted entirely: quest still validates with 0 errors — nothing demands one be declared",
    validatesClean && noDeadlineErrorEvenIfDirty,
    `errors=${JSON.stringify(cloneErrors)}`
  );

  await upsertQuest(client, noDeadlineQuest);
  const session = await createSession(client, noDeadlineQuest.meta.id);
  // Fast-forward progress well past where the real quest's deadline (11)
  // would have fired — every id in advances_on, all of it — and confirm
  // nothing forces an ending. Only the ordinary win path should ever end
  // this session.
  await commitTurn(client, session.id, {
    current_scene: "s7_watch",
    phase: session.phase,
    progress_events: [...noDeadlineQuest.clock.advances_on],
    story_time: session.story_time,
    flags: { ...session.flags, saw_dummy_bellpull: true, saw_clamped_bed: true, saw_ventilator: true, saw_lash: true },
    characters: session.characters,
    invented: session.invented,
    transcript: session.transcript,
    scene_turn_count: 0,
    fired_beats: session.fired_beats,
    active_degradations: session.active_degradations,
    idle_turns: 0,
  });
  const idleModel = modelReturning("adversarial:idle-past-old-deadline-threshold", {});
  const idleResult = await processTurn({ client, model: idleModel, sessionId: session.id, playerInput: "I wait." });
  const neverForcedByDeadline = idleResult.status === "active" && idleResult.ending === undefined;

  const strikeModel = modelReturning("control:still-winnable", { narration: "You strike true in the dark.", exit_id: "strike_true" });
  const winResult = await processTurn({ client, model: strikeModel, sessionId: session.id, playerInput: "I strike the ventilator." });
  const winsNormally = winResult.status === "won" && winResult.ending?.id === "e_win" && winResult.ending?.trigger === undefined;

  report(
    "with no deadline declared, progress far beyond the real quest's old threshold never forces an ending — only reaching e_win through ordinary play ends the session",
    neverForcedByDeadline && winsNormally,
    `idle_turn: status=${idleResult.status} ending=${idleResult.ending?.id ?? "(none)"} | win_turn: status=${winResult.status} ending=${winResult.ending?.id} trigger=${winResult.ending?.trigger}`
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
