import { readFileSync } from "node:fs";
import { validateQuest, type Quest } from "../src/validator.ts";

const path = process.argv[2] ?? "quests/speckled-band.json";
const quest = JSON.parse(readFileSync(path, "utf-8")) as Quest;

const { errors, warnings } = validateQuest(quest);

console.log(`Validating ${path}`);
console.log(`\nErrors (${errors.length}):`);
for (const e of errors) console.log(`  - ${e}`);

console.log(`\nWarnings (${warnings.length}):`);
for (const w of warnings) console.log(`  - ${w}`);

process.exit(errors.length > 0 ? 1 : 0);
