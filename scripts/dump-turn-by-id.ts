import "dotenv/config";
import { createDbClientFromEnv, listTurnLogs } from "../src/db.ts";
const sessionId = process.argv[2]!;
const logId = Number(process.argv[3]);
const client = createDbClientFromEnv();
const logs = await listTurnLogs(client, sessionId);
const row = logs.find((r) => r.id === logId)!;
console.log(row.prompt);
