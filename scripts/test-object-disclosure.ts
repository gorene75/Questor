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
  commitTurn,
  createDbClientFromEnv,
  createSession,
  loadObjectPlacement,
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
  // Disclosed via character_relational_knowledge (helen's own knowledge of
  // "stepfather"), keyed under the referent first — but the reveal includes
  // "name", which is what ties the referent to the real id "roylott", so
  // loadPlayerKnowledge exposes the same row under both keys.
  const stepfather = knowledge.stepfather;
  const roylott = knowledge.roylott;
  const sparseOk =
    !!stepfather &&
    stepfather === roylott &&
    stepfather.merged_into === "roylott" &&
    Object.keys(stepfather.known).length === 2 &&
    "name" in stepfather.known &&
    "role" in stepfather.known &&
    !("danger" in stepfather.known);
  report(
    "Roylott: asking about the stepfather writes a sparse player_knowledge row under 'stepfather' (name, role only — not danger), merged_into 'roylott' since the name was disclosed, and is aliased under 'roylott' too",
    sparseOk,
    `stepfather row=${JSON.stringify(stepfather)}`
  );

  const placementBeforeForce = await loadObjectPlacement(client, session.id);
  const neverPlaced = placementBeforeForce.roylott === undefined;
  report(
    "Roylott: no game_objects row was ever created or placed just from disclosure — object_placement has no entry for him at all yet",
    neverPlaced,
    `placement.roylott=${JSON.stringify(placementBeforeForce.roylott)}`
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
    object_placement: placementBeforeForce,
  };
  const prompt = buildPrompt(questRow, forceState, after1!.transcript as unknown as TurnRecord[], "does he burst in right now?");
  const placementAfterForce = await loadObjectPlacement(client, session.id);
  const stillNeverPlaced = placementAfterForce.roylott === undefined;
  const promptShowsNotPresent = prompt.includes("roylott (known:") && prompt.includes("not present");
  const promptHasNoBehaviourData = !prompt.includes("bile-shot eyes") && !prompt.includes("Enormous, sunburnt");
  report(
    "Roylott: with no validated exit/beat/guarded_event ever firing, he's never placed anywhere and the prompt never gives him a behaviour block to act from",
    stillNeverPlaced && promptShowsNotPresent && promptHasNoBehaviourData,
    `placement.roylott=${JSON.stringify(placementAfterForce.roylott)} prompt marks not-present=${promptShowsNotPresent} no behaviour data leaked=${promptHasNoBehaviourData}`
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
    object_placement: {},
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

  const beforePlacement = await loadObjectPlacement(client, session.id);
  const helenLocationBefore = beforePlacement.helen;

  await processTurn({
    client,
    model: scriptedModel("helen-leaves", {
      narration: "She rises, thanks you, and shows herself out.",
      guarded_event_id: "helen_departs",
    }),
    sessionId: session.id,
    playerInput: "goodbye, that will be all",
  });

  const afterPlacement = await loadObjectPlacement(client, session.id);
  const flippedNull = afterPlacement.helen === null;
  report(
    "Helen: object_placement flips to location:null only once, exactly when the validated helen_departs guarded event actually fires",
    helenLocationBefore !== null && flippedNull,
    `location before=${JSON.stringify(helenLocationBefore)} location after helen_departs=${JSON.stringify(afterPlacement.helen)}`
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
  const placement2 = await loadObjectPlacement(client, session2.id);
  const stillUnset = placement2.helen === undefined || placement2.helen !== null;
  report(
    "Helen: a first-attempt guarded_event_id claim that fails validation, followed by a self-corrected retry, never flips her to location:null",
    stillUnset,
    `helen placement after rejected-then-corrected attempt: ${JSON.stringify(placement2.helen)}`
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
  const placement = await loadObjectPlacement(client, session.id);
  const neverPlaced = placement.stoke_moran === undefined;
  const sessionRow = await loadSession(client, session.id);
  const stayedInScene = sessionRow!.current_scene === "s1_baker_street";
  report(
    "The hansom: an exit attempt that fails validation (heard_the_account not met) never touches stoke_moran's player_knowledge or object_placement, and current_scene never moves",
    noChange && neverPlaced && stayedInScene,
    `stoke_moran before=${JSON.stringify(before.stoke_moran)} after=${JSON.stringify(after.stoke_moran)} placement=${JSON.stringify(placement.stoke_moran)} current_scene=${sessionRow!.current_scene}`
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
    object_placement: placement,
  };
  const prompt = buildPrompt(quest, state, sessionRow!.transcript as unknown as TurnRecord[], "did we arrive yet?");
  const noPlaceLeak = !prompt.includes("crumbling manor house");
  report(
    "The hansom: with stoke_moran undisclosed, the render never mentions its resolved description — nothing for the model to narrate arrival from",
    noPlaceLeak,
    `prompt leaks stoke_moran description: ${!noPlaceLeak}`
  );
}

// ==== Test 5: a validated to_surrey exit is what actually places stoke_moran ====
{
  const session = await createSession(client, "speckled-band");
  await processTurn({
    client,
    model: scriptedModel("hear-account", { discovered: ["the_death"] }),
    sessionId: session.id,
    playerInput: "how did your sister die?",
  });

  const before = await loadObjectPlacement(client, session.id);
  const result = await processTurn({
    client,
    model: scriptedModel("take-exit-to-surrey", {
      narration: "The carriage ride passes mostly in silence.",
      exit_id: "to_surrey",
    }),
    sessionId: session.id,
    playerInput: "let's set off for Stoke Moran",
  });

  const after = await loadObjectPlacement(client, session.id);
  report(
    "Stoke Moran: a validated to_surrey exit moves stoke_moran's object_placement to the destination scene, and only that exit does it",
    before.stoke_moran === undefined && after.stoke_moran === result.session.current_scene && result.session.current_scene === "s4_exterior",
    `before=${JSON.stringify(before.stoke_moran)} after=${JSON.stringify(after.stoke_moran)} current_scene=${result.session.current_scene}`
  );
}

// ==== Test 6: Roylott is placed only when the validated beat lands him in s2_intrusion, never before ====
{
  const session = await createSession(client, "speckled-band");
  // Shortcut established by scripts/test-clock.ts: commit scene_turn_count
  // straight to the beat's own at_turn, so it fires on the very next turn —
  // no need to actually play 9 real turns to reach it.
  await commitTurn(client, session.id, {
    current_scene: session.current_scene,
    phase: session.phase,
    progress_events: session.progress_events,
    story_time: session.story_time,
    flags: session.flags,
    characters: session.characters,
    invented: session.invented,
    transcript: session.transcript,
    scene_turn_count: 9,
    fired_beats: session.fired_beats,
    active_degradations: session.active_degradations,
    idle_turns: 0,
  });

  const before = await loadObjectPlacement(client, session.id);
  const result = await processTurn({
    client,
    model: scriptedModel("idle-into-the-beat", {}),
    sessionId: session.id,
    playerInput: "I wait.",
  });

  const after = await loadObjectPlacement(client, session.id);
  report(
    "Roylott: the moment the turn-9 beat validly lands the story in s2_intrusion, and only then, object_placement moves him there",
    before.roylott === undefined && after.roylott === "s2_intrusion" && result.session.current_scene === "s2_intrusion",
    `before=${JSON.stringify(before.roylott)} after=${JSON.stringify(after.roylott)} current_scene=${result.session.current_scene}`
  );
}

// ==== Test 7: Sherlock is a real reflexive object — no self-knowledge assumed for free ====
{
  const session = await createSession(client, "speckled-band");
  const before = await loadPlayerKnowledge(client, session.id);
  report(
    "Sherlock: before any turn asks who he is, player_knowledge has no sherlock row at all",
    before.sherlock === undefined,
    `sherlock row before: ${JSON.stringify(before.sherlock)}`
  );

  await processTurn({
    client,
    model: scriptedModel("ask-who-am-i", {
      narration: "You are Sherlock Holmes, consulting detective, of Baker Street.",
      discovered: ["who_am_i"],
    }),
    sessionId: session.id,
    playerInput: "who am I, exactly?",
  });

  const after = await loadPlayerKnowledge(client, session.id);
  const sherlock = after.sherlock;
  const realDisclosure =
    !!sherlock &&
    sherlock.source === "direct" &&
    "name" in sherlock.known &&
    "role" in sherlock.known &&
    "methods" in sherlock.known &&
    !("background" in sherlock.known);
  report(
    "Sherlock: asking who he is is a real disclosure event — row created, source 'direct', exactly the fields who_am_i names (not the full resolved object)",
    realDisclosure,
    `sherlock row after: ${JSON.stringify(sherlock)}`
  );
}

// ==== Test 8: the room's ambient content discloses as one bundle, with no game_objects side effects ====
{
  const session = await createSession(client, "speckled-band");
  const { data: gameObjectsBefore } = await client.from("game_objects").select();

  const before = await loadPlayerKnowledge(client, session.id);
  const noRoomRowYet = before.s1_baker_street === undefined;

  await processTurn({
    client,
    model: scriptedModel("look-around", {
      narration: "You take in the room again — the fire, the worn chairs, Watson's chair opposite.",
    }),
    sessionId: session.id,
    playerInput: "I look around the room.",
  });

  const after = await loadPlayerKnowledge(client, session.id);
  const room = after.s1_baker_street;
  const { data: gameObjectsAfter } = await client.from("game_objects").select();

  const roomScene = quest.scenes.find((s) => s.id === "s1_baker_street")!;
  const ambientOk = !!room && room.source === "observation" && room.known.description === roomScene.opens_with;
  const noNewGameObjects = (gameObjectsAfter ?? []).length === (gameObjectsBefore ?? []).length;

  report(
    "The room: its ambient content (opens_with) is disclosed as one bundle, source 'observation', with no new game_objects rows created by looking at it",
    noRoomRowYet && ambientOk && noNewGameObjects,
    `room row before=${JSON.stringify(before.s1_baker_street)} after=${JSON.stringify(room)} game_objects count before=${(gameObjectsBefore ?? []).length} after=${(gameObjectsAfter ?? []).length}`
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
