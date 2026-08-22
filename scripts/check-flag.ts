import "dotenv/config";
import { createDbClientFromEnv, loadSession } from "../src/db.ts";

const client = createDbClientFromEnv();
const s = await loadSession(client, process.argv[2]!);
console.log("heard_the_account:", s?.flags.heard_the_account);
