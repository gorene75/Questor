import "dotenv/config";
import { createDbClientFromEnv } from "../src/db.ts";

const client = createDbClientFromEnv();
const { data, error } = await client
  .from("sessions")
  .select("id, quest_id, current_scene, status, model_name, created_at, updated_at")
  .order("updated_at", { ascending: false })
  .limit(8);

if (error) {
  console.error("Query failed:", error.message);
  process.exit(1);
}

for (const row of data ?? []) {
  console.log(JSON.stringify(row));
}
