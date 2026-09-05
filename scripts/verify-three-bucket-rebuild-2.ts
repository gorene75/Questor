import "dotenv/config";
import { readFileSync } from "node:fs";
import { createDbClientFromEnv, createSession, loadPlayerKnowledge, loadObjectPlacement, upsertQuest, type DbClient } from "../src/db.ts";
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
const client: DbClient = createDbClientFromEnv();
await upsertQuest(client, quest);

// ==== Test 3: Helen departs — stops appearing in CHARACTERS the SAME turn ====
{
  const session = await createSession(client, "speckled-band");
  await processTurn({
    client,
    model: scriptedModel("hear-account", { discovered: ["the_death"] }),
    sessionId: session.id,
    playerInput: "how did your sister die?",
  });

  const result = await processTurn({
    client,
    model: scriptedModel("helen-leaves", { narration: "She rises, thanks you, and shows herself out.", guarded_event_id: "helen_departs" }),
    sessionId: session.id,
    playerInput: "goodbye, that will be all",
  });

  // Rebuild the EXACT next prompt that would be sent (same turn's resulting state).
  const knowledge = await loadPlayerKnowledge(client, session.id);
  const placement = await loadObjectPlacement(client, session.id);
  const state: SessionState = {
    current_scene: result.session.current_scene,
    phase: result.session.phase,
    story_time: result.session.story_time,
    flags: result.session.flags,
    characters: result.session.characters,
    invented: result.session.invented,
    idle_turns: result.session.idle_turns,
    pressure_fired: false,
    known_objects: knowledge,
    object_placement: placement,
  };
  const nextPrompt = buildPrompt(quest, state, result.session.transcript as unknown as TurnRecord[], "are you still there?");
  const helenGone = !nextPrompt.includes("### Helen Stoner (helen)");
  const watsonStillThere = nextPrompt.includes("### Dr Watson (watson)");
  report(
    "Test 3: Helen departs (helen_departs fires, placement -> null) — she stops appearing with a full behaviour block in CHARACTERS on the very next prompt, same turn's effect",
    helenGone && watsonStillThere,
    `helen block absent: ${helenGone}, watson still present: ${watsonStillThere}, placement.helen=${JSON.stringify(placement.helen)}`
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
