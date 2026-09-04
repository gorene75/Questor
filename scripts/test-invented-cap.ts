// Deterministic proof of Task 4: session.invented is capped at the most
// recent 15 entries, and a re-reported (duplicate) detail doesn't inflate
// the count or get dropped early — it counts by its most recent occurrence.

import "dotenv/config";
import { createDbClientFromEnv, createSession, loadSession, upsertQuest } from "../src/db.ts";
import { validateQuest, type Quest } from "../src/validator.ts";
import { processTurn } from "../src/turn.ts";
import type { ModelAdapter } from "../src/models/index.ts";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, evidence: string) {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  console.log(`  ${evidence}`);
  if (ok) pass++;
  else fail++;
}

function scriptedModel(name: string, invented: string): ModelAdapter {
  return {
    name,
    async complete() {
      return {
        text: JSON.stringify({
          narration: "Some texture happens.",
          exit_id: null,
          guarded_event_id: null,
          discovered: [],
          disposition_changes: [],
          invented: [invented],
          refused: false,
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

// ---- Cap: 20 distinct invented details reported over 20 turns keeps only the most recent 15 ----
{
  const session = await createSession(client, "speckled-band");
  for (let i = 1; i <= 20; i++) {
    await processTurn({ client, model: scriptedModel(`texture-${i}`, `detail number ${i}`), sessionId: session.id, playerInput: "look around" });
  }
  const after = await loadSession(client, session.id);
  const invented = after!.invented;
  const ok = invented.length === 15 && invented[0] === "detail number 6" && invented[invented.length - 1] === "detail number 20";
  report(
    "20 distinct invented details over 20 turns: capped at 15, oldest dropped first",
    ok,
    `count=${invented.length} first="${invented[0]}" last="${invented[invented.length - 1]}"`
  );
}

// ---- Dedup: re-reporting the same detail doesn't create a duplicate entry ----
{
  const session = await createSession(client, "speckled-band");
  await processTurn({ client, model: scriptedModel("t1", "a cracked teacup on the mantel"), sessionId: session.id, playerInput: "look" });
  await processTurn({ client, model: scriptedModel("t2", "a low fire in the grate"), sessionId: session.id, playerInput: "look" });
  await processTurn({ client, model: scriptedModel("t3", "a cracked teacup on the mantel"), sessionId: session.id, playerInput: "look again" });
  const after = await loadSession(client, session.id);
  const invented = after!.invented;
  const occurrences = invented.filter((d) => d === "a cracked teacup on the mantel").length;
  const ok = invented.length === 2 && occurrences === 1;
  report(
    "re-reporting an identical detail doesn't duplicate it in session.invented",
    ok,
    `count=${invented.length} occurrences of the repeated detail=${occurrences} invented=${JSON.stringify(invented)}`
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
