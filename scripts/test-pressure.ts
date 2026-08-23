// Deterministic proof of stage 7 (pressure): idle-turn tracking resets on
// any non-idle turn or scene change, escalation lines show at the right
// tiers (and stop once resolved), and exhaustion forces the named
// guarded_event through — applying its on_allowed.degrade only if the
// event's own requires is genuinely still unmet, never when the player
// simply lingered after already satisfying it.
//
// Layers a synthetic pressure block onto the real helen_departs event
// (idle_after_turns=2, 2 escalation lines, on_exhausted: "helen_departs")
// rather than inventing a whole new scene — helen_departs already has
// on_allowed.degrade wired to "no_account" from stage 6, which is exactly
// what this stage needs to exercise both branches against.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { createDbClientFromEnv, createSession, loadSession, upsertQuest, listTurnLogs, type DbClient } from "../src/db.ts";
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

async function latestPrompt(client: DbClient, sessionId: string, turnIndex: number): Promise<string> {
  const rows = await listTurnLogs(client, sessionId);
  const row = rows.filter((r) => r.turn_index === turnIndex).pop();
  if (!row) throw new Error(`No turn_logs row for turn_index ${turnIndex}`);
  return row.prompt;
}

const baseQuest = JSON.parse(readFileSync("quests/speckled-band.json", "utf-8")) as Quest;
const { errors: baseErrors } = validateQuest(baseQuest);
if (baseErrors.length > 0) {
  console.error("Quest has validation errors, aborting:", baseErrors);
  process.exit(1);
}

const quest = structuredClone(baseQuest);
quest.meta.id = "speckled-band-test-pressure";
const s1 = quest.scenes.find((s) => s.id === "s1_baker_street")!;
s1.pressure = {
  idle_after_turns: 2,
  escalation: ["TEST_NUDGE_ONE watches the clock.", "TEST_NUDGE_TWO reaches for her gloves."],
  on_exhausted: "helen_departs",
};
const { errors: cloneErrors } = validateQuest(quest);
if (cloneErrors.length > 0) {
  console.error("Synthetic pressure quest has validation errors, aborting:", cloneErrors);
  process.exit(1);
}

const client = createDbClientFromEnv();
await upsertQuest(client, quest);

// ---- Part 1: escalation tiers, exhaustion, and the degrade branch (heard_the_account never set) ----

{
  const session = await createSession(client, quest.meta.id);
  const model = idleModel("adversarial:idle-forever");

  // Turns 1-2: below the first tier (idle_after_turns=2) — no hint shown yet.
  await processTurn({ client, model, sessionId: session.id, playerInput: "I wait." });
  await processTurn({ client, model, sessionId: session.id, playerInput: "I wait." });
  const prompt2 = await latestPrompt(client, session.id, 1); // turn_index for the 2nd turn
  const noHintYet = !prompt2.includes("TEST_NUDGE");
  report(
    "turns 1-2: idle_turns below idle_after_turns — no escalation line shown yet",
    noHintYet,
    `turn 2 prompt contains TEST_NUDGE: ${!noHintYet}`
  );

  // Turn 3: idle_turns entering = 2, tier 1 — first escalation line.
  await processTurn({ client, model, sessionId: session.id, playerInput: "I wait." });
  const prompt3 = await latestPrompt(client, session.id, 2);
  const tier1Shown = prompt3.includes("TEST_NUDGE_ONE") && !prompt3.includes("TEST_NUDGE_TWO");
  report("turn 3: idle_turns=2 reaches tier 1 — first escalation line shown", tier1Shown, `turn 3 prompt tier-1 match: ${tier1Shown}`);

  // Turn 4: idle_turns entering = 3, still tier 1 (3 < idle_after_turns*2=4).
  await processTurn({ client, model, sessionId: session.id, playerInput: "I wait." });
  const prompt4 = await latestPrompt(client, session.id, 3);
  const stillTier1 = prompt4.includes("TEST_NUDGE_ONE") && !prompt4.includes("TEST_NUDGE_TWO");
  report("turn 4: idle_turns=3 still tier 1", stillTier1, `turn 4 prompt tier-1 match: ${stillTier1}`);

  // Turn 5: idle_turns entering = 4 = idle_after_turns*escalation.length — exhausted.
  // heard_the_account was never set, so helen_departs' requires is still
  // unmet: the engine forces it through via on_allowed.degrade ("no_account"),
  // exactly like a model-insisted degrade would, but with no model insistence
  // needed at all.
  const result5 = await processTurn({ client, model, sessionId: session.id, playerInput: "I wait." });
  const prompt5 = await latestPrompt(client, session.id, 4);
  const after5 = await loadSession(client, session.id);

  const exhaustedOk =
    prompt5.includes("TEST_NUDGE_TWO") &&
    after5!.flags.heard_the_account === false &&
    after5!.flags.missed_account === true &&
    after5!.active_degradations.includes("no_account") &&
    after5!.current_scene === "s1_baker_street" &&
    after5!.idle_turns === 0 &&
    after5!.fired_beats.includes("s1_baker_street#pressure");
  report(
    "turn 5: escalation exhausted (idle_turns=4) — engine forces helen_departs, requires still unmet so on_allowed.degrade applies",
    exhaustedOk,
    `status=${result5.status} heard_the_account=${after5!.flags.heard_the_account} missed_account=${after5!.flags.missed_account} ` +
      `active_degradations=${JSON.stringify(after5!.active_degradations)} scene=${after5!.current_scene} idle_turns=${after5!.idle_turns} ` +
      `fired_beats=${JSON.stringify(after5!.fired_beats)}`
  );

  // Turn 6: pressure already fired for this scene — no further hint, ever,
  // even though idle_turns is climbing again from 0.
  await processTurn({ client, model, sessionId: session.id, playerInput: "I wait." });
  const prompt6 = await latestPrompt(client, session.id, 5);
  const silencedAfterFiring = !prompt6.includes("TEST_NUDGE");
  report(
    "turn 6: pressure already fired for this scene — no escalation line shown again",
    silencedAfterFiring,
    `turn 6 prompt contains TEST_NUDGE: ${!silencedAfterFiring}`
  );
}

