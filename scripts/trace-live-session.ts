import "dotenv/config";
import { createDbClientFromEnv, listTurnLogs, loadSession } from "../src/db.ts";

const sessionId = process.argv[2]!;
const client = createDbClientFromEnv();

const session = await loadSession(client, sessionId);
console.log(`session model_name (column): ${JSON.stringify(session?.model_name)}`);
console.log(`session status: ${session?.status} current_scene: ${session?.current_scene}`);
console.log("");

const logs = await listTurnLogs(client, sessionId);
for (const log of logs) {
  console.log(`===== turn_index=${log.turn_index} id=${log.id} created_at=${log.created_at} =====`);
  console.log(`  model=${log.model}`);
  console.log(`  valid=${log.validation.valid} errors=${JSON.stringify(log.validation.errors)}`);
  console.log(`  latency_ms(this attempt)=${log.latency_ms} model_call_ms(turn total)=${log.model_call_ms} validation_ms=${log.validation_ms} db_commit_ms=${log.db_commit_ms} total_ms=${log.total_ms} model_call_count=${log.model_call_count}`);
  console.log(`  input_tokens=${log.input_tokens} output_tokens=${log.output_tokens}`);
  console.log(`  raw_response: ${log.raw_response}`);
  const parsed = log.parsed as Record<string, unknown> | null;
  if (parsed) {
    console.log(`  parsed.narration_implies_departure=${JSON.stringify(parsed.narration_implies_departure)}`);
    console.log(`  parsed.exit_id=${JSON.stringify(parsed.exit_id)}`);
    console.log(`  parsed.discovered=${JSON.stringify(parsed.discovered)}`);
    console.log(`  parsed.narration=${JSON.stringify(parsed.narration)}`);
  }

  const promptStr = log.prompt;
  const systemMatch = promptStr.match(/^\[SYSTEM\]\n([\s\S]*?)\n\n\[USER\]\n([\s\S]*)$/);
  if (systemMatch) {
    const systemPart = systemMatch[1]!;
    const userPart = systemMatch[2]!;
    console.log(`  prompt: system_len=${systemPart.length} chars, user_len=${userPart.length} chars`);
    console.log(`  user_part (verbatim): ${JSON.stringify(userPart)}`);
  } else {
    console.log(`  prompt: could not split system/user, total_len=${promptStr.length}`);
    console.log(`  prompt head: ${promptStr.slice(0, 300)}`);
  }
  console.log("");
}
