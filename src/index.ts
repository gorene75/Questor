// Worker entry and routes. Static files under /public are served directly
// by the assets binding configured in wrangler.toml; anything that doesn't
// match a file falls through to fetch() below.

import { createDbClient, createSession, loadQuestByVersion, loadSession } from "./db.ts";
import { selectModel, type WorkersAiBinding } from "./models/index.ts";
import { processTurn } from "./turn.ts";

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  ANTHROPIC_API_KEY?: string;
  MODEL_PROVIDER: string;
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
  if (message.includes("already")) return 409;
  return 500;
}

async function handleCreateSession(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => null);
  const questId = body && typeof body === "object" ? (body as Record<string, unknown>).quest_id : undefined;
  if (typeof questId !== "string") {
    return json({ error: "Expected JSON body { quest_id: string }" }, 400);
  }

  const client = createDbClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const session = await createSession(client, questId);

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
  const model = selectModel({
    MODEL_PROVIDER: env.MODEL_PROVIDER,
    MODEL_NAME: env.MODEL_NAME,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    AI: env.AI,
  });

  const result = await processTurn({ client, model, sessionId, playerInput: input });

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
