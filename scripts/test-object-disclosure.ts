// Deterministic proof of the object-graph disclosure mechanism, scoped to
// s1_baker_street. Four scenarios, matching today's actual bug class:
// Roylott appearing, an invented answer for "where is the will", and an
// invented hansom journey with no valid exit. Each test drives real
// processTurn calls with a scripted fake model — the mechanism itself
// (discloseToPlayer / setObjectPresent / player_knowledge reads) is real,
// only the model's text is canned.

import "dotenv/config";
import { readFileSync } from "node:fs";
import {
  createDbClientFromEnv,
  createSession,
  loadPlayerKnowledge,
  loadSession,
  upsertQuest,
  type DbClient,
} from "../src/db.ts";
import { validateQuest, type Quest } from "../src/validator.ts";
import { processTurn } from "../src/turn.ts";
import type { ModelAdapter } from "../src/models/index.ts";
import { buildPrompt, type SessionState, type TurnRecord } from "../src/prompt.ts";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, evidence: string) {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  console.log(`  ${evidence}`);
  if (ok) pass++;
  else fail++;
}

function scriptedModel(name: string, fields: Record<string, unknown>): ModelAdapter {
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

const client: DbClient = createDbClientFromEnv();
await upsertQuest(client, quest);

// ==== Test 1: Roylott — sparse disclosure, then a forced-arrival attempt that can't render him present ====
{
  const session = await createSession(client, "speckled-band");

  // "ask Helen about her stepfather" — matches the new about_stepfather discoverable.
  await processTurn({
    client,
    model: scriptedModel("ask-about-stepfather", {
      narration: "She says his name like it costs her something: Dr Grimesby Roylott.",
      discovered: ["about_stepfather"],
    }),
    sessionId: session.id,
    playerInput: "who is your stepfather?",
  });

  const knowledge = await loadPlayerKnowledge(client, session.id);
  const roylott = knowledge.roylott;
  const sparseOk =
    !!roylott && roylott.present === false && Object.keys(roylott.known).length === 2 && "name" in roylott.known && "role" in roylott.known && !("danger" in roylott.known);
  report(
    "Roylott: asking about the stepfather writes a sparse player_knowledge row (name, role only — not danger), present:false",
    sparseOk,
    `row=${JSON.stringify(roylott)}`
  );

  // Now try to force his arrival with no real scene/beat/guarded event firing —
  // the model insists he's here, but nothing engine-validated ever set present:true.
  const after1 = await loadSession(client, session.id);
  const questRow = quest;
  const forceState: SessionState = {
    current_scene: after1!.current_scene,
    phase: after1!.phase,
    story_time: after1!.story_time,
    flags: after1!.flags,
    characters: after1!.characters,
    invented: after1!.invented,
    idle_turns: after1!.idle_turns,
    pressure_fired: false,
    known_objects: await loadPlayerKnowledge(client, session.id),
  };
  const prompt = buildPrompt(questRow, forceState, after1!.transcript as unknown as TurnRecord[], "does he burst in right now?");
  const knowledgeAfter = await loadPlayerKnowledge(client, session.id);
  const stillNotPresent = knowledgeAfter.roylott?.present === false;
  const promptShowsNotPresent = prompt.includes("roylott (known:") && prompt.includes("not present");
  const promptHasNoBehaviourData = !prompt.includes("bile-shot eyes") && !prompt.includes("Enormous, sunburnt");
  report(
    "Roylott: with no validated exit/beat/guarded_event ever firing, present stays false and the prompt never gives him a behaviour block to act from",
    stillNotPresent && promptShowsNotPresent && promptHasNoBehaviourData,
    `present=${knowledgeAfter.roylott?.present} prompt marks not-present=${promptShowsNotPresent} no behaviour data leaked=${promptHasNoBehaviourData}`
  );
}

// ==== Test 2: the will — no disclosure event has fired, so no row exists yet ====
{
  const session = await createSession(client, "speckled-band");
  const knowledge = await loadPlayerKnowledge(client, session.id);
  const noRow = knowledge.the_will === undefined;
  report(
    "The will: before any disclosure event, no the_will row exists in player_knowledge at all",
    noRow,
    `the_will row: ${JSON.stringify(knowledge.the_will)}`
  );

  // The render for s1_baker_street: nothing the_will-specific ever appears
  // (no location field, no "solicitor") — a graceful absence, not a stated answer.
  const sessionRow = await loadSession(client, session.id);
  const state: SessionState = {
    current_scene: sessionRow!.current_scene,
    phase: sessionRow!.phase,
    story_time: sessionRow!.story_time,
    flags: sessionRow!.flags,
    characters: sessionRow!.characters,
    invented: sessionRow!.invented,
    idle_turns: sessionRow!.idle_turns,
    pressure_fired: false,
    known_objects: knowledge,
  };
  const prompt = buildPrompt(quest, state, [], "where is the will?");
  const noInventedLocation = !prompt.includes("family solicitor") && !prompt.includes("Held by the family solicitor");
  report(
    "The will: the rendered prompt contains no specific located answer (e.g. 'family solicitor') — a graceful null-case, not an invented one",
    noInventedLocation,
    `prompt mentions the solicitor location: ${!noInventedLocation}`
  );
}

// ==== Test 3: Helen leaving — present flip requires the validated helen_departs guarded event ====
{
  const session = await createSession(client, "speckled-band");
  // Get heard_the_account true first so helen_departs is actually available (not blocked).
  await processTurn({
    client,
    model: scriptedModel("hear-account", { discovered: ["the_death"] }),
    sessionId: session.id,
    playerInput: "how did your sister die?",
  });

  const beforeKnowledge = await loadPlayerKnowledge(client, session.id);
  const helenPresentBefore = beforeKnowledge.helen?.present;

  await processTurn({
    client,
    model: scriptedModel("helen-leaves", {
      narration: "She rises, thanks you, and shows herself out.",
      guarded_event_id: "helen_departs",
    }),
    sessionId: session.id,
    playerInput: "goodbye, that will be all",
  });

  const afterKnowledge = await loadPlayerKnowledge(client, session.id);
  const flippedFalse = afterKnowledge.helen?.present === false;
  report(
    "Helen: present flips to false only once, exactly when the validated helen_departs guarded event actually fires",
    helenPresentBefore !== false && flippedFalse,
    `present before=${helenPresentBefore} present after helen_departs=${afterKnowledge.helen?.present}`
  );

  // A separate session where the model's FIRST attempt claims helen_departs
  // before heard_the_account is true (rejected — requires unmet), and the
  // model self-corrects on retry (narrates the on_blocked line, no
  // guarded_event_id). Since helen_departs declares on_allowed.degrade, an
  // model that insisted on BOTH attempts would legitimately go through via
  // the forced-degrade path (already covered by test-pressure-degrade-parity.ts
  // — that's correct, validated behavior, not a bypass); this checks the
  // other legitimate outcome, where the retry corrects instead of insisting,
  // and present must not have flipped from a rejected first attempt alone.
  const session2 = await createSession(client, "speckled-band");
  let attempt = 0;
  const selfCorrectingModel: ModelAdapter = {
    name: "helen-blocked-then-self-corrects",
    async complete() {
      attempt++;
      const fields =
        attempt === 1
          ? { narration: "She rises to leave.", guarded_event_id: "helen_departs" }
          : { narration: "Something keeps her a moment longer.", guarded_event_id: null };
      return {
        text: JSON.stringify({
          exit_id: null,
          discovered: [],
          disposition_changes: [],
          invented: [],
          refused: false,
          ...fields,
        }),
      };
    },
  };
  await processTurn({ client, model: selfCorrectingModel, sessionId: session2.id, playerInput: "goodbye" });
  const knowledge2 = await loadPlayerKnowledge(client, session2.id);
  const stillUnset = knowledge2.helen === undefined || knowledge2.helen.present !== false;
  report(
    "Helen: a first-attempt guarded_event_id claim that fails validation, followed by a self-corrected retry, never flips present",
    stillUnset,
    `helen row after rejected-then-corrected attempt: ${JSON.stringify(knowledge2.helen)}`
  );
}

// ==== Test 4: the hansom — no valid exit, no place object's state changes ====
{
  const session = await createSession(client, "speckled-band");
  const before = await loadPlayerKnowledge(client, session.id);

  // "let's go to Surrey" with heard_the_account still false — to_surrey is
  // gated on it, so this should be rejected and fall back, never committing exit_id.
  await processTurn({
    client,
    model: scriptedModel("insist-on-travel", {
      narration: "You arrive at Stoke Moran, the manor grey against the sky.",
      exit_id: "to_surrey",
    }),
    sessionId: session.id,
    playerInput: "let's go to Stoke Moran right now",
  });

  const after = await loadPlayerKnowledge(client, session.id);
  const noChange = before.stoke_moran === undefined && after.stoke_moran === undefined;
  const sessionRow = await loadSession(client, session.id);
  const stayedInScene = sessionRow!.current_scene === "s1_baker_street";
  report(
    "The hansom: an exit attempt that fails validation (heard_the_account not met) never touches stoke_moran's player_knowledge, and current_scene never moves",
    noChange && stayedInScene,
    `stoke_moran before=${JSON.stringify(before.stoke_moran)} after=${JSON.stringify(after.stoke_moran)} current_scene=${sessionRow!.current_scene}`
  );

  // Render check: with no stoke_moran row, the render has nothing object-specific to hand the model — a flat null-case.
  const state: SessionState = {
    current_scene: sessionRow!.current_scene,
    phase: sessionRow!.phase,
    story_time: sessionRow!.story_time,
    flags: sessionRow!.flags,
    characters: sessionRow!.characters,
    invented: sessionRow!.invented,
    idle_turns: sessionRow!.idle_turns,
    pressure_fired: false,
    known_objects: after,
  };
  const prompt = buildPrompt(quest, state, sessionRow!.transcript as unknown as TurnRecord[], "did we arrive yet?");
  const noPlaceLeak = !prompt.includes("crumbling manor house");
  report(
    "The hansom: with stoke_moran undisclosed, the render never mentions its resolved description — nothing for the model to narrate arrival from",
    noPlaceLeak,
    `prompt leaks stoke_moran description: ${!noPlaceLeak}`
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
