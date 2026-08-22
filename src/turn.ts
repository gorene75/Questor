// Turn resolution and enforcement — the piece BUILD.md calls "the model
// judges, the engine decides." Nothing the model reports is trusted until
// checked against the quest file and current session state.

import type { CharacterSpec, Quest, SceneSpec } from "./validator.ts";
import { evaluateExpression, type ExprContext } from "./expr.ts";
import { buildPrompt, type SessionState, type TurnRecord } from "./prompt.ts";
import type { ModelAdapter } from "./models/index.ts";
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
  promptSent: string;
  rawText: string;
  parsed: ModelTurnResponse | null;
  validation: TurnValidationResult;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
}

async function attemptTurn(
  model: ModelAdapter,
  basePrompt: string,
  priorErrors: string[] | null,
  quest: Quest,
  scene: SceneSpec,
  session: Session
): Promise<Attempt> {
  const promptSent = priorErrors
    ? `${basePrompt}\n\n---\n\nYour previous response was rejected for these reasons: ${priorErrors.join(
        "; "
      )}\n\nReturn corrected JSON only, following the output contract exactly. No prose, no code fences.`
    : basePrompt;

  const start = Date.now();
  const { text, inputTokens, outputTokens } = await model.complete("", promptSent);
  const latencyMs = Date.now() - start;

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

  return {
    promptSent,
    rawText: text,
    parsed,
    validation: { valid: errors.length === 0, errors },
    inputTokens,
    outputTokens,
    latencyMs,
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
  model: ModelAdapter;
  sessionId: string;
  playerInput: string;
}): Promise<TurnResult> {
  const { client, model, sessionId, playerInput } = params;

  const session = await loadSession(client, sessionId);
  if (!session) throw new Error(`No session found with id '${sessionId}'`);
  if (session.status !== "active") {
    throw new Error(`Session '${sessionId}' is already '${session.status}' — no further turns accepted`);
  }

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
  const basePrompt = buildPrompt(quest, sessionState, session.transcript, playerInput);

  const turnIndex = session.transcript.length;

  const attempt1 = await attemptTurn(model, basePrompt, null, quest, scene, session);
  await logTurn(client, {
    session_id: sessionId,
    turn_index: turnIndex,
    player_input: playerInput,
    prompt: attempt1.promptSent,
    raw_response: attempt1.rawText,
    parsed: attempt1.parsed,
    validation: attempt1.validation,
    model: model.name,
    input_tokens: attempt1.inputTokens,
    output_tokens: attempt1.outputTokens,
    latency_ms: attempt1.latencyMs,
  });

  let final = attempt1;
  if (!attempt1.validation.valid) {
    const attempt2 = await attemptTurn(model, basePrompt, attempt1.validation.errors, quest, scene, session);
    await logTurn(client, {
      session_id: sessionId,
      turn_index: turnIndex,
      player_input: playerInput,
      prompt: attempt2.promptSent,
      raw_response: attempt2.rawText,
      parsed: attempt2.parsed,
      validation: attempt2.validation,
      model: model.name,
      input_tokens: attempt2.inputTokens,
      output_tokens: attempt2.outputTokens,
      latency_ms: attempt2.latencyMs,
    });
    final = attempt2;
  }

  if (!final.validation.valid || !final.parsed) {
    // Second failure: commit nothing, return a null-exit fallback.
    return {
      narration: FALLBACK_NARRATION,
      status: session.status,
      refused: false,
      session,
    };
  }

  const response = final.parsed;
  const next = computeNextState(quest, session, scene, response, playerInput);

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
