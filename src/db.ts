// The only module that talks to Supabase. validator.ts, prompt.ts, and
// expr.ts stay pure — everything stateful lives here.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Quest } from "./validator.ts";
import type { TurnRecord } from "./prompt.ts";
import { derivePhaseFromProgress } from "./clock.ts";
import { findRelationalKnowledge, resolveObject } from "./objects.ts";

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

/**
 * A full snapshot of narratively-relevant session state, written the moment
 * play enters a scene whose `act` differs from the one just left. Deliberately
 * broader than just flags/characters/degradations/invented: it also carries
 * transcript, progress_events, fired_beats, scene_turn_count, and idle_turns,
 * because a "clean rewind" means the model's effective memory (recentHistory,
 * {{INVENTED}}, everything computeNextState reads) matches checkpoint time
 * exactly — a stale transcript alone would leak the failed attempt straight
 * back into the next prompt via {{HISTORY}}.
 */
export interface SessionCheckpoint {
  /** The scene entered when this checkpoint was written — rewind resets current_scene to this. */
  scene: string;
  phase: string;
  progress_events: string[];
  story_time: string | null;
  flags: Record<string, boolean>;
  characters: Record<string, string>;
  invented: string[];
  transcript: TurnRecord[];
  scene_turn_count: number;
  fired_beats: string[];
  active_degradations: string[];
  idle_turns: number;
}

