import "dotenv/config";
import { readFileSync } from "node:fs";
import { createDbClientFromEnv, createSession, listTurnLogs, upsertQuest } from "../src/db.ts";
import { selectModel, type WorkersAiBinding } from "../src/models/index.ts";
import { processTurn } from "../src/turn.ts";
import { validateQuest, type Quest } from "../src/validator.ts";

// No real Workers AI runtime exists outside `wrangler dev` (that's step 7),
// so this drives turn.ts with a scripted fake AI binding instead of a live
// model. That's deliberate: it lets us prove the engine's mechanics —
// validation, retry-with-error-appended, the double-failure fallback,
// beats, endings — deterministically, without spending on a live call.
const scriptedResponses = [
  // Turn 1: a clean, valid response.
  JSON.stringify({
    narration: "She tells you, haltingly: two years ago, a fortnight before her wedding. The door was locked from inside.",
    exit_id: null,
    discovered: ["the_death"],
    flags_set: ["heard_the_account"],
    disposition_changes: [],
    invented: [],
    refused: false,
  }),
  // Turn 2, attempt 1: a hallucinated exit id — must be rejected.
  JSON.stringify({
    narration: "You step out toward the station.",
    exit_id: "to_nonexistent_place",
    discovered: [],
    flags_set: [],
    disposition_changes: [],
    invented: [],
    refused: false,
  }),
  // Turn 2, attempt 2 (retry): valid.
  JSON.stringify({
    narration: "You decide against leaving just yet and sit back down.",
    exit_id: null,
    discovered: [],
    flags_set: [],
    disposition_changes: [],
    invented: ["A clock on the mantel ticks loudly in the quiet."],
    refused: false,
  }),
  // Turn 3, attempt 1: not JSON at all.
  "I'm not going to output JSON, sorry.",
  // Turn 3, attempt 2 (retry): still not JSON — triggers the fallback.
  "Still not JSON.",
];

let callIndex = 0;
const fakeAi: WorkersAiBinding = {
  async run(_model, _input) {
    const text = scriptedResponses[callIndex];
    callIndex++;
    return { response: text };
  },
};

const model = selectModel({
  MODEL_NAME: "@cf/scripted/fake-for-testing",
  AI: fakeAi,
});

const path = process.argv[2] ?? "quests/speckled-band.json";
const quest = JSON.parse(readFileSync(path, "utf-8")) as Quest;
const { errors } = validateQuest(quest);
if (errors.length > 0) {
  console.error(`Refusing to load an invalid quest (${errors.length} errors)`);
  process.exit(1);
}

const client = createDbClientFromEnv();
await upsertQuest(client, quest);
const session = await createSession(client, quest.meta.id);
console.log(`Session created: ${session.id} (scene=${session.current_scene}, phase=${session.phase})\n`);

async function runTurn(label: string, playerInput: string) {
  console.log(`--- ${label} ---`);
  console.log(`Player: ${playerInput}`);
  const result = await processTurn({ client, model, sessionId: session.id, playerInput });
  console.log(`Narrator: ${result.narration}`);
  console.log(
    `status=${result.status} refused=${result.refused}` +
      (result.ending ? ` ending=${result.ending.id} ("${result.ending.title}")` : "")
  );
  console.log(
    `session -> scene=${result.session.current_scene} phase=${result.session.phase} scene_turn_count=${result.session.scene_turn_count} flags_set_true=${Object.entries(result.session.flags).filter(([, v]) => v).map(([k]) => k).join(", ") || "(none)"} invented=${JSON.stringify(result.session.invented)}`
  );
  console.log("");
}

await runTurn("Turn 1: valid response", "How did your sister die?");
await runTurn("Turn 2: invalid exit_id, then valid retry", "Let's go to Surrey right now");
await runTurn("Turn 3: malformed JSON twice, fallback", "Just tell me the answer.");

console.log("--- turn_logs for this session ---");
const logs = await listTurnLogs(client, session.id);
for (const log of logs) {
  console.log(
    `turn_index=${log.turn_index} valid=${log.validation.valid}` +
      (log.validation.valid ? "" : ` errors=${JSON.stringify(log.validation.errors)}`) +
      ` raw_response=${JSON.stringify(log.raw_response).slice(0, 80)}...`
  );
}
console.log(`\nTotal turn_logs rows: ${logs.length} (expect 5: turn1=1 attempt, turn2=2 attempts, turn3=2 attempts)`);
