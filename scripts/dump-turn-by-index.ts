import "dotenv/config";
import { createDbClientFromEnv, listTurnLogs } from "../src/db.ts";

const sessionId = process.argv[2]!;
const turnIndex = Number(process.argv[3]);
const client = createDbClientFromEnv();
const logs = (await listTurnLogs(client, sessionId)).filter((l) => l.validation.valid);
const row = logs.find((r) => r.turn_index === turnIndex)!;
console.log(row.prompt);
