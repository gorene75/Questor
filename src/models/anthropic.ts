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
          // realistically needs ~200-400 tokens; 800 keeps headroom above
          // that without reintroducing the original oversized-response cost
          // 1024 had.
          max_tokens: 800,
          system,
          messages: [{ role: "user", content: user }],
          // claude-sonnet-5 emits extended thinking by default even though
          // nothing here asks for it. Some turns spent the ENTIRE max_tokens
          // budget on an opaque thinking block and returned zero text
          // (stop_reason: "max_tokens", 0 tokens left for the actual JSON),
          // forcing a full retry every time it happened. This isn't a task
          // that benefits from visible chain-of-thought — it's a single
          // structured narration turn — so thinking is turned off outright
          // rather than budgeted around.
          thinking: { type: "disabled" },
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
