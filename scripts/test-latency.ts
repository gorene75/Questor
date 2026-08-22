// Takes 5 live turns on Claude Haiku via the real HTTP layer, then pulls the
// timing breakdown for each from turn_logs. One-off harness for Fix 2.

export {};

import "dotenv/config";
import { createDbClientFromEnv, listTurnLogs } from "../src/db.ts";

const BASE = process.argv[2] ?? "http://localhost:8787";
const MODEL = process.argv[3] ?? "claude-haiku-4-5-20251001";

interface TurnResponse {
  narration: string;
  status: string;
  refused: boolean;
}

async function createSession(): Promise<{ session_id: string }> {
  const res = await fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quest_id: "speckled-band", model_name: MODEL }),
  });
  const data = (await res.json()) as { session_id: string };
  if (!res.ok) throw new Error(`POST /session failed: ${JSON.stringify(data)}`);
  return data;
}

async function takeTurn(sessionId: string, input: string): Promise<TurnResponse> {
  const res = await fetch(`${BASE}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, input }),
  });
  const data = (await res.json()) as TurnResponse;
  if (!res.ok) throw new Error(`POST /turn failed: ${JSON.stringify(data)}`);
  return data;
}

const inputs = [
  "How did your sister die?",
  "What made you come here today?",
  "Tell me about the sounds at night.",
  "Why did you change bedrooms?",
  "What do you make of your stepfather?",
];

const { session_id } = await createSession();
console.log(`Session: ${session_id} (model: ${MODEL})\n`);

for (const input of inputs) {
  const start = Date.now();
  const result = await takeTurn(session_id, input);
  const wallMs = Date.now() - start;
  console.log(`> ${input}`);
  console.log(`  <- ${result.narration}`);
  console.log(`  (wall-clock round trip: ${wallMs}ms)\n`);
}

console.log("--- timing breakdown from turn_logs ---\n");
const client = createDbClientFromEnv();
const logs = await listTurnLogs(client, session_id);

// De-dupe to one row per turn_index (aggregates are identical across retries for the same turn).
const seen = new Set<number>();
for (const log of logs) {
  if (seen.has(log.turn_index)) continue;
  seen.add(log.turn_index);
  console.log(
    `turn_index=${log.turn_index}  total_ms=${log.total_ms}  model_call_ms=${log.model_call_ms}  validation_ms=${log.validation_ms}  db_commit_ms=${log.db_commit_ms}  model_call_count=${log.model_call_count}`
  );
}
