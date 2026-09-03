import "dotenv/config";
import { createDbClientFromEnv, listTurnLogs } from "../src/db.ts";

const sessionId = process.argv[2]!;
const turnIndex = Number(process.argv[3]);
const client = createDbClientFromEnv();

const logs = await listTurnLogs(client, sessionId);
const row = logs.filter((r) => r.turn_index === turnIndex).pop()!;
console.log(row.prompt);
