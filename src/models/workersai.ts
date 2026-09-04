import type { ModelAdapter, WorkersAiBinding } from "./index.ts";

interface OpenAiStyleResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface LlamaStyleResponse {
  response?: string;
}

// Workers AI models disagree on response shape: older Llama-family models
// return { response: string }; newer OpenAI-compatible models (gpt-oss, etc.)
// return an OpenAI chat-completion object with choices[0].message.content.
function extractText(result: unknown): string {
  if (typeof result === "string") return result;

  if (result && typeof result === "object") {
    const openAiStyle = result as OpenAiStyleResponse;
    const content = openAiStyle.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;

    const llamaStyle = result as LlamaStyleResponse;
    if (typeof llamaStyle.response === "string") return llamaStyle.response;
  }

  throw new Error(`Unexpected Workers AI response shape: ${JSON.stringify(result)}`);
}

function extractUsage(result: unknown): { inputTokens?: number; outputTokens?: number } {
  if (result && typeof result === "object" && "usage" in result) {
    const usage = (result as OpenAiStyleResponse).usage;
    return { inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens };
  }
  return {};
}

export function createWorkersAiAdapter(ai: WorkersAiBinding, model: string): ModelAdapter {
  return {
    name: `workersai:${model}`,
    async complete(systemStatic: string, systemDynamic: string, user: string) {
      // No caching support here — the split only matters to adapters that
      // have a cache breakpoint to put between the two halves.
      const result = await ai.run(model, {
        messages: [
          { role: "system", content: `${systemStatic}\n\n${systemDynamic}` },
          { role: "user", content: user },
        ],
        // Reasoning-style models (e.g. gpt-oss) spend part of this budget on
        // hidden reasoning_content before the actual answer — too low a cap
        // truncates the JSON output before it's ever reached.
        max_tokens: 2048,
      });

      return { text: extractText(result), ...extractUsage(result) };
    },
  };
}
