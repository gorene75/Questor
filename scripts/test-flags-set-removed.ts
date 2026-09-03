// Regression test for stage 1 of the v3 migration. Reproduces the exact
// live failure found during Fix 2 testing: session 07588087 / 438aa00f,
// turn_index=4 ("ask her what she wants"), where Claude Haiku returned
// discovered: [] but flags_set: ["heard_the_account"] — setting the flag
// with no validated discoverable behind it at all. Confirms the engine no
// longer reads flags_set even if a model (old habit, stale cache, whatever)
// still emits it in its raw JSON.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { createDbClientFromEnv, createSession, loadSession, upsertQuest, type DbClient } from "../src/db.ts";
import { validateQuest, type Quest } from "../src/validator.ts";
import { processTurn } from "../src/turn.ts";
import type { ModelAdapter } from "../src/models/index.ts";

function scriptedModel(name: string, responseText: string): ModelAdapter {
  return {
    name,
    async complete(_system: string, _user: string) {
      return { text: responseText };
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

// ---- Regression: the exact live shape — discovered: [], a bare flags_set claim ----

{
  const session = await createSession(client, "speckled-band");

  // Raw JSON text, deliberately including a flags_set key the current
  // ModelTurnResponse type no longer even has a slot for — this is what a
  // model emitting the old contract shape (or just hallucinating one) would
  // send. discovered is empty: nothing legitimately unlocked the flag.
  const rawResponseText = JSON.stringify({
    narration: "She draws breath, steadies her hands in her lap, and meets your eyes.",
    exit_id: null,
    guarded_event_id: null,
    discovered: [],
    flags_set: ["heard_the_account"],
    disposition_changes: [],
    invented: [],
    refused: false,
    narration_implies_departure: false,
  });

  const model = scriptedModel("regression:bare-flags-set-claim", rawResponseText);
  const result = await processTurn({ client, model, sessionId: session.id, playerInput: "ask her what she wants" });
  const after = await loadSession(client, session.id);

  const ok = after!.flags.heard_the_account === false;
  report(
    "heard_the_account stays false when the model claims it via flags_set with no discoverable behind it",
    ok,
    `narration="${result.narration}" heard_the_account=${after!.flags.heard_the_account} (raw response still contained a flags_set key — engine ignored it entirely)`
  );
}

// ---- Control: the legitimate path still works — discoverable sets it ----

{
  const session = await createSession(client, "speckled-band");
  const rawResponseText = JSON.stringify({
    narration: "She tells you: two years ago, a fortnight before her wedding, the door locked from inside.",
    exit_id: null,
    guarded_event_id: null,
    discovered: ["the_death"],
    disposition_changes: [],
    invented: [],
    refused: false,
    narration_implies_departure: false,
  });

  const model = scriptedModel("regression:legitimate-discoverable", rawResponseText);
  await processTurn({ client, model, sessionId: session.id, playerInput: "How did your sister die?" });
  const after = await loadSession(client, session.id);

  const ok = after!.flags.heard_the_account === true;
  report(
    "heard_the_account still sets correctly via a validated discoverable (discovered: ['the_death'])",
    ok,
    `heard_the_account=${after!.flags.heard_the_account}`
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
