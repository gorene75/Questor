import "dotenv/config";
import { createDbClientFromEnv, listTurnLogs } from "../src/db.ts";

const client = createDbClientFromEnv();
const logs = await listTurnLogs(client, process.argv[2]!);
const target = logs.find((l) => l.turn_index === Number(process.argv[3]) && !l.validation.valid);
if (!target) {
  console.log("not found");
  process.exit(1);
}
console.log(`errors: ${JSON.stringify(target.validation.errors)}`);
console.log(`--- raw_response ---`);
console.log(target.raw_response);
console.log(`--- end ---`);
