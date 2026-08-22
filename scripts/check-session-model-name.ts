import "dotenv/config";
import { createDbClientFromEnv, loadSession } from "../src/db.ts";

const client = createDbClientFromEnv();
for (const id of process.argv.slice(2)) {
  const s = await loadSession(client, id);
  console.log(`${id} -> model_name column: ${JSON.stringify(s?.model_name)}`);
}
