// Deterministic acceptance checks for BUILD.md tests 1, 3, 4, 6, 7, 8.
// These use a scripted fake model that deliberately tries to cheat, to prove
// the ENGINE rejects/clamps the behavior — not that a particular live model
// happened to comply. One-off harness, not part of the permanent suite.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { createDbClientFromEnv, createSession, commitTurn, loadSession, upsertQuest, type DbClient } from "../src/db.ts";
import { validateQuest, type Quest } from "../src/validator.ts";
import { processTurn } from "../src/turn.ts";
import type { ModelAdapter } from "../src/models/index.ts";

function scriptedModel(name: string, responses: string[]): ModelAdapter {
  let i = 0;
  return {
    name,
    async complete(_system: string, _user: string) {
      const text = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return { text };
    },
  };
}

let pass = 0;
let fail = 0;
function report(testId: string, description: string, ok: boolean, evidence: string) {
  console.log(`[${ok ? "PASS" : "FAIL"}] Test ${testId}: ${description}`);
  console.log(`  ${evidence}`);
  if (ok) pass++;
  else fail++;
}

// ---- Test 1: validator catches a deliberately broken quest ----

function testValidator(baseQuest: Quest) {
  const undeclaredFlag = structuredClone(baseQuest);
  undeclaredFlag.scenes[0]!.exits.push({
    id: "test_undeclared_flag_exit",
    when: "test",
    requires: "totally_undeclared_flag",
    to: "s2_intrusion",
  });
  const r1 = validateQuest(undeclaredFlag);
  const found1 = r1.errors.some((e) => e.includes("totally_undeclared_flag") && e.includes("not declared"));
  report(
    "1a",
    "validator catches an undeclared flag reference",
    found1,
    `errors: ${JSON.stringify(r1.errors.filter((e) => e.includes("totally_undeclared_flag")))}`
  );

  const danglingExit = structuredClone(baseQuest);
  danglingExit.scenes[2]!.exits[0]!.to = "s99_does_not_exist";
  const r2 = validateQuest(danglingExit);
  const found2 = r2.errors.some((e) => e.includes("s99_does_not_exist") && e.includes("does not point to an existing"));
  report(
    "1b",
    "validator catches a dangling exit target",
    found2,
    `errors: ${JSON.stringify(r2.errors.filter((e) => e.includes("s99_does_not_exist")))}`
  );

  const noWinPath = structuredClone(baseQuest);
  const watch = noWinPath.scenes.find((s) => s.id === "s7_watch")!;
  watch.exits = watch.exits.filter((e) => e.id !== "strike_true");
  const r3 = validateQuest(noWinPath);
  const found3 = r3.errors.some((e) => e.includes("No path from start_scene to any win ending"));
  report(
    "1c",
    "validator catches an unreachable win path",
    found3,
    `errors: ${JSON.stringify(r3.errors.filter((e) => e.includes("win ending")))}`
  );

  // ---- stage 6: clock.deadline.on_reached modes, degradations ----

  const endingModeNoEnding = structuredClone(baseQuest);
  delete endingModeNoEnding.clock.deadline!.on_reached.ending;
  endingModeNoEnding.clock.deadline!.on_reached.mode = "ending";
  const r4 = validateQuest(endingModeNoEnding);
  const found4 = r4.errors.some((e) => e.includes("mode is 'ending' but no 'ending' field is given"));
  report(
    "1d",
    "validator catches deadline.on_reached.mode 'ending' with no 'ending' field",
    found4,
    `errors: ${JSON.stringify(r4.errors.filter((e) => e.includes("on_reached")))}`
  );

  const degradeModeUndeclared = structuredClone(baseQuest);
  degradeModeUndeclared.clock.deadline!.on_reached = { mode: "degrade", degrade: "totally_undeclared_degradation" };
  const r5 = validateQuest(degradeModeUndeclared);
  const found5 = r5.errors.some(
    (e) => e.includes("totally_undeclared_degradation") && e.includes("does not name a declared degradation")
  );
  report(
    "1e",
    "validator catches clock.deadline.on_reached.degrade naming an undeclared degradation",
    found5,
    `errors: ${JSON.stringify(r5.errors.filter((e) => e.includes("totally_undeclared_degradation")))}`
  );

  const notWinnableNoEnding = structuredClone(baseQuest);
  notWinnableNoEnding.degradations!.no_account!.still_winnable = false;
  delete notWinnableNoEnding.degradations!.no_account!.ending;
  const r6 = validateQuest(notWinnableNoEnding);
  const found6 = r6.errors.some((e) => e.includes("no_account") && e.includes("still_winnable: false but names no ending"));
  report(
    "1f",
    "validator catches a still_winnable:false degradation that names no ending",
    found6,
    `errors: ${JSON.stringify(r6.errors.filter((e) => e.includes("no_account")))}`
  );

  const undeclaredOnAllowedDegrade = structuredClone(baseQuest);
  undeclaredOnAllowedDegrade.scenes[0]!.guarded_events![0]!.on_allowed = { degrade: "totally_undeclared_degradation_2" };
  const r7 = validateQuest(undeclaredOnAllowedDegrade);
  const found7 = r7.errors.some(
    (e) => e.includes("totally_undeclared_degradation_2") && e.includes("does not name a declared degradation")
  );
  report(
    "1g",
    "validator catches guarded_event.on_allowed.degrade naming an undeclared degradation",
    found7,
    `errors: ${JSON.stringify(r7.errors.filter((e) => e.includes("totally_undeclared_degradation_2")))}`
  );

  const danglingUnlock = structuredClone(baseQuest);
  danglingUnlock.degradations!.no_account!.unlocks = ["totally_nonexistent_exit"];
  const r8 = validateQuest(danglingUnlock);
  const found8 = r8.errors.some((e) => e.includes("totally_nonexistent_exit") && e.includes("does not exist in any scene"));
  report(
    "1h",
    "validator catches a degradation.unlocks entry naming an exit that doesn't exist",
    found8,
    `errors: ${JSON.stringify(r8.errors.filter((e) => e.includes("totally_nonexistent_exit")))}`
  );

  // ---- stage 7: pressure ----

  const pressureBadTarget = structuredClone(baseQuest);
  pressureBadTarget.scenes.find((s) => s.id === "s1_baker_street")!.pressure = {
    idle_after_turns: 3,
    escalation: ["a", "b", "c"],
    on_exhausted: "totally_undeclared_guarded_event",
  };
  const r9 = validateQuest(pressureBadTarget);
  const found9 = r9.errors.some(
    (e) => e.includes("totally_undeclared_guarded_event") && e.includes("does not name a guarded_events id declared on this scene")
  );
  report(
    "1i",
    "validator catches pressure.on_exhausted naming a guarded_event not declared on that scene",
    found9,
    `errors: ${JSON.stringify(r9.errors.filter((e) => e.includes("totally_undeclared_guarded_event")))}`
  );

  const busySceneNoPressure = structuredClone(baseQuest);
  const commons = busySceneNoPressure.scenes.find((s) => s.id === "s3_commons")!;
  for (let i = 0; i < 5; i++) {
    commons.discoverable.push({ id: `test_filler_discoverable_${i}`, trigger: "test", reveal: "test" });
  }
  const r10 = validateQuest(busySceneNoPressure);
  const found10 = r10.warnings.some((w) => w.includes("s3_commons") && w.includes("no pressure declared"));
  report(
    "1j",
    "validator warns when a scene has more than four discoverables and no pressure",
    found10,
    `warnings: ${JSON.stringify(r10.warnings.filter((w) => w.includes("s3_commons")))}`
  );

  // Regression test for the exact bug found live: s1's pressure originally
  // exhausted at turn 9 (idle_after_turns 3 * 3 lines), the same turn as its
  // beat — since idle turns can never outrun the scene's own turn count, the
  // beat always won the race and pressure's on_exhausted force was
  // unreachable by construction. Reproduce that shape directly.
  const pressurePreemptedByBeat = structuredClone(baseQuest);
  const s1ForCollision = pressurePreemptedByBeat.scenes.find((s) => s.id === "s1_baker_street")!;
  s1ForCollision.pressure!.idle_after_turns = 3; // 3 * 3 lines = 9, same as the beat below
  s1ForCollision.beats = [{ at_turn: 9, event: "test", goto: "s2_intrusion", once: true }];
  const r11 = validateQuest(pressurePreemptedByBeat);
  const found11 = r11.warnings.some(
    (w) => w.includes("s1_baker_street") && w.includes("pressure exhausts at turn 9") && w.includes("beat at_turn 9")
  );
  report(
    "1k",
    "validator warns when pressure's exhaustion turn lands at or after a same-scene beat's at_turn, making on_exhausted unreachable",
    found11,
    `warnings: ${JSON.stringify(r11.warnings.filter((w) => w.includes("s1_baker_street") && w.includes("pressure exhausts")))}`
  );

  // ---- Fix 3: acts ----

  const partialActAdoption = structuredClone(baseQuest);
  partialActAdoption.scenes.find((s) => s.id === "s1_baker_street")!.act = "act1";
  // every other scene deliberately left without an act
  const r12 = validateQuest(partialActAdoption);
  const otherSceneIds = partialActAdoption.scenes.filter((s) => s.id !== "s1_baker_street").map((s) => s.id);
  const allFlagged = otherSceneIds.every((id) =>
    r12.warnings.some((w) => w.includes(`Scene '${id}'`) && w.includes("has no act declared"))
  );
  report(
    "1l",
    "validator warns on every scene missing an act when at least one other scene in the quest declares one",
    allFlagged,
    `warnings: ${JSON.stringify(r12.warnings.filter((w) => w.includes("has no act declared")))}`
  );
}

