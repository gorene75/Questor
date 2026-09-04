// Adapter interface + provider selection. Both providers request JSON output
// and are swappable behind this interface without touching turn.ts.

import { createAnthropicAdapter } from "./anthropic.ts";
import { createWorkersAiAdapter } from "./workersai.ts";

export interface ModelAdapter {
  name: string;
  /**
   * systemStatic and systemDynamic are always concatenated to form the full
   * system prompt — the split exists only so an adapter that supports
   * prompt caching can mark a breakpoint after the static (session-
   * invariant) half. An adapter without caching support may simply join
   * them.
   */
  complete(
    systemStatic: string,
    systemDynamic: string,
    user: string
  ): Promise<{
    text: string;
    inputTokens?: number;
    outputTokens?: number;
  }>;
}

/** Minimal shape of the Cloudflare Workers AI binding (`env.AI`). */
export interface WorkersAiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface ModelEnv {
  MODEL_NAME: string;
  ANTHROPIC_API_KEY?: string;
  AI?: WorkersAiBinding;
}

/**
 * Workers AI model ids universally start with `@cf/`; Anthropic ids never
 * do. This makes MODEL_NAME alone sufficient to pick a provider — no
 * separate provider field needed, so a per-session model choice (which only
 * has a model name to give) can route correctly without extra plumbing.
 */
function inferProvider(modelName: string): "anthropic" | "workersai" {
  return modelName.startsWith("@cf/") ? "workersai" : "anthropic";
}

export function selectModel(env: ModelEnv): ModelAdapter {
  const provider = inferProvider(env.MODEL_NAME);
  switch (provider) {
    case "anthropic": {
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error(`ANTHROPIC_API_KEY is required to use model '${env.MODEL_NAME}'`);
      }
      return createAnthropicAdapter(env.ANTHROPIC_API_KEY, env.MODEL_NAME);
    }
    case "workersai": {
      if (!env.AI) {
        throw new Error(`AI binding is required to use model '${env.MODEL_NAME}'`);
      }
      return createWorkersAiAdapter(env.AI, env.MODEL_NAME);
    }
  }
}
