import "dotenv/config";
import { createDbClientFromEnv, listTurnLogs } from "../src/db.ts";

const sessionIds = process.argv.slice(2);
const client = createDbClientFromEnv();

for (const sessionId of sessionIds) {
  const logs = await listTurnLogs(client, sessionId);
  const validLogs = logs.filter((l) => l.validation.valid);
  const withDiscovered = validLogs.filter((l) => {
    const parsed = l.parsed as { discovered?: unknown[] } | null;
    return Array.isArray(parsed?.discovered) && parsed.discovered.length > 0;
  });
  const withFlagsSet = validLogs.filter((l) => {
    const parsed = l.parsed as { flags_set?: unknown[] } | null;
    return Array.isArray(parsed?.flags_set) && parsed.flags_set.length > 0;
  });
  const invalidLogs = logs.filter((l) => !l.validation.valid);

  console.log(`\nSession ${sessionId}: model=${logs[0]?.model ?? "?"}`);
  console.log(`  total turn_logs rows: ${logs.length}`);
  console.log(`  valid (accepted) responses: ${validLogs.length}`);
  console.log(`  invalid/rejected attempts: ${invalidLogs.length}`);
  console.log(`  valid responses with non-empty discovered: ${withDiscovered.length} / ${validLogs.length}`);
  console.log(`  valid responses with non-empty flags_set: ${withFlagsSet.length} / ${validLogs.length}`);
  if (invalidLogs.length > 0) {
    console.log(`  invalid attempt errors: ${JSON.stringify(invalidLogs.map((l) => l.validation.errors))}`);
  }
}
