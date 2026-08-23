// Deterministic proof of stage 5 (v3 minutes-based clock): costs_minutes
// precedence over the model's minutes_elapsed suggestion over
// default_turn_cost_minutes, derivePhase's circular-range lookup including
// the midnight wrap, and the clock.deadline backstop — including its
// priority over max_turns when both would fire on the same turn.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { createDbClientFromEnv, createSession, commitTurn, upsertQuest, type DbClient } from "../src/db.ts";
import { validateQuest, type Quest } from "../src/validator.ts";
import { processTurn } from "../src/turn.ts";
import { derivePhase } from "../src/clock.ts";
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
          narration: "Time passes.",
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

// ---- derivePhase: pure unit test, no DB, including the midnight wrap ----
// quest phases: morning until 12:00, afternoon until 18:00, dusk until 20:30, night until 05:00
{
  const cases: [string, string][] = [
    ["1883-04-06T00:00:00", "night"], // wraps past midnight
    ["1883-04-06T04:59:00", "night"],
    ["1883-04-06T05:00:00", "morning"], // night -> morning boundary
    ["1883-04-06T11:59:00", "morning"],
    ["1883-04-06T12:00:00", "afternoon"], // morning -> afternoon boundary
    ["1883-04-06T17:59:00", "afternoon"],
    ["1883-04-06T18:00:00", "dusk"], // afternoon -> dusk boundary
    ["1883-04-06T20:29:00", "dusk"],
    ["1883-04-06T20:30:00", "night"], // dusk -> night boundary
    ["1883-04-06T23:59:00", "night"],
  ];
  let allOk = true;
  const details: string[] = [];
  for (const [t, expected] of cases) {
    const got = derivePhase(quest.clock.phases, t);
    const ok = got === expected;
    if (!ok) allOk = false;
    details.push(`${t}->${got}${ok ? "" : `(expected ${expected})`}`);
  }
  report("derivePhase: circular phase lookup correct at every boundary, including the midnight wrap", allOk, details.join(" "));
}

// ---- costs_minutes on the taken exit wins over the model's minutes_elapsed ----
{
  const session = await createSession(client, "speckled-band");
  // to_commons costs_minutes=30; model also (implausibly) claims minutes_elapsed=999.
  // If costs_minutes didn't win, story_time would jump by 60 (the clamp) or 999.
  const model = modelReturning("adversarial:bogus-minutes-with-exit", { exit_id: "to_commons", minutes_elapsed: 999 });
  const result = await processTurn({ client, model, sessionId: session.id, playerInput: "I'll look into the will." });
  const expected = "1883-04-06T07:45:00"; // 07:15 + 30
  const ok = result.session.story_time === expected && result.session.current_scene === "s3_commons";
  report(
    "exit.costs_minutes (30) wins over the model's minutes_elapsed (999) claim",
    ok,
    `story_time=${result.session.story_time} (expected ${expected}) scene=${result.session.current_scene}`
  );
}

// ---- model's minutes_elapsed is used (clamped to 60) on a free-form turn ----
{
  const session = await createSession(client, "speckled-band");
  const model = modelReturning("adversarial:huge-minutes-no-exit", { minutes_elapsed: 500 });
  const result = await processTurn({ client, model, sessionId: session.id, playerInput: "I sit and think a while." });
  const expected = "1883-04-06T08:15:00"; // 07:15 + 60 (clamped from 500)
  const ok = result.session.story_time === expected;
  report(
    "no exit taken: model's minutes_elapsed (500) is clamped to 60, not applied raw",
    ok,
    `story_time=${result.session.story_time} (expected ${expected})`
  );
}

// ---- default_turn_cost_minutes is the final fallback ----
{
  const session = await createSession(client, "speckled-band");
  const model = modelReturning("adversarial:no-minutes-field", {}); // omits minutes_elapsed entirely
  const result = await processTurn({ client, model, sessionId: session.id, playerInput: "I look around the room." });
  const expected = "1883-04-06T07:20:00"; // 07:15 + 5 (quest's default_turn_cost_minutes)
  const ok = result.session.story_time === expected;
  report(
    "no exit, no minutes_elapsed: falls back to quest.clock.default_turn_cost_minutes (5)",
    ok,
    `story_time=${result.session.story_time} (expected ${expected})`
  );
}

// ---- clock.deadline backstop fires and records ending_trigger='deadline_reached' ----
{
  const session = await createSession(client, "speckled-band");
  // Push story_time to just short of the 03:00 deadline; a free-form turn
  // costing the default 5 minutes crosses it (02:58 + 5 = 03:03 >= 03:00).
  // scene_turn_count stays at 0 so max_turns can't also be a factor here.
  await commitTurn(client, session.id, {
    current_scene: "s7_watch",
    phase: "night",
    story_time: "1883-04-07T02:58:00",
    flags: session.flags,
    characters: session.characters,
    invented: session.invented,
    transcript: session.transcript,
    scene_turn_count: 0,
    fired_beats: session.fired_beats,
    active_degradations: session.active_degradations,
    idle_turns: session.idle_turns,
  });

  const model = modelReturning("adversarial:idle-past-deadline", {});
  const result = await processTurn({ client, model, sessionId: session.id, playerInput: "I keep waiting." });

  const ok =
    result.status === "lost" &&
    result.ending?.id === "e_too_late" &&
    result.ending?.trigger === "deadline_reached" &&
    result.session.ending_trigger === "deadline_reached";
  report(
    "clock.deadline reached (03:03 >= 03:00) forces the authored on_reached ending with ending_trigger='deadline_reached'",
    ok,
    `status=${result.status} ending_id=${result.ending?.id} ending_trigger=${result.ending?.trigger} story_time=${result.session.story_time}`
  );
}

// ---- deadline takes priority over max_turns when both would fire the same turn ----
{
  const session = await createSession(client, "speckled-band");
  // s3_commons has no beats/on_fail to interfere, same as test-max-turns.ts.
  // scene_turn_count=25 (one below default cap of 25) so this turn's plain
  // increment to 26 would ALSO exceed max_turns — but story_time is also
  // pushed past the deadline by the same turn's default 5-minute cost, and
  // deadline is checked first, so max_turns must never get the chance to fire.
  await commitTurn(client, session.id, {
    current_scene: "s3_commons",
    phase: "night",
    story_time: "1883-04-07T02:58:00",
    flags: session.flags,
    characters: session.characters,
    invented: session.invented,
    transcript: session.transcript,
    scene_turn_count: 25,
    fired_beats: session.fired_beats,
    active_degradations: session.active_degradations,
    idle_turns: session.idle_turns,
  });

  const model = modelReturning("adversarial:idle-past-deadline-and-max-turns", {});
  const result = await processTurn({ client, model, sessionId: session.id, playerInput: "I keep circling." });

  const ok =
    result.ending?.id === "e_too_late" &&
    result.ending?.trigger === "deadline_reached" &&
    result.session.ending_trigger === "deadline_reached";
  report(
    "deadline wins over max_turns when both would fire the same turn (ending_trigger stays 'deadline_reached', not 'max_turns_exceeded')",
    ok,
    `ending_id=${result.ending?.id} ending_trigger=${result.ending?.trigger}`
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
