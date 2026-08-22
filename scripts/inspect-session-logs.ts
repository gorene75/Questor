import "dotenv/config";
import { createDbClientFromEnv, listTurnLogs } from "../src/db.ts";

const sessionId = process.argv[2]!;
const client = createDbClientFromEnv();
const logs = await listTurnLogs(client, sessionId);

for (const log of logs) {
  const parsed = log.parsed as {
    exit_id?: string | null;
    guarded_event_id?: string | null;
    discovered?: string[];
    flags_set?: string[];
    refused?: boolean;
    narration?: string;
  } | null;
  console.log(`turn_index=${log.turn_index} valid=${log.validation.valid}`);
  if (!log.validation.valid) {
    console.log(`  errors: ${JSON.stringify(log.validation.errors)}`);
  }
  if (parsed) {
    console.log(
      `  exit_id=${parsed.exit_id} guarded_event_id=${parsed.guarded_event_id} discovered=${JSON.stringify(parsed.discovered)} flags_set=${JSON.stringify(parsed.flags_set)} refused=${parsed.refused}`
    );
  }
}
