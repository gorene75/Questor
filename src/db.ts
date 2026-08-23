// The only module that talks to Supabase. validator.ts, prompt.ts, and
// expr.ts stay pure — everything stateful lives here.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Quest } from "./validator.ts";
import type { TurnRecord } from "./prompt.ts";
import { derivePhase } from "./clock.ts";

export type DbClient = SupabaseClient;

export function createDbClient(url: string, serviceKey: string): DbClient {
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

export function createDbClientFromEnv(): DbClient {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in the environment");
  }
  return createDbClient(url, serviceKey);
}

export interface QuestRow {
  id: string;
  version: number;
  graph: Quest;
  created_at: string;
}

export type SessionStatus = "active" | "won" | "lost";

export interface Session {
  id: string;
  quest_id: string;
  quest_version: number;
  current_scene: string;
  phase: string;
  /** ISO story-time, e.g. "1883-04-06T07:15:00" — the source of truth; phase is derived from it. */
  story_time: string;
  flags: Record<string, boolean>;
  characters: Record<string, string>;
  invented: string[];
  transcript: TurnRecord[];
  scene_turn_count: number;
  fired_beats: string[];
  /** Degradation ids applied to this session so far, via guarded_events.on_allowed.degrade or clock.deadline.on_reached (mode: "degrade"). Each named degradation's `unlocks` stays in effect for the rest of the session. */
  active_degradations: string[];
  /** Consecutive idle turns (per pressure's definition) in the current scene. Resets to 0 on any scene change or non-idle turn. */
  idle_turns: number;
  status: SessionStatus;
  ending_id: string | null;
  /** Why an engine backstop (not ordinary play) landed on this ending — e.g. "max_turns_exceeded". Null when the ending was reached through normal play. */
  ending_trigger: string | null;
  /** Model chosen for this session at creation, or null to use the env/vars default at play time. */
  model_name: string | null;
  created_at: string;
  updated_at: string;
}

/** Insert or replace a quest graph at (id, version). version defaults to 1 — Phase 1 has no authoring workflow yet. */
export async function upsertQuest(client: DbClient, quest: Quest, version = 1): Promise<QuestRow> {
  const { data, error } = await client
    .from("quests")
    .upsert({ id: quest.meta.id, version, graph: quest }, { onConflict: "id,version" })
    .select()
    .single();

  if (error) throw new Error(`Failed to upsert quest '${quest.meta.id}': ${error.message}`);
  return data as QuestRow;
}

/** Loads the highest-versioned row for a quest id, or null if none exists. */
export async function loadQuest(client: DbClient, questId: string): Promise<QuestRow | null> {
  const { data, error } = await client
    .from("quests")
    .select()
    .eq("id", questId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to load quest '${questId}': ${error.message}`);
  return data as QuestRow | null;
}

/** Loads a quest pinned to a specific version — a session must keep playing against the version it started with. */
export async function loadQuestByVersion(client: DbClient, questId: string, version: number): Promise<QuestRow | null> {
  const { data, error } = await client
    .from("quests")
    .select()
    .eq("id", questId)
    .eq("version", version)
    .maybeSingle();

  if (error) throw new Error(`Failed to load quest '${questId}' v${version}: ${error.message}`);
  return data as QuestRow | null;
}

export async function createSession(client: DbClient, questId: string, modelName: string | null = null): Promise<Session> {
  const questRow = await loadQuest(client, questId);
  if (!questRow) {
    throw new Error(`No quest found with id '${questId}' — load it into the quests table first`);
  }
  const quest = questRow.graph;

  const { data, error } = await client
    .from("sessions")
    .insert({
      quest_id: questRow.id,
      quest_version: questRow.version,
      current_scene: quest.meta.start_scene,
      phase: derivePhase(quest.clock.phases, quest.clock.starts_at),
      story_time: quest.clock.starts_at,
      // Every declared flag starts at its declared default (false), not a
      // literally-empty object — src/expr.ts requires every flag referenced
      // by a `requires`/`derived` expression to be present in the context,
      // and evaluating the very first scene's exits already needs that.
      flags: { ...quest.flags },
      characters: {},
      invented: [],
      transcript: [],
      scene_turn_count: 0,
      fired_beats: [],
      active_degradations: [],
      idle_turns: 0,
      status: "active",
      ending_id: null,
      ending_trigger: null,
      model_name: modelName,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create session for quest '${questId}': ${error.message}`);
  return data as Session;
}

