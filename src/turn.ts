// Turn resolution and enforcement — the piece BUILD.md calls "the model
// judges, the engine decides." Nothing the model reports is trusted until
// checked against the quest file and current session state.

import type { CharacterSpec, Quest, SceneSpec } from "./validator.ts";
import { evaluateExpression, type ExprContext } from "./expr.ts";
import { buildPromptParts, type SessionState, type TurnRecord } from "./prompt.ts";
import { selectModel, type ModelAdapter, type ModelEnv } from "./models/index.ts";
import {
  commitTurn,
  loadQuestByVersion,
  loadSession,
  logTurn,
  type DbClient,
  type Session,
  type SessionStatus,
  type TurnValidationResult,
} from "./db.ts";

export interface DispositionChange {
  character: string;
  direction: "up" | "down";
  reason: string;
}

export interface ModelTurnResponse {
  narration: string;
  exit_id: string | null;
  guarded_event_id: string | null;
  discovered: string[];
  flags_set: string[];
  disposition_changes: DispositionChange[];
  invented: string[];
  refused: boolean;
}

export interface TurnResult {
  narration: string;
  status: SessionStatus;
  ending?: { id: string; title: string; direction: string };
  refused: boolean;
  session: Session;
}

const FALLBACK_NARRATION = "The moment passes without incident.";

// ---- parsing ----

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1]! : trimmed;
}

function parseModelResponse(text: string): ModelTurnResponse {
  let raw: unknown;
  try {
    raw = JSON.parse(stripCodeFence(text));
  } catch {
    throw new Error("Response was not valid JSON");
  }

  if (typeof raw !== "object" || raw === null) {
    throw new Error("Response JSON must be an object");
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.narration !== "string") throw new Error("'narration' must be a string");
  if (obj.exit_id !== null && typeof obj.exit_id !== "string") {
    throw new Error("'exit_id' must be a string or null");
  }
  // A missing key (rather than an explicit null) is tolerated — this field
  // is new, and a model that simply omits it means "nothing guarded fired,"
  // same as null; only a present-but-wrong-typed value is rejected.
  if (
    obj.guarded_event_id !== undefined &&
    obj.guarded_event_id !== null &&
    typeof obj.guarded_event_id !== "string"
  ) {
    throw new Error("'guarded_event_id' must be a string or null");
  }
  if (!Array.isArray(obj.discovered) || !obj.discovered.every((x) => typeof x === "string")) {
    throw new Error("'discovered' must be an array of strings");
  }
  if (!Array.isArray(obj.flags_set) || !obj.flags_set.every((x) => typeof x === "string")) {
    throw new Error("'flags_set' must be an array of strings");
  }
  if (!Array.isArray(obj.disposition_changes)) {
    throw new Error("'disposition_changes' must be an array");
  }
  const dispositionChanges: DispositionChange[] = obj.disposition_changes.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) throw new Error(`disposition_changes[${i}] must be an object`);
    const e = entry as Record<string, unknown>;
    if (typeof e.character !== "string") throw new Error(`disposition_changes[${i}].character must be a string`);
    if (e.direction !== "up" && e.direction !== "down") {
      throw new Error(`disposition_changes[${i}].direction must be 'up' or 'down'`);
    }
    if (typeof e.reason !== "string") throw new Error(`disposition_changes[${i}].reason must be a string`);
    return { character: e.character, direction: e.direction, reason: e.reason };
  });
  if (!Array.isArray(obj.invented) || !obj.invented.every((x) => typeof x === "string")) {
    throw new Error("'invented' must be an array of strings");
  }
  if (typeof obj.refused !== "boolean") throw new Error("'refused' must be a boolean");

  return {
    narration: obj.narration,
    exit_id: obj.exit_id as string | null,
    guarded_event_id: (obj.guarded_event_id ?? null) as string | null,
    discovered: obj.discovered as string[],
    flags_set: obj.flags_set as string[],
    disposition_changes: dispositionChanges,
    invented: obj.invented as string[],
    refused: obj.refused,
  };
}

// ---- shared expression context ----

function buildContext(
  quest: Quest,
  flags: Record<string, boolean>,
  characters: Record<string, string>
): ExprContext {
  const characterLevels: ExprContext["characterLevels"] = {};
  for (const [id, character] of Object.entries(quest.characters)) {
    characterLevels[id] = {
      levels: character.disposition.levels,
      current: characters[id] ?? character.disposition.starts_at,
    };
  }
  return { flags, derived: quest.derived, characterLevels };
}

// ---- validation: reject, do not trust ----

