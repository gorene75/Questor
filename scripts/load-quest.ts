import "dotenv/config";
import { readFileSync } from "node:fs";
import { createDbClientFromEnv, upsertQuest } from "../src/db.ts";
import { validateQuest, type Quest } from "../src/validator.ts";

const path = process.argv[2] ?? "quests/speckled-band.json";
const quest = JSON.parse(readFileSync(path, "utf-8")) as Quest;

const { errors, warnings } = validateQuest(quest);

console.log(`Validating ${path}`);
if (errors.length > 0) {
  console.error(`\n${errors.length} error(s) — refusing to load:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`Errors: 0`);
console.log(`Warnings: ${warnings.length}`);
for (const w of warnings) console.log(`  - ${w}`);

const client = createDbClientFromEnv();
const row = await upsertQuest(client, quest);
console.log(`\nLoaded '${row.id}' version ${row.version} into the quests table.`);