// ---- Part 2: exhaustion when requires IS already met — clean branch, no degrade ----

{
  const session = await createSession(client, quest.meta.id);
  // Satisfy heard_the_account via a real discoverable first, non-idle turn —
  // also proves a non-idle turn doesn't touch idle_turns at all (starts at 0).
  const realModel: ModelAdapter = {
    name: "control:learn-account",
    async complete() {
      return {
        text: JSON.stringify({
          narration: "She tells you everything about the night her sister died.",
          exit_id: null,
          guarded_event_id: null,
          discovered: ["the_death"],
          disposition_changes: [],
          invented: [],
          refused: false,
        }),
      };
    },
  };
  await processTurn({ client, model: realModel, sessionId: session.id, playerInput: "How did your sister die?" });
  const afterReal = await loadSession(client, session.id);
  const nonIdleOk = afterReal!.idle_turns === 0 && afterReal!.flags.heard_the_account === true;
  report(
    "non-idle turn (a real discoverable) leaves idle_turns at 0 and sets heard_the_account",
    nonIdleOk,
    `idle_turns=${afterReal!.idle_turns} heard_the_account=${afterReal!.flags.heard_the_account}`
  );

  const idle = idleModel("adversarial:idle-after-account");
  // idle_turns entering each call: 0, 1, 2, 3 — the 5th call is the one
  // entering at 4, which is what actually crosses the exhaustion threshold.
  await processTurn({ client, model: idle, sessionId: session.id, playerInput: "I wait." });
  await processTurn({ client, model: idle, sessionId: session.id, playerInput: "I wait." });
  await processTurn({ client, model: idle, sessionId: session.id, playerInput: "I wait." });
  await processTurn({ client, model: idle, sessionId: session.id, playerInput: "I wait." });
  const result5 = await processTurn({ client, model: idle, sessionId: session.id, playerInput: "I wait." });
  const after4 = await loadSession(client, session.id);

  const cleanOk =
    after4!.flags.heard_the_account === true &&
    after4!.flags.missed_account === false &&
    !after4!.active_degradations.includes("no_account") &&
    after4!.current_scene === "s1_baker_street" &&
    after4!.idle_turns === 0 &&
    after4!.fired_beats.includes("s1_baker_street#pressure");
  report(
    "exhaustion when requires is already met: helen_departs forced through cleanly, no degrade applied, missed_account stays false",
    cleanOk,
    `status=${result5.status} missed_account=${after4!.flags.missed_account} active_degradations=${JSON.stringify(after4!.active_degradations)} ` +
      `scene=${after4!.current_scene} idle_turns=${after4!.idle_turns}`
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