function validateTurnResponse(
  response: ModelTurnResponse,
  quest: Quest,
  scene: SceneSpec,
  session: Session
): string[] {
  const errors: string[] = [];
  const ctx = buildContext(quest, session.flags, session.characters);

  if (response.exit_id !== null) {
    const exit = (scene.exits ?? []).find((e) => e.id === response.exit_id);
    if (!exit) {
      errors.push(`exit_id '${response.exit_id}' is not a legal exit of scene '${scene.id}'`);
    } else {
      if (exit.requires && !evaluateExpression(exit.requires, ctx)) {
        errors.push(`exit '${exit.id}' requires '${exit.requires}', which is not currently satisfied`);
      }
      if (exit.requires_phase && exit.requires_phase !== session.phase) {
        errors.push(
          `exit '${exit.id}' requires phase '${exit.requires_phase}', current phase is '${session.phase}'`
        );
      }
    }
  }

  if (response.guarded_event_id !== null) {
    const guardedEvent = (scene.guarded_events ?? []).find((g) => g.id === response.guarded_event_id);
    if (!guardedEvent) {
      errors.push(`guarded_event_id '${response.guarded_event_id}' is not a legal guarded_events id of scene '${scene.id}'`);
    } else if (guardedEvent.requires && !evaluateExpression(guardedEvent.requires, ctx)) {
      // The on_blocked text is embedded directly in the error, since a
      // rejected turn's errors are exactly what gets fed back on retry —
      // this is how the model gets steered toward narrating the block
      // gracefully instead of just failing again.
      errors.push(
        `guarded_event '${guardedEvent.id}' requires '${guardedEvent.requires}', which is not currently satisfied. Narrate it like this instead: ${guardedEvent.on_blocked}`
      );
    }
  }

  for (const discoveredId of response.discovered) {
    const discoverable = (scene.discoverable ?? []).find((d) => d.id === discoveredId);
    if (!discoverable) {
      errors.push(`discovered id '${discoveredId}' does not belong to scene '${scene.id}'`);
      continue;
    }
    if (discoverable.requires && !evaluateExpression(discoverable.requires, ctx)) {
      errors.push(
        `discoverable '${discoveredId}' requires '${discoverable.requires}', which is not currently satisfied`
      );
    }
  }

  for (const flag of response.flags_set) {
    if (!(flag in quest.flags)) {
      errors.push(`flag '${flag}' in flags_set is not declared in the quest`);
    }
  }

  for (const change of response.disposition_changes) {
    if (!quest.characters[change.character]) {
      errors.push(`disposition_changes names unknown character '${change.character}'`);
      continue;
    }
    if (!(scene.present ?? []).includes(change.character)) {
      errors.push(`disposition_changes names '${change.character}', who is not present in scene '${scene.id}'`);
    }
  }

  return errors;
}

// ---- model attempt (parse + validate one completion) ----

interface Attempt {
  /** Logged verbatim to turn_logs.prompt — both roles, clearly labeled, for full debugging visibility. */
  promptSent: string;
  rawText: string;
  parsed: ModelTurnResponse | null;
  validation: TurnValidationResult;
  inputTokens?: number;
  outputTokens?: number;
  /** Just the model.complete() call. */
  modelCallMs: number;
  /** Just parseModelResponse + validateTurnResponse, excluding the network call. */
  validationMs: number;
}