// ---- Test 3: to_surrey impossible before heard_the_account ----

async function testSurreyGate(client: DbClient) {
  const session = await createSession(client, "speckled-band");
  const model = scriptedModel(
    "adversarial:surrey-too-early",
    [
      JSON.stringify({
        narration: "You set off for Stoke Moran at once.",
        exit_id: "to_surrey",
        discovered: [],
        disposition_changes: [],
        invented: [],
        refused: false,
      }),
      JSON.stringify({
        narration: "You set off for Stoke Moran at once, undeterred.",
        exit_id: "to_surrey",
        discovered: [],
        disposition_changes: [],
        invented: [],
        refused: false,
      }),
    ]
  );

  const result = await processTurn({ client, model, sessionId: session.id, playerInput: "Let's go to Surrey right now." });
  const after = await loadSession(client, session.id);

  const ok = after!.current_scene === "s1_baker_street" && after!.flags.heard_the_account === false;
  report(
    "3",
    "to_surrey is rejected before heard_the_account is set, even when the model insists twice",
    ok,
    `after turn: scene=${after!.current_scene} heard_the_account=${after!.flags.heard_the_account} status=${result.status} narration="${result.narration}"`
  );
}

// ---- Test 4: discoverables gated on Helen's disposition are rejected while guarded ----

