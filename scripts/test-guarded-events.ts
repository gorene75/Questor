// Deterministic proof that guarded_events actually gates a narrated
// consequence, independent of live-model behavior. Adversarial scripted
// model, same pattern as scripts/acceptance-engine-tests.ts.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { createDbClientFromEnv, createSession, loadSession, upsertQuest } from "../src/db.ts";
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
// helen_departs declares on_allowed.degrade: "no_account" (stage 6), so
// insisting through both attempts no longer dead-ends into the generic
// fallback — it falls into the named degradation instead: the model's own
// final narration commits, heard_the_account stays false (never legitimately
// earned), but missed_account is set and no_account joins active_degradations.

{
  const session = await createSession(client, "speckled-band");
  const model = scriptedModel("adversarial:helen-leaves-too-early", [
    JSON.stringify({
      narration: "She rises, thanks you, and shows herself out.",
      exit_id: null,
      guarded_event_id: "helen_departs",
      discovered: [],
      disposition_changes: [],
      invented: [],
      refused: false,
    }),
    JSON.stringify({
      narration: "She rises again and leaves, undeterred.",
      exit_id: null,
      guarded_event_id: "helen_departs",
      discovered: [],
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
    after!.flags.missed_account === true &&
    after!.active_degradations.includes("no_account") &&
    result.narration === "She rises again and leaves, undeterred.";
  report(
    "A: guarded_event 'helen_departs' insisted on twice while heard_the_account is false — falls into its on_allowed.degrade ('no_account') instead of dead-ending",
    ok,
    `narration="${result.narration}" scene=${after!.current_scene} heard_the_account=${after!.flags.heard_the_account} missed_account=${after!.flags.missed_account} active_degradations=${JSON.stringify(after!.active_degradations)}`
  );
}

// ---- Test A2: a guarded event with NO on_allowed.degrade still dead-ends as before ----
// helen_departs itself now opts into degrade, so this proves the original
// stage-1-era safety net (insist twice, get nothing, commit nothing) still
// holds for events that don't declare on_allowed — the degrade path is
// additive, not a silent change to every guarded_event's behavior. Uses a
// synthetic quest (same file, on_allowed stripped from helen_departs) so
// this doesn't depend on the live quest never adding on_allowed to it.

{
  const noDegradeQuest = structuredClone(quest);
  const s1 = noDegradeQuest.scenes.find((s) => s.id === "s1_baker_street")!;
  delete s1.guarded_events![0]!.on_allowed;
  noDegradeQuest.meta.id = "speckled-band-test-guard-no-degrade";
  const { errors: cloneErrors } = validateQuest(noDegradeQuest);
  if (cloneErrors.length > 0) {
    console.error("Synthetic no-degrade quest has validation errors, aborting:", cloneErrors);
    process.exit(1);
  }
  await upsertQuest(client, noDegradeQuest);

  const session = await createSession(client, noDegradeQuest.meta.id);
  const model = scriptedModel("adversarial:helen-leaves-too-early-no-degrade", [
    JSON.stringify({
      narration: "She rises, thanks you, and shows herself out.",
      exit_id: null,
      guarded_event_id: "helen_departs",
      discovered: [],
      disposition_changes: [],
      invented: [],
      refused: false,
    }),
    JSON.stringify({
      narration: "She rises again and leaves, undeterred.",
      exit_id: null,
      guarded_event_id: "helen_departs",
      discovered: [],
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
    after!.active_degradations.length === 0 &&
    result.narration === "The moment passes without incident.";
  report(
    "A2: a guarded_event with no on_allowed.degrade still falls back and commits nothing when insisted on twice",
    ok,
    `narration="${result.narration}" scene=${after!.current_scene} heard_the_account=${after!.flags.heard_the_account} active_degradations=${JSON.stringify(after!.active_degradations)}`
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
      disposition_changes: [],
      invented: [],
      refused: false,
    }),
    JSON.stringify({
      narration: "Something keeps her a moment longer — she hesitates at the door and does not actually go.",
      exit_id: null,
      guarded_event_id: null,
      discovered: [],
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

// ---- Test D: once 'no_account' is active, its unlocks bypass to_surrey's requires ----
// to_surrey normally requires ready_to_travel (= heard_the_account), which
// acceptance-engine-tests.ts Test 3 proves is enforced. This proves the
// other side: after Helen leaves without the account (Test A's path),
// to_surrey becomes legally reachable anyway — the degradation's whole
// point — even though heard_the_account itself never becomes true.

{
  const session = await createSession(client, "speckled-band");
  const leaveModel = scriptedModel("adversarial:helen-leaves-too-early-then-travel", [
    JSON.stringify({
      narration: "She rises, thanks you, and shows herself out.",
      exit_id: null,
      guarded_event_id: "helen_departs",
      discovered: [],
      disposition_changes: [],
      invented: [],
      refused: false,
    }),
    JSON.stringify({
      narration: "She rises again and leaves, undeterred.",
      exit_id: null,
      guarded_event_id: "helen_departs",
      discovered: [],
      disposition_changes: [],
      invented: [],
      refused: false,
    }),
  ]);
  await processTurn({ client, model: leaveModel, sessionId: session.id, playerInput: "You are not going mad. Goodbye." });

  const travelModel = scriptedModel("adversarial:travel-without-account", [
    JSON.stringify({
      narration: "With nothing more to go on, you take the first train down to Surrey regardless.",
      exit_id: "to_surrey",
      guarded_event_id: null,
      discovered: [],
      disposition_changes: [],
      invented: [],
      refused: false,
    }),
  ]);
  const result = await processTurn({ client, model: travelModel, sessionId: session.id, playerInput: "I'll go to Surrey anyway." });
  const after = await loadSession(client, session.id);

  const ok = after!.current_scene === "s4_exterior" && after!.flags.heard_the_account === false && !result.refused;
  report(
    "D: degradation 'no_account'.unlocks makes to_surrey reachable despite heard_the_account staying false",
    ok,
    `scene=${after!.current_scene} heard_the_account=${after!.flags.heard_the_account} narration="${result.narration}"`
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