async function attemptTurn(
  model: ModelAdapter,
  systemPrompt: string,
  baseUser: string,
  priorErrors: string[] | null,
  quest: Quest,
  scene: SceneSpec,
  session: Session
): Promise<Attempt> {
  // system stays stable across a retry — only the user turn grows, with the
  // rejection reason attached to what the model is actually responding to.
  const userSent = priorErrors
    ? `${baseUser}\n\n---\n\nYour previous response was rejected for these reasons: ${priorErrors.join(
        "; "
      )}\n\nReturn corrected JSON only, following the output contract exactly. No prose, no code fences.`
    : baseUser;

  const modelCallStart = Date.now();
  const { text, inputTokens, outputTokens } = await model.complete(systemPrompt, userSent);
  const modelCallMs = Date.now() - modelCallStart;

  const validationStart = Date.now();
  let parsed: ModelTurnResponse | null = null;
  let errors: string[] = [];
  try {
    parsed = parseModelResponse(text);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  if (parsed) {
    errors = errors.concat(validateTurnResponse(parsed, quest, scene, session));
  }
  const validationMs = Date.now() - validationStart;

  return {
    promptSent: `[SYSTEM]\n${systemPrompt}\n\n[USER]\n${userSent}`,
    rawText: text,
    parsed,
    validation: { valid: errors.length === 0, errors },
    inputTokens,
    outputTokens,
    modelCallMs,
    validationMs,
  };
}

// ---- state transition ----

interface NextState {
  current_scene: string;
  phase: string;
  flags: Record<string, boolean>;
  characters: Record<string, string>;
  invented: string[];
  transcript: TurnRecord[];
  scene_turn_count: number;
  fired_beats: string[];
  status: SessionStatus;
  ending_id: string | null;
}

function clampedStep(character: CharacterSpec, currentLevel: string, direction: "up" | "down"): string {
  const levels = character.disposition.levels;
  const currentIdx = levels.indexOf(currentLevel);
  const floorIdx = levels.indexOf(character.disposition.floor);
  const ceilingIdx = levels.indexOf(character.disposition.ceiling);
  const step = direction === "up" ? 1 : -1;
  const nextIdx = Math.min(ceilingIdx, Math.max(floorIdx, currentIdx + step));
  return levels[nextIdx]!;
}

function advancePhaseIfLater(phases: string[], current: string, target: string): string {
  return phases.indexOf(target) > phases.indexOf(current) ? target : current;
}

function computeNextState(
  quest: Quest,
  session: Session,
  scene: SceneSpec,
  response: ModelTurnResponse,
  playerInput: string
): NextState {
  const flags: Record<string, boolean> = { ...session.flags };
  for (const f of response.flags_set) flags[f] = true;

  // discoverable.sets and exit.sets are quest-authored, deterministic
  // mappings the engine already knows — apply them directly for anything
  // the model validly discovered/took, rather than trusting the model to
  // separately re-derive and echo them into flags_set. Live testing showed
  // this isn't a hypothetical: a model can correctly report `discovered`
  // while still omitting the matching flags_set entry.
  for (const discoveredId of response.discovered) {
    const discoverable = (scene.discoverable ?? []).find((d) => d.id === discoveredId);
    for (const f of discoverable?.sets ?? []) flags[f] = true;
  }
  if (response.exit_id !== null) {
    const takenExit = (scene.exits ?? []).find((e) => e.id === response.exit_id);
    for (const f of takenExit?.sets ?? []) flags[f] = true;
  }

  const characters: Record<string, string> = { ...session.characters };
  for (const change of response.disposition_changes) {
    const characterSpec = quest.characters[change.character];
    if (!characterSpec) continue; // already rejected by validation if this could happen
    const currentLevel = characters[change.character] ?? characterSpec.disposition.starts_at;
    characters[change.character] = clampedStep(characterSpec, currentLevel, change.direction);
  }

  const invented = [...session.invented, ...response.invented];
  const transcript: TurnRecord[] = [...session.transcript, { player_input: playerInput, narration: response.narration }];

  let currentScene = session.current_scene;
  let sceneTurnCount = session.scene_turn_count;
  if (response.exit_id !== null) {
    const exit = (scene.exits ?? []).find((e) => e.id === response.exit_id)!;
    currentScene = exit.to;
    sceneTurnCount = 0;
  } else {
    sceneTurnCount += 1;
  }

  let phase = session.phase;
  for (const adv of quest.clock.advances_on ?? []) {
    if (adv.exit && adv.exit === response.exit_id) {
      phase = advancePhaseIfLater(quest.clock.phases, phase, adv.to);
    }
    if (adv.turns_in_scene !== undefined && adv.scene === currentScene && sceneTurnCount >= adv.turns_in_scene) {
      phase = advancePhaseIfLater(quest.clock.phases, phase, adv.to);
    }
  }

  const firedBeats = [...session.fired_beats];
  const sceneAfterExit = quest.scenes.find((s) => s.id === currentScene);
  if (sceneAfterExit) {
    const beatsInOrder = [...(sceneAfterExit.beats ?? [])].sort((a, b) => a.at_turn - b.at_turn);
    for (const beat of beatsInOrder) {
      const key = `${sceneAfterExit.id}#${beat.at_turn}`;
      if (firedBeats.includes(key)) continue;
      if (sceneTurnCount < beat.at_turn) continue;

      for (const f of beat.sets ?? []) flags[f] = true;
      if (beat.once ?? true) firedBeats.push(key);
      if (beat.goto) {
        currentScene = beat.goto;
        sceneTurnCount = 0;
        break; // scene changed — further beats belong to the scene we just left
      }
    }
  }

  const finalScene = quest.scenes.find((s) => s.id === currentScene);
  if (finalScene?.on_fail) {
    const ctx = buildContext(quest, flags, characters);
    if (evaluateExpression(finalScene.on_fail.when, ctx)) {
      currentScene = finalScene.on_fail.to;
    }
  }

  let status: SessionStatus = session.status;
  let endingId: string | null = null;
  const ending = quest.endings.find((e) => e.id === currentScene);
  if (ending) {
    endingId = ending.id;
    status = ending.result === "win" ? "won" : "lost";
  }

  return {
    current_scene: currentScene,
    phase,
    flags,
    characters,
    invented,
    transcript,
    scene_turn_count: sceneTurnCount,
    fired_beats: firedBeats,
    status,
    ending_id: endingId,
  };
}

// ---- public entry point ----

export async function processTurn(params: {
  client: DbClient;
  sessionId: string;
  playerInput: string;
  /** Direct adapter override — mainly for scripts/tests driving a scripted fake model. Takes priority over modelEnv. */
  model?: ModelAdapter;
  /** Used to build the adapter from the session's chosen model_name (falling back to modelEnv.MODEL_NAME) when `model` isn't given directly. */
  modelEnv?: ModelEnv;
}): Promise<TurnResult> {
  const { client, sessionId, playerInput } = params;

  const session = await loadSession(client, sessionId);
  if (!session) throw new Error(`No session found with id '${sessionId}'`);
  if (session.status !== "active") {
    throw new Error(`Session '${sessionId}' is already '${session.status}' — no further turns accepted`);
  }

  let resolvedModel = params.model;
  if (!resolvedModel) {
    if (!params.modelEnv) throw new Error("processTurn requires either `model` or `modelEnv`");
    const modelName = session.model_name ?? params.modelEnv.MODEL_NAME;
    resolvedModel = selectModel({ ...params.modelEnv, MODEL_NAME: modelName });
  }
  const model = resolvedModel;

  const questRow = await loadQuestByVersion(client, session.quest_id, session.quest_version);
  if (!questRow) throw new Error(`Quest '${session.quest_id}' v${session.quest_version} not found`);
  const quest = questRow.graph;

  const scene = quest.scenes.find((s) => s.id === session.current_scene);
  if (!scene) throw new Error(`Session is in unknown scene '${session.current_scene}'`);

  const sessionState: SessionState = {
    current_scene: session.current_scene,
    phase: session.phase,
    flags: session.flags,
    characters: session.characters,
    invented: session.invented,
  };
  const { system: systemPrompt, user: baseUser } = buildPromptParts(quest, sessionState, session.transcript, playerInput);

  const turnIndex = session.transcript.length;
  const turnStart = Date.now();

  const attempts: Attempt[] = [];
  attempts.push(await attemptTurn(model, systemPrompt, baseUser, null, quest, scene, session));

  let final = attempts[0]!;
  if (!final.validation.valid) {
    const attempt2 = await attemptTurn(model, systemPrompt, baseUser, final.validation.errors, quest, scene, session);
    attempts.push(attempt2);
    final = attempt2;
  }

  // Aggregates are only fully known once every attempt for this turn is in —
  // computed once, then written identically onto every row for this
  // turn_index, so any row answers "how long did this turn actually take."
  const modelCallMs = attempts.reduce((sum, a) => sum + a.modelCallMs, 0);
  const validationMs = attempts.reduce((sum, a) => sum + a.validationMs, 0);
  const modelCallCount = attempts.length;

  async function logAllAttempts(dbCommitMs: number) {
    const totalMs = Date.now() - turnStart;
    for (const attempt of attempts) {
      await logTurn(client, {
        session_id: sessionId,
        turn_index: turnIndex,
        player_input: playerInput,
        prompt: attempt.promptSent,
        raw_response: attempt.rawText,
        parsed: attempt.parsed,
        validation: attempt.validation,
        model: model.name,
        input_tokens: attempt.inputTokens,
        output_tokens: attempt.outputTokens,
        latency_ms: attempt.modelCallMs,
        model_call_ms: modelCallMs,
        validation_ms: validationMs,
        db_commit_ms: dbCommitMs,
        total_ms: totalMs,
        model_call_count: modelCallCount,
      });
    }
  }

  if (!final.validation.valid || !final.parsed) {
    // Second failure: commit nothing, return a null-exit fallback.
    await logAllAttempts(0);
    return {
      narration: FALLBACK_NARRATION,
      status: session.status,
      refused: false,
      session,
    };
  }

  const response = final.parsed;
  const next = computeNextState(quest, session, scene, response, playerInput);

  const commitStart = Date.now();
  const updatedSession = await commitTurn(client, sessionId, {
    current_scene: next.current_scene,
    phase: next.phase,
    flags: next.flags,
    characters: next.characters,
    invented: next.invented,
    transcript: next.transcript,
    scene_turn_count: next.scene_turn_count,
    fired_beats: next.fired_beats,
    status: next.status,
    ending_id: next.ending_id,
  });
  const dbCommitMs = Date.now() - commitStart;

  await logAllAttempts(dbCommitMs);

  const endingSpec = next.ending_id ? quest.endings.find((e) => e.id === next.ending_id) : undefined;

  return {
    narration: response.narration,
    status: updatedSession.status,
    ending: endingSpec
      ? { id: endingSpec.id, title: endingSpec.title, direction: endingSpec.direction }
      : undefined,
    refused: response.refused,
    session: updatedSession,
  };
}