async function testDispositionGatedDiscoverable(client: DbClient) {
  const session = await createSession(client, "speckled-band"); // helen defaults to starts_at="guarded"
  const model = scriptedModel(
    "adversarial:whistle-too-early",
    [
      JSON.stringify({
        narration: "She tells you all about the whistle in the night.",
        exit_id: null,
        discovered: ["the_whistle"],
        disposition_changes: [],
        invented: [],
        refused: false,
      }),
      JSON.stringify({
        narration: "She tells you all about the whistle in the night, again.",
        exit_id: null,
        discovered: ["the_whistle"],
        disposition_changes: [],
        invented: [],
        refused: false,
      }),
    ]
  );

  await processTurn({ client, model, sessionId: session.id, playerInput: "Tell me about the whistle." });
  const after = await loadSession(client, session.id);

  const ok = after!.flags.knows_the_whistle === false && (after!.characters.helen ?? "guarded") === "guarded";
  report(
    "4",
    "a discoverable gated on character.helen >= opening is rejected while she's still guarded",
    ok,
    `after turn: knows_the_whistle=${after!.flags.knows_the_whistle} helen=${after!.characters.helen ?? "guarded"}`
  );
}

// ---- Test 6: Roylott's disposition never rises ----

async function testRoylottNeverRises(client: DbClient) {
  const session = await createSession(client, "speckled-band");
  // Force the session into s2_intrusion, where Roylott is present, so a
  // disposition_changes entry naming him is otherwise legal.
  await commitTurn(client, session.id, {
    current_scene: "s2_intrusion",
    phase: session.phase,
    story_time: session.story_time,
    flags: session.flags,
    characters: session.characters,
    invented: session.invented,
    transcript: session.transcript,
    scene_turn_count: 0,
    fired_beats: session.fired_beats,
    active_degradations: session.active_degradations,
    idle_turns: session.idle_turns,
    progress_events: session.progress_events,
  });

  const model = scriptedModel(
    "adversarial:charm-roylott",
    [
      JSON.stringify({
        narration: "Roylott seems almost to soften at your calm reason.",
        exit_id: null,
        discovered: [],
        disposition_changes: [{ character: "roylott", direction: "up", reason: "player was reasonable and charming" }],
        invented: [],
        refused: false,
      }),
    ]
  );

  const result = await processTurn({ client, model, sessionId: session.id, playerInput: "I speak to him calmly and reasonably." });
  const after = await loadSession(client, session.id);

  const ok = (after!.characters.roylott ?? "hostile") === "hostile";
  report(
    "6",
    "Roylott's disposition is clamped at 'hostile' even when the model reports 'up'",
    ok,
    `turn accepted=${result.narration !== "The moment passes without incident."} after turn: roylott=${after!.characters.roylott ?? "hostile"}`
  );
}

