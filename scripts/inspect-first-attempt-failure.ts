import "dotenv/config";
import { createDbClientFromEnv, listTurnLogs } from "../src/db.ts";

const client = createDbClientFromEnv();
const logs = await listTurnLogs(client, process.argv[2]!);

const firstFailure = logs.find((l) => !l.validation.valid);
if (!firstFailure) {
  console.log("No failed first attempts found in this session.");
  process.exit(0);
}

console.log(`turn_index=${firstFailure.turn_index}`);
console.log(`errors: ${JSON.stringify(firstFailure.validation.errors)}`);
console.log(`raw_response length: ${firstFailure.raw_response.length}`);
console.log(`--- raw_response (full) ---`);
console.log(firstFailure.raw_response);
console.log(`--- end raw_response ---`);
