// Verifies prompt caching is actually wired correctly in the CURRENT code —
// uses the real, exported buildPromptParts (not a hand-reconstruction) for a
// few sequential turns of a real session, calls the live Anthropic API with
// the exact same cache_control structure src/models/anthropic.ts now uses,
// and reports cache_creation vs cache_read tokens per turn directly from
// the API's own usage object.
import "dotenv/config";
import { createDbClientFromEnv, createSession, loadSession, loadQuestByVersion, upsertQuest } from "../src/db.ts";
import { readFileSync } from "node:fs";
import { validateQuest, type Quest } from "../src/validator.ts";
import { buildPromptParts, type SessionState, type TurnRecord } from "../src/prompt.ts";
import { processTurn } from "../src/turn.ts";
import type { ModelAdapter } from "../src/models/index.ts";

const client = createDbClientFromEnv();
const quest = JSON.parse(readFileSync("quests/speckled-band.json", "utf-8")) as Quest;
const { errors } = validateQuest(quest);
if (errors.length > 0) throw new Error(`Quest invalid: ${JSON.stringify(errors)}`);
await upsertQuest(client, quest);

// Play a short real session with a scripted fake model, purely to get real,
// progressively-different session states/history to build real prompts from.
function scriptedModel(): ModelAdapter {
  const narrations = [
    "She lowers her eyes to her gloves and begins.",
    "Her hands go still. She does not answer directly.",
    "Watson glances up, offers nothing useful.",
    "She considers the question a long moment.",
  ];
  let i = 0;
  return {
    name: "scripted",
    async complete() {
      const text = JSON.stringify({
        narration: narrations[Math.min(i, narrations.length - 1)],
        exit_id: null,
        guarded_event_id: null,
        discovered: i === 0 ? ["the_death"] : [],
        disposition_changes: [],
        invented: [],
        refused: false,
      });
      i++;
      return { text };
    },
  };
}

const session = await createSession(client, "speckled-band");
const model = scriptedModel();
const inputs = ["tell me about your sister", "does she have any bruises?", "what should I do?", "tell me about the move"];
for (const input of inputs) {
  await processTurn({ client, model, sessionId: session.id, playerInput: input });
}

// Now rebuild the REAL prompt for each point in that session's history using
// the real, exported buildPromptParts, and call the live API directly with
// the same cache_control structure the adapter uses.
async function callAnthropic(systemStatic: string, systemDynamic: string, user: string) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 800,
      system: [
        { type: "text", text: systemStatic, cache_control: { type: "ephemeral" } },
        { type: "text", text: systemDynamic },
      ],
      messages: [{ role: "user", content: user }],
      thinking: { type: "disabled" },
    }),
  });
  const data = (await res.json()) as any;
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.usage;
}

const finalSession = await loadSession(client, session.id);
const questRow = await loadQuestByVersion(client, finalSession!.quest_id, finalSession!.quest_version);
const fullHistory = finalSession!.transcript as unknown as TurnRecord[];

console.log(`Replaying ${fullHistory.length} real turn-states through buildPromptParts + live cache_control call\n`);
for (let i = 0; i < fullHistory.length; i++) {
  const historyBefore = fullHistory.slice(0, i);
  const sessionState: SessionState = {
    current_scene: finalSession!.current_scene, // approximation: fine for this check, which only cares about static-block cache stability
    phase: "morning",
    story_time: null,
    flags: { ...quest.flags },
    characters: {},
    invented: [],
    idle_turns: 0,
    pressure_fired: false,
  };
  const { systemStatic, systemDynamic, user } = buildPromptParts(questRow!.graph, sessionState, historyBefore, inputs[i]!);
  const usage = await callAnthropic(systemStatic, systemDynamic, user);
  console.log(
    `turn ${i}: input_tokens=${usage.input_tokens} cache_read=${usage.cache_read_input_tokens ?? 0} cache_write=${usage.cache_creation_input_tokens ?? 0} (static block: ${systemStatic.length} chars)`
  );
}