export interface Session {
  id: string;
  quest_id: string;
  quest_version: number;
  current_scene: string;
  phase: string;
  /** Distinct clock.advances_on event ids that have fired so far this session — phase and any deadline are derived entirely from this array's length ("progress"), never from elapsed turns or real time. */
  progress_events: string[];
  /** ISO story-time, e.g. "1883-04-06T07:15:00" — null unless the quest configures optional clock.story_time. Pure narrative flavor; never gates phase or a deadline. */
  story_time: string | null;
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
  /** Most recent act-entry snapshot, or null if the quest declares no acts (or none has been entered yet). Overwritten on every new act entry — only ever the latest is kept. */
  checkpoint: SessionCheckpoint | null;
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
      phase: derivePhaseFromProgress(quest.clock.phases, 0),
      progress_events: [],
      story_time: quest.clock.story_time ? quest.clock.story_time.starts_at : null,
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
      // If the very first scene already declares an act, this is that act's
      // entry too — write the checkpoint now, same as computeNextState would
      // on any later act transition, so rewind is available from turn one.
      checkpoint: quest.scenes.find((s) => s.id === quest.meta.start_scene)?.act
        ? {
            scene: quest.meta.start_scene,
            phase: derivePhaseFromProgress(quest.clock.phases, 0),
            progress_events: [],
            story_time: quest.clock.story_time ? quest.clock.story_time.starts_at : null,
            flags: { ...quest.flags },
            characters: {},
            invented: [],
            transcript: [],
            scene_turn_count: 0,
            fired_beats: [],
            active_degradations: [],
            idle_turns: 0,
          }
        : null,
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
  progress_events: string[];
  story_time: string | null;
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
  /** Only set when this turn entered a scene whose act differs from the one just left. Never cleared back to null by ordinary play — only overwritten by a later act entry, or reset explicitly by rewindToCheckpoint. */
  checkpoint?: SessionCheckpoint | null;
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
    progress_events: input.progress_events,
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
  if (input.checkpoint !== undefined) update.checkpoint = input.checkpoint;

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

// ---- object-graph disclosure (experimental, scoped to s1_baker_street) ----
//
// Three tables, three write paths, never crossed:
//   - game_objects: world truth for a quest — hand-authored, static, seeded
//     from quest.game_objects at load time (upsertGameObjects). Never
//     mutated during play.
//   - character_relational_knowledge: what one character's own knowledge
//     holds about ANOTHER entity, under whatever referent the player used
//     ("her stepfather") — also authored, static, seeded at load time
//     (upsertRelationalKnowledge). Never written during play.
//   - player_knowledge: what one session has actually learned. The only
//     entry points are discloseToPlayer (from a game_object) and
//     discloseRelational (from a relational-knowledge row) — the latter is
//     also the only way a row's merged_into gets set, once the referent's
//     real identity has itself been disclosed.
// object_placement is separate again: per-session, session-scoped location
// for an entity, written only by moveObject. Presence is never stored as a
// boolean anywhere — it's `objectPlacement[objectId] === currentScene`,
// computed at read time (see isPresent, src/objects.ts).
//
// prompt.ts must only ever read player_knowledge (via loadPlayerKnowledge,
// attached to SessionState by turn.ts) — it has no import path to
// game_objects, character_relational_knowledge, or resolveObject at all,
// which is what makes the hard rule structural rather than a convention
// someone could forget.

export interface GameObjectRow {
  id: string;
  quest_id: string;
  type: string;
  resolved: Record<string, unknown>;
  updated_at: string;
}

export interface RelationalKnowledgeRow {
  quest_id: string;
  holder_id: string;
  subject_ref: string;
  subject_object_id: string | null;
  facts: Record<string, unknown>;
  disclosure_gate: string | null;
}

export interface PlayerKnowledgeRow {
  session_id: string;
  /** Starts as whatever referent the disclosure used (e.g. "stepfather"); may be a real game_object id directly (the_will, stoke_moran) if disclosed that way from the start. */
  object_id: string;
  known: Record<string, unknown>;
  /** Set once this referent's real identity has been disclosed — see discloseRelational. Null until then. */
  merged_into: string | null;
  /** How this row's content entered player_knowledge — "direct" for a discoverable's own disclosure (discloseToPlayer/discloseRelational, triggered by the player asking something), "observation" for the ambient per-scene bundle (discloseSceneAmbient, triggered by mere presence, not a question). Ledger bookkeeping only; nothing currently gates on it. */
  source: "direct" | "observation" | null;
}

/** Seeds/replaces the game_objects table from quest.game_objects — the DB copy of this quest's hand-authored world truth. A no-op if the quest declares none. */
export async function upsertGameObjects(client: DbClient, quest: Quest): Promise<void> {
  const objects = quest.game_objects ?? [];
  if (objects.length === 0) return;
  const { error } = await client.from("game_objects").upsert(
    objects.map((o) => ({ id: o.id, quest_id: quest.meta.id, type: o.type, resolved: o.resolved })),
    { onConflict: "id" }
  );
  if (error) throw new Error(`Failed to upsert game_objects for quest '${quest.meta.id}': ${error.message}`);
}

/** Seeds/replaces character_relational_knowledge from quest.character_relational_knowledge. A no-op if the quest declares none. */
export async function upsertRelationalKnowledge(client: DbClient, quest: Quest): Promise<void> {
  const rows = quest.character_relational_knowledge ?? [];
  if (rows.length === 0) return;
  const { error } = await client.from("character_relational_knowledge").upsert(
    rows.map((rk) => ({
      quest_id: quest.meta.id,
      holder_id: rk.holder_id,
      subject_ref: rk.subject_ref,
      subject_object_id: rk.subject_object_id ?? null,
      facts: rk.facts,
      disclosure_gate: rk.disclosure_gate ?? null,
    })),
    { onConflict: "quest_id,holder_id,subject_ref" }
  );
  if (error) throw new Error(`Failed to upsert character_relational_knowledge for quest '${quest.meta.id}': ${error.message}`);
}

/**
 * Copies just the named fields from quest.game_objects[objectId].resolved
 * (via the pure resolveObject) into this session's player_knowledge.known,
 * merging with whatever's already there — never the whole resolved object,
 * so a sparse, partial disclosure stays sparse. Use only for an entity
 * whose identity is already established at authoring time; an entity first
 * known only by referent (e.g. "her stepfather") goes through
 * discloseRelational instead.
 */
export async function discloseToPlayer(
  client: DbClient,
  sessionId: string,
  quest: Quest,
  objectId: string,
  fields: string[]
): Promise<void> {
  const resolved = resolveObject(quest, objectId);
  if (!resolved) throw new Error(`discloseToPlayer: quest '${quest.meta.id}' has no game_object '${objectId}'`);

  const existing = await loadOnePlayerKnowledge(client, sessionId, objectId);
  const known: Record<string, unknown> = { ...existing?.known };
  for (const field of fields) {
    if (field in resolved) known[field] = resolved[field];
  }

  const { error } = await client
    .from("player_knowledge")
    .upsert(
      { session_id: sessionId, object_id: objectId, known, merged_into: existing?.merged_into ?? null, source: "direct" },
      { onConflict: "session_id,object_id" }
    );
  if (error) throw new Error(`Failed to disclose '${objectId}' to session '${sessionId}': ${error.message}`);
}

/**
 * Copies named fields from a character's own character_relational_knowledge
 * (holderId's knowledge of subjectRef) into this session's player_knowledge,
 * keyed under subjectRef — never under the real object id, since that link
 * isn't known to the player yet. If `fields` includes "name" and the row
 * declares a subject_object_id, this disclosure also sets merged_into: from
 * this point on, the referent and the real entity are the same identity as
 * far as this session's knowledge goes (loadPlayerKnowledge exposes the row
 * under both keys).
 */
export async function discloseRelational(
  client: DbClient,
  sessionId: string,
  quest: Quest,
  holderId: string,
  subjectRef: string,
  fields: string[]
): Promise<void> {
  const row = findRelationalKnowledge(quest, holderId, subjectRef);
  if (!row) {
    throw new Error(
      `discloseRelational: quest '${quest.meta.id}' has no character_relational_knowledge for holder '${holderId}', subject_ref '${subjectRef}'`
    );
  }

  const existing = await loadOnePlayerKnowledge(client, sessionId, subjectRef);
  const known: Record<string, unknown> = { ...existing?.known };
  for (const field of fields) {
    if (field in row.facts) known[field] = row.facts[field];
  }
  const mergedInto = fields.includes("name") && row.subject_object_id ? row.subject_object_id : existing?.merged_into ?? null;

  const { error } = await client
    .from("player_knowledge")
    .upsert(
      { session_id: sessionId, object_id: subjectRef, known, merged_into: mergedInto, source: "direct" },
      { onConflict: "session_id,object_id" }
    );
  if (error) {
    throw new Error(`Failed to disclose relational '${subjectRef}' (holder '${holderId}') to session '${sessionId}': ${error.message}`);
  }
}

/**
 * Discloses a bundle of ambient content straight from the scene's own static
 * data (e.g. opens_with) — no game_objects row backs this, because the room
 * as a whole fails the one-object test (it supports exactly one action,
 * "observe"; there's no separate open/read/take of "the room"). Fires once
 * per scene entry, keyed under sceneRef (the scene id); idempotent, so
 * re-entering the same scene later just re-asserts the same content.
 * source is always "observation" — this never happens in response to a
 * specific question, only to being there at all.
 */
export async function discloseSceneAmbient(
  client: DbClient,
  sessionId: string,
  sceneRef: string,
  known: Record<string, unknown>
): Promise<void> {
  const existing = await loadOnePlayerKnowledge(client, sessionId, sceneRef);
  const merged: Record<string, unknown> = { ...existing?.known, ...known };
  const { error } = await client
    .from("player_knowledge")
    .upsert(
      { session_id: sessionId, object_id: sceneRef, known: merged, merged_into: existing?.merged_into ?? null, source: "observation" },
      { onConflict: "session_id,object_id" }
    );
  if (error) throw new Error(`Failed to disclose scene ambient content for '${sceneRef}' to session '${sessionId}': ${error.message}`);
}

async function loadOnePlayerKnowledge(client: DbClient, sessionId: string, objectId: string): Promise<PlayerKnowledgeRow | null> {
  const { data, error } = await client
    .from("player_knowledge")
    .select()
    .eq("session_id", sessionId)
    .eq("object_id", objectId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load player_knowledge '${objectId}' for session '${sessionId}': ${error.message}`);
  return data as PlayerKnowledgeRow | null;
}

/**
 * Everything this session has been disclosed so far, keyed by object id.
 * A merged row (merged_into set) is exposed under BOTH its original
 * referent and the real id it merged into, so a lookup by either still
 * finds it. Empty if nothing has been disclosed yet — there is no
 * "undisclosed" row, only an absent one.
 */
export async function loadPlayerKnowledge(client: DbClient, sessionId: string): Promise<Record<string, PlayerKnowledgeRow>> {
  const { data, error } = await client.from("player_knowledge").select().eq("session_id", sessionId);
  if (error) throw new Error(`Failed to load player_knowledge for session '${sessionId}': ${error.message}`);
  const result: Record<string, PlayerKnowledgeRow> = {};
  for (const row of (data ?? []) as PlayerKnowledgeRow[]) {
    result[row.object_id] = row;
    if (row.merged_into) result[row.merged_into] = row;
  }
  return result;
}

/**
 * The ONLY function permitted to write object_placement.location. Callers
 * are exclusively engine code reacting to a validated exit, beat, or
 * guarded event having actually fired this turn — never the model's
 * self-report, never inferred from narration. location: null means not
 * currently placed anywhere (an entity that hasn't entered the story yet,
 * or has stepped out of it).
 */
export async function moveObject(client: DbClient, sessionId: string, objectId: string, location: string | null): Promise<void> {
  const { error } = await client
    .from("object_placement")
    .upsert(
      { session_id: sessionId, object_id: objectId, location, updated_at: new Date().toISOString() },
      { onConflict: "session_id,object_id" }
    );
  if (error) throw new Error(`Failed to move '${objectId}' to '${location}' for session '${sessionId}': ${error.message}`);
}

/** This session's current location for every object that's ever been placed, keyed by object id. Absent key (not null value) means never placed at all. */
export async function loadObjectPlacement(client: DbClient, sessionId: string): Promise<Record<string, string | null>> {
  const { data, error } = await client.from("object_placement").select().eq("session_id", sessionId);
  if (error) throw new Error(`Failed to load object_placement for session '${sessionId}': ${error.message}`);
  const result: Record<string, string | null> = {};
  for (const row of (data ?? []) as { object_id: string; location: string | null }[]) {
    result[row.object_id] = row.location;
  }
  return result;
}
