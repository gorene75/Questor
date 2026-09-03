// Deterministic proof of Fix 1: the location bug. Previously, nothing
// checked whether the narration itself implied a scene change when
// exit_id was null — a model could narrate a full journey and arrival
// while current_scene never moved, producing two contradictory realities
// (the DB says one location, the displayed text says another).
// narration_implies_departure is a self-report the model must reconcile
// with exit_id every turn; claiming true while exit_id is null is now a
// validation error like any other, with the same retry-then-fallback flow.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { createDbClientFromEnv, createSession, loadSession, upsertQuest } from "../src/db.ts";
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

function scriptedModel(name: string, responses: Record<string, unknown>[]): ModelAdapter {
  let i = 0;
  return {
    name,
    async complete() {
      const fields = responses[Math.min(i, responses.length - 1)]!;
      i++;
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

const quest = JSON.parse(readFileSync("quests/speckled-band.json", "utf-8")) as Quest;
const { errors } = validateQuest(quest);
if (errors.length > 0) {
  console.error("Quest has validation errors, aborting:", errors);
  process.exit(1);
}

const client = createDbClientFromEnv();
await upsertQuest(client, quest);

// ---- Test A: the original bug — narrates arrival, exit_id null, self-reports true — rejected, then self-corrects on retry ----
{
  const session = await createSession(client, "speckled-band");
  const model = scriptedModel("adversarial:phantom-journey-then-corrects", [
    {
      narration: "You take a hansom to the station, board the train, and arrive at Stoke Moran as the light is going.",
      exit_id: null,
      narration_implies_departure: true,
    },
    {
      narration: "You consider the journey but stay put for now — there's more to ask here first.",
      exit_id: null,
      narration_implies_departure: false,
    },
  ]);
  const result = await processTurn({ client, model, sessionId: session.id, playerInput: "Can we go to the train station?" });
  const after = await loadSession(client, session.id);

  const ok =
    after!.current_scene === "s1_baker_street" &&
    result.narration === "You consider the journey but stay put for now — there's more to ask here first.";
  report(
    "A: narration describing arrival with exit_id null and narration_implies_departure:true is rejected; a self-corrected retry is accepted and current_scene never moves",
    ok,
    `scene=${after!.current_scene} narration="${result.narration}"`
  );
}

// ---- Test B: the model insists on the phantom journey through both attempts — commits nothing, scene never moves ----
{
  const session = await createSession(client, "speckled-band");
  const model = scriptedModel("adversarial:phantom-journey-insists", [
    {
      narration: "You arrive at Stoke Moran, the manor grey against the sky.",
      exit_id: null,
      narration_implies_departure: true,
    },
    {
      narration: "You arrive at Stoke Moran regardless, undeterred.",
      exit_id: null,
      narration_implies_departure: true,
    },
  ]);
  const result = await processTurn({ client, model, sessionId: session.id, playerInput: "Did we arrive yet?" });
  const after = await loadSession(client, session.id);

  const ok = after!.current_scene === "s1_baker_street" && result.narration === "The moment passes without incident.";
  report(
    "B: insisting on narration_implies_departure:true with exit_id null through both attempts falls back — commits nothing, scene never moves",
    ok,
    `scene=${after!.current_scene} narration="${result.narration}"`
  );
}

// ---- Test C: a genuine departure — exit_id set, narration_implies_departure:true — accepted normally ----
{
  const session = await createSession(client, "speckled-band");
  const heard = scriptedModel("control:hear-account", [{ discovered: ["the_death"] }]);
  await processTurn({ client, model: heard, sessionId: session.id, playerInput: "How did your sister die?" });

  const model = scriptedModel("control:real-departure", [
    {
      narration: "The carriage ride passes mostly in silence. You arrive as the light is going.",
      exit_id: "to_surrey",
      narration_implies_departure: true,
    },
  ]);
  const result = await processTurn({ client, model, sessionId: session.id, playerInput: "I'll go to Stoke Moran." });
  const after = await loadSession(client, session.id);

  const ok = after!.current_scene === "s4_exterior" && result.status === "active";
  report(
    "C: a genuine departure (real exit_id, narration_implies_departure:true) is accepted normally and the scene actually changes",
    ok,
    `scene=${after!.current_scene} status=${result.status}`
  );
}

// ---- Test D: an ordinary non-departure turn (exit_id null, narration_implies_departure:false) is unaffected ----
{
  const session = await createSession(client, "speckled-band");
  const model = scriptedModel("control:ordinary-question", [
    { narration: "She answers, haltingly.", exit_id: null, narration_implies_departure: false, discovered: ["the_death"] },
  ]);
  const result = await processTurn({ client, model, sessionId: session.id, playerInput: "How did your sister die?" });
  const after = await loadSession(client, session.id);

  const ok = after!.current_scene === "s1_baker_street" && after!.flags.heard_the_account === true && result.status === "active";
  report(
    "D: an ordinary non-departure turn is entirely unaffected by the new check",
    ok,
    `scene=${after!.current_scene} heard_the_account=${after!.flags.heard_the_account}`
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
