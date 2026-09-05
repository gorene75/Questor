import "dotenv/config";
import { createDbClientFromEnv, createSession, loadPlayerKnowledge } from "../src/db.ts";

const client = createDbClientFromEnv();
const session = await createSession(client, "speckled-band");

for (let i = 0; i < 5; i++) {
  const start = Date.now();
  await loadPlayerKnowledge(client, session.id);
  console.log(`loadPlayerKnowledge call ${i + 1}: ${Date.now() - start}ms`);
}
