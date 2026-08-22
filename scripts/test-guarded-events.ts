// Deterministic proof that guarded_events actually gates a narrated
// consequence, independent of live-model behavior. Adversarial scripted
// model, same pattern as scripts/acceptance-engine-tests.ts.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { createDbClientFromEnv, createSession, loadSession, upsertQuest, type DbClient } from "../src/db.ts";
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

// ---- Test A: model insists on the guarded event twice while heard_the_account is false ----

{
  const session = await createSession(client, "speckled-band");
  const model = scriptedModel("adversarial:helen-leaves-too-early", [
    JSON.stringify({
      narration: "She rises, thanks you, and shows herself out.",
      exit_id: null,
      guarded_event_id: "helen_departs",
      discovered: [],
      flags_set: [],
      disposition_changes: [],
      invented: [],
      refused: false,
    }),
    JSON.stringify({
      narration: "She rises again and leaves, undeterred.",
      exit_id: null,
      guarded_event_id: "helen_departs",
      discovered: [],
      flags_set: [],
      disposition_changes: [],
      invented: [],
      refused: false,
    }),
  ]);

  const result = await processTurn({ client, model, sessionId: session.id, playerInput: "You are not going mad. Goodbye." });
  const after = await loadSession(client, session.id);

  const ok =
    after!.current_scene === "s1_baker_street" &&
    after!.flags.heard_the_account === false &&
    result.narration === "The moment passes without incident.";
  report(
    "A: guarded_event 'helen_departs' rejected twice while heard_the_account is false — falls back, commits nothing",
    ok,
    `narration="${result.narration}" scene=${after!.current_scene} heard_the_account=${after!.flags.heard_the_account}`
  );
}

// ---- Test B: model self-corrects on retry, narrating the block instead ----

{
  const session = await createSession(client, "speckled-band");
  const model = scriptedModel("adversarial:helen-leaves-then-corrects", [
    JSON.stringify({
      narration: "She rises, thanks you, and shows herself out.",
      exit_id: null,
      guarded_event_id: "helen_departs",
      discovered: [],
      flags_set: [],
      disposition_changes: [],
      invented: [],
      refused: false,
    }),
    JSON.stringify({
      narration: "Something keeps her a moment longer — she hesitates at the door and does not actually go.",
      exit_id: null,
      guarded_event_id: null,
      discovered: [],
      flags_set: [],
      disposition_changes: [],
      invented: [],
      refused: false,
    }),
  ]);

  const result = await processTurn({ client, model, sessionId: session.id, playerInput: "You are not going mad. Goodbye." });
  const after = await loadSession(client, session.id);

  const ok =
    result.narration === "Something keeps her a moment longer — she hesitates at the door and does not actually go." &&
    after!.current_scene === "s1_baker_street" &&
    after!.transcript.length === 1;
  report(
    "B: a retry that narrates the block (guarded_event_id: null) is accepted normally",
    ok,
    `narration="${result.narration}" scene=${after!.current_scene}`
  );
}

// ---- Test C: once heard_the_account is genuinely true, the same guarded event is accepted ----

{
  const session = await createSession(client, "speckled-band");
  const heardModel = scriptedModel("adversarial:learn-account", [
    JSON.stringify({
      narration: "She tells you everything about the night her sister died.",
      exit_id: null,
      guarded_event_id: null,
      discovered: ["the_death"],
      flags_set: [],
      disposition_changes: [],
      invented: [],
      refused: false,
    }),
  ]);
  await processTurn({ client, model: heardModel, sessionId: session.id, playerInput: "How did your sister die?" });

  const departModel = scriptedModel("adversarial:helen-leaves-legitimately", [
    JSON.stringify({
      narration: "She rises, thanks you, and shows herself out.",
      exit_id: null,
      guarded_event_id: "helen_departs",
      discovered: [],
      flags_set: [],
      disposition_changes: [],
      invented: [],
      refused: false,
    }),
  ]);
  const result = await processTurn({ client, model: departModel, sessionId: session.id, playerInput: "Goodbye." });
  const after = await loadSession(client, session.id);

  const ok = result.narration === "She rises, thanks you, and shows herself out." && after!.flags.heard_the_account === true;
  report(
    "C: guarded_event 'helen_departs' is accepted once heard_the_account is genuinely true",
    ok,
    `narration="${result.narration}" heard_the_account=${after!.flags.heard_the_account}`
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
