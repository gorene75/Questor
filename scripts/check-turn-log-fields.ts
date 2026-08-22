import "dotenv/config";
import { createDbClientFromEnv, listTurnLogs } from "../src/db.ts";

const sessionId = process.argv[2]!;
const client = createDbClientFromEnv();
const logs = await listTurnLogs(client, sessionId);

for (const log of logs) {
  const parsed = log.parsed as { refused?: boolean } | null;
  console.log(`turn_index=${log.turn_index}`);
  console.log(`  prompt: ${log.prompt ? `present (${log.prompt.length} chars)` : "MISSING"}`);
  console.log(`  raw_response: ${log.raw_response ? `present (${log.raw_response.length} chars)` : "MISSING"}`);
  console.log(`  validation: ${JSON.stringify(log.validation)}`);
  console.log(`  parsed.refused: ${parsed?.refused}`);
}
