import type { ModelAdapter } from "./index.ts";

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  usage?: { input_tokens: number; output_tokens: number };
  error?: { message: string };
}

export function createAnthropicAdapter(apiKey: string, model: string): ModelAdapter {
  return {
    name: `anthropic:${model}`,
    async complete(system: string, user: string) {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          // A 1-3 sentence narration plus the compact JSON turn contract
          // realistically needs ~200-400 tokens; 1024 was a lot of unused
          // ceiling. Not a fix for the retry-doubling (that's the system/
          // user split), just trims worst-case cost/latency.
          max_tokens: 500,
          system,
          messages: [{ role: "user", content: user }],
        }),
      });

      const data = (await response.json()) as AnthropicResponse;

      if (!response.ok) {
        throw new Error(`Anthropic API error (${response.status}): ${data.error?.message ?? response.statusText}`);
      }

      const text = data.content.find((block) => block.type === "text")?.text ?? "";

      return {
        text,
        inputTokens: data.usage?.input_tokens,
        outputTokens: data.usage?.output_tokens,
      };
    },
  };
}
