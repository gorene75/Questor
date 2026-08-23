// Worker entry and routes. Static files under /public are served directly
// by the assets binding configured in wrangler.toml; anything that doesn't
// match a file falls through to fetch() below.

import { createDbClient, createSession, loadQuestByVersion, loadSession } from "./db.ts";
import type { WorkersAiBinding } from "./models/index.ts";
import { processTurn, rewindToCheckpoint } from "./turn.ts";

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  ANTHROPIC_API_KEY?: string;
  MODEL_NAME: string;
  AI?: WorkersAiBinding;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorStatus(message: string): number {
  if (message.includes("not found")) return 404;
  if (message.includes("already") || message.includes("no checkpoint")) return 409;
  return 500;
}

async function handleCreateSession(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => null);
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const questId = record?.quest_id;
  const modelName = record?.model_name;
  if (typeof questId !== "string") {
    return json({ error: "Expected JSON body { quest_id: string, model_name?: string }" }, 400);
  }
  if (modelName !== undefined && typeof modelName !== "string") {
    return json({ error: "model_name, if given, must be a string" }, 400);
  }

  const client = createDbClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const session = await createSession(client, questId, modelName ?? null);

  const questRow = await loadQuestByVersion(client, session.quest_id, session.quest_version);
  const startScene = questRow?.graph.scenes.find((s) => s.id === session.current_scene);

  return json({ session_id: session.id, narration: startScene?.opens_with ?? "" });
}

async function handleTurn(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => null);
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const sessionId = record?.session_id;
  const input = record?.input;
  if (typeof sessionId !== "string" || typeof input !== "string") {
    return json({ error: "Expected JSON body { session_id: string, input: string }" }, 400);
  }

  const client = createDbClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  // processTurn resolves the actual model per-session: session.model_name
  // (chosen at creation) wins if set, otherwise it falls back to MODEL_NAME
  // below. Provider is inferred from whichever model name ends up in play
  // (see selectModel) — not a separate setting.
  const modelEnv = {
    MODEL_NAME: env.MODEL_NAME,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    AI: env.AI,
  };

  const result = await processTurn({ client, modelEnv, sessionId, playerInput: input });

  return json({
    narration: result.narration,
    status: result.status,
    ending: result.ending,
    refused: result.refused,
  });
}

async function handleGetSession(sessionId: string, env: Env): Promise<Response> {
  const client = createDbClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const session = await loadSession(client, sessionId);
  if (!session) return json({ error: "Session not found" }, 404);
  return json(session);
}

// Manual and explicit only, for now — nothing auto-triggers this on a loss.
// Callers (or a human deciding for them) choose when a checkpoint is worth
// offering; the engine doesn't yet have a rule for which losses should.
async function handleRewind(sessionId: string, env: Env): Promise<Response> {
  const client = createDbClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const session = await rewindToCheckpoint(client, sessionId);
  const questRow = await loadQuestByVersion(client, session.quest_id, session.quest_version);
  const scene = questRow?.graph.scenes.find((s) => s.id === session.current_scene);

  return json({
    session_id: session.id,
    current_scene: session.current_scene,
    narration: scene?.returns_with ?? scene?.opens_with ?? "",
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/session") {
        return await handleCreateSession(request, env);
      }
      if (request.method === "POST" && url.pathname === "/turn") {
        return await handleTurn(request, env);
      }
      const rewindMatch = url.pathname.match(/^\/session\/([^/]+)\/rewind$/);
      if (request.method === "POST" && rewindMatch) {
        return await handleRewind(rewindMatch[1]!, env);
      }
      const sessionMatch = url.pathname.match(/^\/session\/([^/]+)$/);
      if (request.method === "GET" && sessionMatch) {
        return await handleGetSession(sessionMatch[1]!, env);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message }, errorStatus(message));
    }

    return json({ error: "Not found" }, 404);
  },
};