export async function loadSession(client: DbClient, sessionId: string): Promise<Session | null> {
  const { data, error } = await client.from("sessions").select().eq("id", sessionId).maybeSingle();

  if (error) throw new Error(`Failed to load session '${sessionId}': ${error.message}`);
  return data as Session | null;
}

export interface TurnCommitInput {
  current_scene: string;
  phase: string;
  story_time: string;
  flags: Record<string, boolean>;
  characters: Record<string, string>;
  invented: string[];
  transcript: TurnRecord[];
  scene_turn_count: number;
  fired_beats: string[];
  active_degradations: string[];
  idle_turns: number;
  /** Only set when the turn just reached an ending. */
  status?: SessionStatus;
  ending_id?: string | null;
  ending_trigger?: string | null;
}

/**
 * Persists a turn's already-validated, already-merged state. turn.ts owns
 * the merging/clamping logic (one disposition step, flag validation, etc.);
 * this function just writes the resulting values.
 */
export async function commitTurn(client: DbClient, sessionId: string, input: TurnCommitInput): Promise<Session> {
  const update: Record<string, unknown> = {
    current_scene: input.current_scene,
    phase: input.phase,
    story_time: input.story_time,
    flags: input.flags,
    characters: input.characters,
    invented: input.invented,
    transcript: input.transcript,
    scene_turn_count: input.scene_turn_count,
    fired_beats: input.fired_beats,
    active_degradations: input.active_degradations,
    idle_turns: input.idle_turns,
    updated_at: new Date().toISOString(),
  };
  if (input.status !== undefined) update.status = input.status;
  if (input.ending_id !== undefined) update.ending_id = input.ending_id;
  if (input.ending_trigger !== undefined) update.ending_trigger = input.ending_trigger;

  const { data, error } = await client.from("sessions").update(update).eq("id", sessionId).select().single();

  if (error) throw new Error(`Failed to commit turn for session '${sessionId}': ${error.message}`);
  return data as Session;
}

export interface TurnValidationResult {
  valid: boolean;
  errors: string[];
}

export interface TurnLogInput {
  session_id: string;
  turn_index: number;
  player_input: string | null;
  prompt: string;
  raw_response: string;
  parsed: unknown;
  validation: TurnValidationResult;
  model: string;
  input_tokens?: number;
  output_tokens?: number;
  /** This attempt's own model.complete() duration. */
  latency_ms?: number;
  /** Everything below is a per-turn aggregate, not per-attempt — identical
   * across every row sharing a turn_index, since it's only fully known once
   * the whole turn (all retries) has resolved. */
  model_call_ms?: number;
  validation_ms?: number;
  db_commit_ms?: number;
  total_ms?: number;
  model_call_count?: number;
}

export interface TurnLogRow extends TurnLogInput {
  id: number;
  created_at: string;
}

/**
 * Logs one model-completion attempt. Called once per attempt — a retried
 * turn produces two rows sharing the same turn_index — so a bad model can be
 * told apart from a bad quest file by reading what was actually sent and
 * returned, not just the final outcome.
 */
export async function logTurn(client: DbClient, input: TurnLogInput): Promise<void> {
  const { error } = await client.from("turn_logs").insert({
    session_id: input.session_id,
    turn_index: input.turn_index,
    player_input: input.player_input,
    prompt: input.prompt,
    raw_response: input.raw_response,
    parsed: input.parsed,
    validation: input.validation,
    model: input.model,
    input_tokens: input.input_tokens,
    output_tokens: input.output_tokens,
    latency_ms: input.latency_ms,
    model_call_ms: input.model_call_ms,
    validation_ms: input.validation_ms,
    db_commit_ms: input.db_commit_ms,
    total_ms: input.total_ms,
    model_call_count: input.model_call_count,
  });

  if (error) throw new Error(`Failed to log turn for session '${input.session_id}': ${error.message}`);
}

export async function listTurnLogs(client: DbClient, sessionId: string): Promise<TurnLogRow[]> {
  const { data, error } = await client
    .from("turn_logs")
    .select()
    .eq("session_id", sessionId)
    .order("id", { ascending: true });

  if (error) throw new Error(`Failed to list turn_logs for session '${sessionId}': ${error.message}`);
  return (data ?? []) as TurnLogRow[];
}
