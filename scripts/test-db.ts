import "dotenv/config";
import { readFileSync } from "node:fs";
import { createDbClientFromEnv, createSession, loadSession, upsertQuest } from "../src/db.ts";
import { validateQuest, type Quest } from "../src/validator.ts";

const path = process.argv[2] ?? "quests/speckled-band.json";
const quest = JSON.parse(readFileSync(path, "utf-8")) as Quest;

const { errors } = validateQuest(quest);
if (errors.length > 0) {
  console.error(`Refusing to load an invalid quest (${errors.length} errors):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const client = createDbClientFromEnv();

console.log(`Upserting quest '${quest.meta.id}'...`);
const questRow = await upsertQuest(client, quest);
console.log(`  stored as id='${questRow.id}' version=${questRow.version}`);

console.log(`Creating session...`);
const session = await createSession(client, quest.meta.id);
console.log(`  session id: ${session.id}`);

console.log(`Loading session back by id...`);
const loaded = await loadSession(client, session.id);

console.log("\n--- session row ---");
console.log(JSON.stringify(loaded, null, 2));
