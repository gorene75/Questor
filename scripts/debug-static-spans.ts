import "dotenv/config";
import { createDbClientFromEnv, listTurnLogs } from "../src/db.ts";
import { splitActualPrompt } from "./lib/prompt-sections.ts";

const sessionId = process.argv[2]!;
const client = createDbClientFromEnv();
const logs = (await listTurnLogs(client, sessionId)).filter((l) => l.validation.valid);
const log = logs[0]!;
const m = log.prompt.match(/^\[SYSTEM\]\n([\s\S]*?)\n\n\[USER\]/);
const s = splitActualPrompt(m![1]!);
console.log("staticSpans count:", s.staticSpans.length);
s.staticSpans.forEach((sp, i) => console.log(`  span[${i}]: ${sp.length} chars`));
console.log("section names:", Object.keys(s.sections));
console.log("totalStaticChars:", s.totalStaticChars, "fullLength:", s.fullLength);
