// Adapter interface + provider selection. Both providers request JSON output
// and are swappable behind this interface without touching turn.ts.

import { createAnthropicAdapter } from "./anthropic.ts";
import { createWorkersAiAdapter } from "./workersai.ts";

export interface ModelAdapter {
  name: string;
  complete(
    system: string,
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
  MODEL_PROVIDER: string;
  MODEL_NAME: string;
  ANTHROPIC_API_KEY?: string;
  AI?: WorkersAiBinding;
}

export function selectModel(env: ModelEnv): ModelAdapter {
  switch (env.MODEL_PROVIDER) {
    case "anthropic": {
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error("ANTHROPIC_API_KEY is required when MODEL_PROVIDER=anthropic");
      }
      return createAnthropicAdapter(env.ANTHROPIC_API_KEY, env.MODEL_NAME);
    }
    case "workersai": {
      if (!env.AI) {
        throw new Error("AI binding is required when MODEL_PROVIDER=workersai");
      }
      return createWorkersAiAdapter(env.AI, env.MODEL_NAME);
    }
    default:
      throw new Error(`Unknown MODEL_PROVIDER '${env.MODEL_PROVIDER}' (expected 'anthropic' or 'workersai')`);
  }
}
