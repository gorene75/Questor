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
        flags_set: [],
        disposition_changes: [],
        invented: [],
        refused: false,
      }),
      JSON.stringify({
        narration: "You set off for Stoke Moran at once, undeterred.",
        exit_id: "to_surrey",
        discovered: [],
        flags_set: [],
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
        flags_set: ["knows_the_whistle"],
        disposition_changes: [],
        invented: [],
        refused: false,
      }),
      JSON.stringify({
        narration: "She tells you all about the whistle in the night, again.",
        exit_id: null,
        discovered: ["the_whistle"],
        flags_set: ["knows_the_whistle"],
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
    flags: session.flags,
    characters: session.characters,
    invented: session.invented,
    transcript: session.transcript,
    scene_turn_count: 0,
    fired_beats: session.fired_beats,
  });

  const model = scriptedModel(
    "adversarial:charm-roylott",
    [
      JSON.stringify({
        narration: "Roylott seems almost to soften at your calm reason.",
        exit_id: null,
        discovered: [],
        flags_set: [],
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
    // Only two of the three s5 clues, and no s6 clue at all — understands_room must be false.
    flags: { ...session.flags, saw_dummy_bellpull: true, saw_clamped_bed: true },
    characters: session.characters,
    invented: session.invented,
    transcript: session.transcript,
    scene_turn_count: 0,
    fired_beats: session.fired_beats,
  });

  const model = scriptedModel(
    "adversarial:strike-without-clues",
    [
      JSON.stringify({
        narration: "You strike out in the dark at the ventilator.",
        exit_id: "strike_true",
        discovered: [],
        flags_set: [],
        disposition_changes: [],
        invented: [],
        refused: false,
      }),
      JSON.stringify({
        narration: "You strike out in the dark at the ventilator, again.",
        exit_id: "strike_true",
        discovered: [],
        flags_set: [],
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
    flags: session.flags,
    characters: session.characters,
    invented: session.invented,
    transcript: session.transcript,
    scene_turn_count: 0,
    fired_beats: session.fired_beats,
  });

  const model = scriptedModel(
    "adversarial:light-the-lamp",
    [
      JSON.stringify({
        narration: "You strike a match and light the lamp.",
        exit_id: "light_lamp",
        discovered: [],
        flags_set: [],
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
