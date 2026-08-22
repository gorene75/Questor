import "dotenv/config";
import { createDbClientFromEnv, listTurnLogs, loadSession } from "../src/db.ts";

const sessionId = process.argv[2]!;
const client = createDbClientFromEnv();

const session = await loadSession(client, sessionId);
if (!session) throw new Error("session not found");

console.log(`Session ${sessionId}`);
console.log(`Final invented list: ${JSON.stringify(session.invented, null, 2)}`);

if (session.invented.length === 0) {
  console.log("No invented details in this session — pick a different one.");
  process.exit(1);
}

const earlyDetail = session.invented[0]!;
console.log(`\nChecking whether the first invented detail is still fed into later prompts:`);
console.log(`  "${earlyDetail}"`);

const logs = await listTurnLogs(client, sessionId);
console.log(`\nTotal logged turns: ${logs.length}`);

const lastLog = logs[logs.length - 1]!;
const containsDetail = lastLog.prompt.includes(earlyDetail);

console.log(`Last logged turn_index: ${lastLog.turn_index}`);
console.log(`[${containsDetail ? "PASS" : "FAIL"}] Test 10: early-invented detail is still present in the final turn's prompt`);

// Also report how many turns separate the first appearance from the last prompt.
const firstAppearance = logs.findIndex((l) => (l.parsed as { invented?: string[] } | null)?.invented?.includes(earlyDetail));
console.log(`First invented at turn_index=${firstAppearance >= 0 ? logs[firstAppearance]!.turn_index : "?"}, still present through turn_index=${lastLog.turn_index}`);
