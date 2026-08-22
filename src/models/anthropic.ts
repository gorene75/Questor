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
          max_tokens: 1024,
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
