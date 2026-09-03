// Deterministic proof of Fix 3: s1_baker_street's discoverables now form a
// real dependency chain (the_death -> the_move -> the_whistle -> {dying_words,
// tonight}), gated on flags the engine validates — not just on Helen's
// disposition, which the model could previously rush up independent of
// which discoverables had actually fired. This proves the flag gate holds
// even when disposition is artificially maxed out, which is exactly the
// loophole that made the old gating "nominal" rather than real.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { createDbClientFromEnv, createSession, commitTurn, loadSession, upsertQuest } from "../src/db.ts";
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

function modelDiscovering(name: string, id: string): ModelAdapter {
  let attempt = 0;
  return {
    name,
    async complete() {
      attempt++;
      return {
        text: JSON.stringify({
          narration: attempt === 1 ? `She tells you about ${id}.` : `She tells you about ${id}, again.`,
          exit_id: null,
          guarded_event_id: null,
          discovered: [id],
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

const client = createDbClientFromEnv();
await upsertQuest(client, quest);

// ---- Test A: disposition maxed to 'trusting', but the flag chain is empty — everything downstream still rejected ----
{
  const session = await createSession(client, "speckled-band");
  await commitTurn(client, session.id, {
    current_scene: "s1_baker_street",
    phase: session.phase,
    progress_events: session.progress_events,
    story_time: session.story_time,
    flags: session.flags, // heard_the_account, knows_about_move, knows_the_whistle all still false
    characters: { helen: "trusting" }, // artificially maxed — the old loophole this fix closes
    invented: session.invented,
    transcript: session.transcript,
    scene_turn_count: 0,
    fired_beats: session.fired_beats,
    active_degradations: session.active_degradations,
    idle_turns: 0,
  });

  const moveResult = await processTurn({ client, model: modelDiscovering("adversarial:move-too-early", "the_move"), sessionId: session.id, playerInput: "Why did you change rooms?" });
  const whistleResult = await processTurn({ client, model: modelDiscovering("adversarial:whistle-too-early", "the_whistle"), sessionId: session.id, playerInput: "What sounds have you heard?" });
  const dyingWordsResult = await processTurn({ client, model: modelDiscovering("adversarial:dying-words-too-early", "dying_words"), sessionId: session.id, playerInput: "What did she say at the end?" });
  const tonightResult = await processTurn({ client, model: modelDiscovering("adversarial:tonight-too-early", "tonight"), sessionId: session.id, playerInput: "What do you expect tonight?" });
  const after = await loadSession(client, session.id);

  const ok =
    after!.flags.knows_about_move === false &&
    after!.flags.knows_the_whistle === false &&
    moveResult.narration === "The moment passes without incident." &&
    whistleResult.narration === "The moment passes without incident." &&
    dyingWordsResult.narration === "The moment passes without incident." &&
    tonightResult.narration === "The moment passes without incident.";
  report(
    "A: with Helen's disposition artificially maxed at 'trusting' but heard_the_account still false, the_move/the_whistle/dying_words/tonight are all still rejected — the chain is a real, independent gate",
    ok,
    `knows_about_move=${after!.flags.knows_about_move} knows_the_whistle=${after!.flags.knows_the_whistle} ` +
      `move="${moveResult.narration}" whistle="${whistleResult.narration}" dying_words="${dyingWordsResult.narration}" tonight="${tonightResult.narration}"`
  );
}

// ---- Test B: walking the chain in order, with disposition already maxed, unlocks each step exactly once its prerequisite is met ----
{
  const session = await createSession(client, "speckled-band");
  await commitTurn(client, session.id, {
    current_scene: "s1_baker_street",
    phase: session.phase,
    progress_events: session.progress_events,
    story_time: session.story_time,
    flags: session.flags,
    characters: { helen: "trusting" },
    invented: session.invented,
    transcript: session.transcript,
    scene_turn_count: 0,
    fired_beats: session.fired_beats,
    active_degradations: session.active_degradations,
    idle_turns: 0,
  });

  const death = await processTurn({ client, model: modelDiscovering("chain:the_death", "the_death"), sessionId: session.id, playerInput: "How did your sister die?" });
  const move = await processTurn({ client, model: modelDiscovering("chain:the_move", "the_move"), sessionId: session.id, playerInput: "Why did you change rooms?" });
  const whistle = await processTurn({ client, model: modelDiscovering("chain:the_whistle", "the_whistle"), sessionId: session.id, playerInput: "What sounds have you heard?" });
  const dyingWords = await processTurn({ client, model: modelDiscovering("chain:dying_words", "dying_words"), sessionId: session.id, playerInput: "What did she say at the end?" });
  const tonight = await processTurn({ client, model: modelDiscovering("chain:tonight", "tonight"), sessionId: session.id, playerInput: "What do you expect tonight?" });
  const after = await loadSession(client, session.id);

  const ok =
    after!.flags.heard_the_account === true &&
    after!.flags.knows_about_move === true &&
    after!.flags.knows_the_whistle === true &&
    death.narration === "She tells you about the_death." &&
    move.narration === "She tells you about the_move." &&
    whistle.narration === "She tells you about the_whistle." &&
    dyingWords.narration === "She tells you about dying_words." &&
    tonight.narration === "She tells you about tonight.";
  report(
    "B: walked in dependency order, each discoverable unlocks exactly when its prerequisite is met, all five succeed on the first attempt",
    ok,
    `heard_the_account=${after!.flags.heard_the_account} knows_about_move=${after!.flags.knows_about_move} knows_the_whistle=${after!.flags.knows_the_whistle} ` +
      `narrations=[${[death, move, whistle, dyingWords, tonight].map((r) => `"${r.narration}"`).join(", ")}]`
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
