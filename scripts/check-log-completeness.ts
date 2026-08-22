import "dotenv/config";
import { createDbClientFromEnv, listTurnLogs } from "../src/db.ts";

const client = createDbClientFromEnv();
const sessionIds = process.argv.slice(2);

let totalRows = 0;
let incomplete = 0;

for (const sessionId of sessionIds) {
  const logs = await listTurnLogs(client, sessionId);
  totalRows += logs.length;
  for (const log of logs) {
    const missing: string[] = [];
    if (!log.prompt) missing.push("prompt");
    if (!log.raw_response) missing.push("raw_response");
    if (log.validation === null || log.validation === undefined) missing.push("validation");
    if (missing.length > 0) {
      incomplete++;
      console.log(`  session=${sessionId} turn_index=${log.turn_index} MISSING: ${missing.join(", ")}`);
    }
  }
  console.log(`session ${sessionId}: ${logs.length} rows checked`);
}

console.log(`\n[${incomplete === 0 ? "PASS" : "FAIL"}] Test 11: every turn_logs row across ${sessionIds.length} sessions (${totalRows} rows total) has prompt, raw_response, and validation`);