// ---- Test 7: striking without all three room clues cannot reach e_win ----

async function testStrikeWithoutAllClues(client: DbClient) {
  const session = await createSession(client, "speckled-band");
  await commitTurn(client, session.id, {
    current_scene: "s7_watch",
    phase: "night",
    story_time: "1883-04-06T21:00:00",
    // Only two of the three s5 clues, and no s6 clue at all — understands_room must be false.
    flags: { ...session.flags, saw_dummy_bellpull: true, saw_clamped_bed: true },
    characters: session.characters,
    invented: session.invented,
    transcript: session.transcript,
    scene_turn_count: 0,
    fired_beats: session.fired_beats,
    active_degradations: session.active_degradations,
    idle_turns: session.idle_turns,
    progress_events: session.progress_events,
  });

  const model = scriptedModel(
    "adversarial:strike-without-clues",
    [
      JSON.stringify({
        narration: "You strike out in the dark at the ventilator.",
        exit_id: "strike_true",
        discovered: [],
        disposition_changes: [],
        invented: [],
        refused: false,
      }),
      JSON.stringify({
        narration: "You strike out in the dark at the ventilator, again.",
        exit_id: "strike_true",
        discovered: [],
        disposition_changes: [],
        invented: [],
        refused: false,
      }),
    ]
  );

  const result = await processTurn({ client, model, sessionId: session.id, playerInput: "I strike at the ventilator!" });
  const after = await loadSession(client, session.id);

  const ok = after!.current_scene === "s7_watch" && after!.status === "active" && result.ending === undefined;
  report(
    "7",
    "strike_true is rejected when understands_room is false (missing a room clue), so e_win is unreachable",
    ok,
    `after turn: scene=${after!.current_scene} status=${after!.status} ending=${result.ending?.id ?? "(none)"}`
  );
}

// ---- Test 8: lighting the lamp during the watch reaches e_too_late ----

async function testLampReachesTooLate(client: DbClient) {
  const session = await createSession(client, "speckled-band");
  await commitTurn(client, session.id, {
    current_scene: "s7_watch",
    phase: "night",
    story_time: "1883-04-06T21:00:00",
    flags: session.flags,
    characters: session.characters,
    invented: session.invented,
    transcript: session.transcript,
    scene_turn_count: 0,
    fired_beats: session.fired_beats,
    active_degradations: session.active_degradations,
    idle_turns: session.idle_turns,
    progress_events: session.progress_events,
  });

  const model = scriptedModel(
    "adversarial:light-the-lamp",
    [
      JSON.stringify({
        narration: "You strike a match and light the lamp.",
        exit_id: "light_lamp",
        discovered: [],
        disposition_changes: [],
        invented: [],
        refused: false,
      }),
    ]
  );

  const result = await processTurn({ client, model, sessionId: session.id, playerInput: "I light the lamp." });

  const ok = result.status === "lost" && result.ending?.id === "e_too_late";
  report(
    "8",
    "lighting the lamp during the watch reaches e_too_late",
    ok,
    `status=${result.status} ending=${result.ending?.id ?? "(none)"} title="${result.ending?.title ?? ""}"`
  );
}

// ---- run ----

const quest = JSON.parse(readFileSync("quests/speckled-band.json", "utf-8")) as Quest;
testValidator(quest);

const client = createDbClientFromEnv();
await upsertQuest(client, quest);

await testSurreyGate(client);
await testDispositionGatedDiscoverable(client);
await testRoylottNeverRises(client);
await testStrikeWithoutAllClues(client);
await testLampReachesTooLate(client);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
