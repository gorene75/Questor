import "dotenv/config";
import { createDbClientFromEnv, listTurnLogs } from "../src/db.ts";

const client = createDbClientFromEnv();
const logs = await listTurnLogs(client, process.argv[2]!);
for (const l of logs.filter((l) => !l.validation.valid)) {
  console.log(`turn_index=${l.turn_index}: ${l.raw_response.slice(0, 100).replace(/\n/g, " ")}...`);
}
