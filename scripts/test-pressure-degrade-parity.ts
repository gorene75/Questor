// End-to-end confirmation, against the real unmodified speckled-band.json,
// that pressure-forced exhaustion of helen_departs and a model-insisted
// on_allowed.degrade converge on identical resulting state. This is the
// regression test for the exact bug the whole v3 effort started from
// (flags_set letting a model claim a consequence with nothing behind it) —
// the concern here is the mirror image: does the ENGINE'S OWN automatic
// consequence apply through the same validated path as a model-triggered
// one, or does it silently take a different, unverified route?
//
// s1_baker_street's real pressure config is idle_after_turns: 2 with 3
// escalation lines, so genuine exhaustion is at idle_turns=6 (2*3) — the
// nudges show at 2 and 4, the force fires once entering idle_turns reaches 6
// (the 7th consecutive idle turn), comfortably ahead of the scene's own
// at_turn:9 beat (Roylott's intrusion) so the beat never preempts it. This
// test drives real idle turns to that real threshold, no synthetic
// shortcuts, and diffs the result against test-guarded-events.ts's Test A
// (model insists on guarded_event_id: "helen_departs" twice).

import "dotenv/config";
import { readFileSync } from "node:fs";
import { createDbClientFromEnv, createSession, loadSession, upsertQuest, listTurnLogs } from "../src/db.ts";
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

function idleModel(name: string): ModelAdapter {
  return {
    name,
    async complete() {
      return {
        text: JSON.stringify({
          narration: `Nothing in particular happens (idle turn from ${name}).`,
          exit_id: null,
          guarded_event_id: null,
          discovered: [],
          disposition_changes: [],
          invented: [],
          refused: false,
          narration_implies_departure: false,
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

// Confirm the real config this test relies on hasn't drifted silently, and
// that pressure's exhaustion turn (idle_after_turns * escalation.length)
// stays safely ahead of the scene's own beat at_turn — otherwise the beat
// would preempt pressure every time, exactly the bug this test caught once.
const s1 = quest.scenes.find((s) => s.id === "s1_baker_street")!;
const exhaustionTurn = (s1.pressure?.idle_after_turns ?? 0) * (s1.pressure?.escalation.length ?? 0);
const earliestBeat = Math.min(...(s1.beats ?? []).map((b) => b.at_turn));
const realConfigOk =
  s1.pressure?.on_exhausted === "helen_departs" &&
  s1.guarded_events?.find((g) => g.id === "helen_departs")?.on_allowed?.degrade === "no_account" &&
  exhaustionTurn < earliestBeat;
report(
  "precondition: s1_baker_street's real pressure config targets helen_departs -> no_account, and exhausts before its own beat can preempt it",
  realConfigOk,
  `pressure=${JSON.stringify(s1.pressure)} exhaustionTurn=${exhaustionTurn} earliestBeat=${earliestBeat} on_allowed=${JSON.stringify(s1.guarded_events?.find((g) => g.id === "helen_departs")?.on_allowed)}`
);
if (!realConfigOk) {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

const client = createDbClientFromEnv();
await upsertQuest(client, quest);

// ---- Path A: pressure-forced, via genuinely idle turns, real quest, real thresholds ----

const sessionA = await createSession(client, "speckled-band");
const idle = idleModel("adversarial:idle-until-exhausted");
let lastResultA;
const turnsToExhaustion = exhaustionTurn + 1; // entering idle_turns reaches exhaustionTurn on this call
for (let i = 1; i <= turnsToExhaustion; i++) {
  lastResultA = await processTurn({ client, model: idle, sessionId: sessionA.id, playerInput: "I wait." });
}
const afterA = await loadSession(client, sessionA.id);
const logsA = await listTurnLogs(client, sessionA.id);
const finalPrompt = logsA.filter((r) => r.turn_index === turnsToExhaustion - 1).pop()!.prompt;
const finalEscalationLine = s1.pressure!.escalation[s1.pressure!.escalation.length - 1]!;

// ---- Path B: model insists on guarded_event_id: "helen_departs" twice, same as test-guarded-events.ts Test A ----

const sessionB = await createSession(client, "speckled-band");
let attempt = 0;
const insistingModel: ModelAdapter = {
  name: "adversarial:helen-leaves-too-early",
  async complete() {
    attempt++;
    return {
      text: JSON.stringify({
        narration: attempt === 1 ? "She rises, thanks you, and shows herself out." : "She rises again and leaves, undeterred.",
        exit_id: null,
        guarded_event_id: "helen_departs",
        discovered: [],
        disposition_changes: [],
        invented: [],
        refused: false,
        narration_implies_departure: false,
      }),
    };
  },
};
await processTurn({ client, model: insistingModel, sessionId: sessionB.id, playerInput: "You are not going mad. Goodbye." });
const afterB = await loadSession(client, sessionB.id);

// ---- Confirm Path A never had the model explicitly claim guarded_event_id ----

const pathANeverClaimedEvent = logsA.every((row) => {
  const parsed = row.parsed as { guarded_event_id?: string | null } | null;
  return !parsed || parsed.guarded_event_id === null;
});
report(
  `Path A: the model never once set guarded_event_id itself across all ${turnsToExhaustion} turns — the engine forced the consequence entirely on its own`,
  pathANeverClaimedEvent,
  `guarded_event_id values: ${JSON.stringify(logsA.map((r) => (r.parsed as { guarded_event_id?: string | null } | null)?.guarded_event_id ?? null))}`
);

report(
  `Path A (pressure-forced, idle_turns reaches ${exhaustionTurn}): the exhausting turn's prompt shows the final escalation line`,
  finalPrompt.includes(finalEscalationLine),
  `final-turn prompt contains "${finalEscalationLine}": ${finalPrompt.includes(finalEscalationLine)}`
);

// ---- The actual parity check: identical resulting state via two different routes to the same consequence ----

const parityOk =
  afterA!.flags.heard_the_account === false &&
  afterB!.flags.heard_the_account === false &&
  afterA!.flags.missed_account === true &&
  afterB!.flags.missed_account === true &&
  afterA!.active_degradations.includes("no_account") &&
  afterB!.active_degradations.includes("no_account") &&
  afterA!.current_scene === "s1_baker_street" &&
  afterB!.current_scene === "s1_baker_street" &&
  afterA!.status === "active" &&
  afterB!.status === "active";

report(
  "pressure-forced (Path A) and model-insisted (Path B) helen_departs converge on identical state: missed_account=true, no_account active, still in s1, still active",
  parityOk,
  `A: missed_account=${afterA!.flags.missed_account} active_degradations=${JSON.stringify(afterA!.active_degradations)} scene=${afterA!.current_scene} status=${afterA!.status} | ` +
    `B: missed_account=${afterB!.flags.missed_account} active_degradations=${JSON.stringify(afterB!.active_degradations)} scene=${afterB!.current_scene} status=${afterB!.status}`
);

// ---- Narration for the forcing turn is genuinely the model's own text, not a canned engine string ----

const narrationIsModelsOwn = lastResultA!.narration === "Nothing in particular happens (idle turn from adversarial:idle-until-exhausted).";
report(
  "Path A's forcing turn commits the model's own narration for that turn, not a substituted engine string",
  narrationIsModelsOwn,
  `narration="${lastResultA!.narration}"`
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
