import "dotenv/config";
import { selectModel, type WorkersAiBinding } from "../src/models/index.ts";

const system =
  "You are a test harness. Reply with strict JSON only, no prose, no code fences: " +
  '{"ok": true, "note": "<a short string of your choosing>"}';
const user = "Confirm the adapter round-trip is working.";

console.log(`MODEL_NAME=${process.env.MODEL_NAME}`);

console.log("\n--- live call via selectModel() (provider inferred from MODEL_NAME, from .env) ---");
const model = selectModel({
  MODEL_NAME: process.env.MODEL_NAME ?? "",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
});
console.log(`adapter: ${model.name}`);
try {
  const result = await model.complete(system, "", user);
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.log(`  (skipped: ${err instanceof Error ? err.message : String(err)})`);
}

// No real Workers AI binding exists outside the Workers runtime, so this
// exercises the adapter's response-parsing against a fake binding instead —
// proving createWorkersAiAdapter is wired correctly without needing wrangler.
console.log("\n--- workersai adapter, against a fake AI binding (response-parsing only) ---");
const fakeAi: WorkersAiBinding = {
  async run(runModel, input) {
    console.log(`  fake AI.run called with model='${runModel}'`);
    console.log(`  input.messages: ${JSON.stringify((input as { messages: unknown }).messages)}`);
    return { response: "This is a fake Workers AI reply." };
  },
};
const workersModel = selectModel({
  MODEL_NAME: "@cf/meta/llama-3.1-8b-instruct",
  AI: fakeAi,
});
console.log(`adapter: ${workersModel.name}`);
const workersResult = await workersModel.complete(system, "", user);
console.log(JSON.stringify(workersResult, null, 2));
