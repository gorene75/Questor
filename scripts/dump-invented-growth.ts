import "dotenv/config";
import { createDbClientFromEnv, listTurnLogs } from "../src/db.ts";
import { splitActualPrompt } from "./lib/prompt-sections.ts";

const sessionId = process.argv[2]!;
const client = createDbClientFromEnv();
const logs = (await listTurnLogs(client, sessionId)).filter((l) => l.validation.valid);

for (const log of logs) {
  const m = log.prompt.match(/^\[SYSTEM\]\n([\s\S]*?)\n\n\[USER\]/);
  if (!m) continue;
  const s = splitActualPrompt(m[1]!);
  const inventedLen = s.sections.INVENTED?.length ?? 0;
  const inventedCount = (s.sections.INVENTED?.match(/^- /gm) ?? []).length;
  console.log(`turn_index=${log.turn_index}: INVENTED = ${inventedLen} chars, ${inventedCount} entries, total_prompt=${s.fullLength} chars`);
}
console.log("\nFinal INVENTED content:");
const last = logs[logs.length - 1]!;
const m = last.prompt.match(/^\[SYSTEM\]\n([\s\S]*?)\n\n\[USER\]/);
const s = splitActualPrompt(m![1]!);
console.log(s.sections.INVENTED);
