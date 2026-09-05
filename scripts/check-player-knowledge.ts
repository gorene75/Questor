import "dotenv/config";
import { createDbClientFromEnv, loadPlayerKnowledge } from "../src/db.ts";
const sessionId = process.argv[2]!;
const client = createDbClientFromEnv();
const knowledge = await loadPlayerKnowledge(client, sessionId);
console.log(JSON.stringify(knowledge, null, 2));
