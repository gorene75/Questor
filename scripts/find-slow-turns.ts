import "dotenv/config";
import { createDbClientFromEnv } from "../src/db.ts";

const client = createDbClientFromEnv();
const { data, error } = await client
  .from("turn_logs")
  .select("id, session_id, turn_index, latency_ms, model_call_ms, total_ms, model_call_count, input_tokens, output_tokens, model, created_at")
  .order("id", { ascending: false })
  .limit(40);

if (error) { console.error(error); process.exit(1); }
for (const row of data ?? []) {
  console.log(JSON.stringify(row));
}
