// Turn resolution and enforcement — the piece BUILD.md calls "the model
// judges, the engine decides." Nothing the model reports is trusted until
// checked against the quest file and current session state.

import type { CharacterSpec, GuardedEventSpec, Quest, SceneSpec } from "./validator.ts";
import { evaluateExpression, type ExprContext } from "./expr.ts";
import { addMinutes, derivePhaseFromProgress } from "./clock.ts";
import { buildPromptParts, type SessionState, type TurnRecord } from "./prompt.ts";
import { selectModel, type ModelAdapter, type ModelEnv } from "./models/index.ts";
import { findRelationalKnowledge, isPresent } from "./objects.ts";
import {
  commitTurn,
  discloseRelational,
  discloseSceneAmbient,
  discloseToPlayer,
  loadObjectPlacement,
  loadPlayerKnowledge,
  loadQuestByVersion,
  loadSession,
  logTurn,
  moveObject,
  type DbClient,
  type Session,
  type SessionCheckpoint,
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
  disposition_changes: DispositionChange[];
  invented: string[];
  refused: boolean;
  /** Pure narrative flavor, never gating — only used at all when the quest configures optional clock.story_time, and even then only as a fallback behind an exit's own costs_minutes. Phase and any deadline are driven entirely by clock.advances_on, never by this. */
  minutes_elapsed?: number;
}

export interface TurnResult {
  narration: string;
  status: SessionStatus;
  ending?: { id: string; title: string; direction: string; trigger?: string };
  refused: boolean;
  session: Session;
}

const FALLBACK_NARRATION = "The moment passes without incident.";

// Unbounded growth was confirmed in the prompt audit (~65 chars/turn, never
// shrinking) — invented texture is cosmetic flavor, not load-bearing, so
// only the most recent entries are worth keeping in context.
const MAX_INVENTED = 15;

/** Keeps each string's LAST occurrence only, preserving overall order — a
 * re-invented detail (same text reported again) counts as "still relevant"
 * rather than aging out early. */
function dedupeKeepLast(items: string[]): string[] {
  const lastIndex = new Map<string, number>();
  items.forEach((item, i) => lastIndex.set(item, i));
  return items.filter((item, i) => lastIndex.get(item) === i);
}

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

  // A suggestion, not a contract field — silently dropped rather than
  // rejected if missing or nonsensical, since an authored costs_minutes or
  // clock.default_turn_cost_minutes always covers the gap.
  const minutesElapsed =
    typeof obj.minutes_elapsed === "number" && Number.isFinite(obj.minutes_elapsed) && obj.minutes_elapsed >= 0
      ? obj.minutes_elapsed
      : undefined;

  return {
    narration: obj.narration,
    exit_id: obj.exit_id as string | null,
    guarded_event_id: (obj.guarded_event_id ?? null) as string | null,
    discovered: obj.discovered as string[],
    disposition_changes: dispositionChanges,
    invented: obj.invented as string[],
    refused: obj.refused,
    minutes_elapsed: minutesElapsed,
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
  session: Session,
  objectPlacement: Record<string, string | null>
): string[] {
  const errors: string[] = [];
  const ctx = buildContext(quest, session.flags, session.characters);

  if (response.exit_id !== null) {
    const exit = (scene.exits ?? []).find((e) => e.id === response.exit_id);
    if (!exit) {
      errors.push(`exit_id '${response.exit_id}' is not a legal exit of scene '${scene.id}'`);
    } else {
      // An active degradation's `unlocks` bypasses this exit's requires gate
      // entirely — that's the whole point of unlocking it: the clean path
      // was missed, but the story doesn't dead-end because of it.
      const unlockedByDegradation = session.active_degradations.some((degId) =>
        (quest.degradations?.[degId]?.unlocks ?? []).includes(exit.id)
      );
      if (exit.requires && !unlockedByDegradation && !evaluateExpression(exit.requires, ctx)) {
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

  for (const change of response.disposition_changes) {
    if (!quest.characters[change.character]) {
      errors.push(`disposition_changes names unknown character '${change.character}'`);
      continue;
    }
    if (!isPresent(objectPlacement, change.character, scene.id)) {
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
  systemStatic: string,
  systemDynamic: string,
  baseUser: string,
  priorErrors: string[] | null,
  quest: Quest,
  scene: SceneSpec,
  session: Session,
  objectPlacement: Record<string, string | null>
): Promise<Attempt> {
  // system stays stable across a retry — only the user turn grows, with the
  // rejection reason attached to what the model is actually responding to.
  const userSent = priorErrors
    ? `${baseUser}\n\n---\n\nYour previous response was rejected for these reasons: ${priorErrors.join(
        "; "
      )}\n\nReturn corrected JSON only, following the output contract exactly. No prose, no code fences.`
    : baseUser;

  const modelCallStart = Date.now();
  const { text, inputTokens, outputTokens } = await model.complete(systemStatic, systemDynamic, userSent);
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
    errors = errors.concat(validateTurnResponse(parsed, quest, scene, session, objectPlacement));
  }
  const validationMs = Date.now() - validationStart;

  return {
    promptSent: `[SYSTEM]\n${systemStatic}\n\n${systemDynamic}\n\n[USER]\n${userSent}`,
    rawText: text,
    parsed,
    validation: { valid: errors.length === 0, errors },
    inputTokens,
    outputTokens,
    modelCallMs,
    validationMs,
  };
}

// Whether a failed final attempt should fall into a degradation instead of
// the generic "commit nothing" dead end: the model must still be insisting
// on the same guarded_event_id, that event must declare on_allowed.degrade,
// and — critically — the guarded_event's unmet requires must be the *only*
// reason this attempt was rejected. Any other error alongside it means
// something else is wrong with the response, and the safer outcome is the
// ordinary fallback, not silently accepting a response that also failed
// some unrelated check.
function findDegradeEligibleGuardedEvent(attempt: Attempt, scene: SceneSpec): GuardedEventSpec | null {
  if (!attempt.parsed || attempt.parsed.guarded_event_id === null) return null;
  const guardedEvent = (scene.guarded_events ?? []).find((g) => g.id === attempt.parsed!.guarded_event_id);
  if (!guardedEvent?.on_allowed?.degrade) return null;
  const onlyError =
    attempt.validation.errors.length === 1 &&
    attempt.validation.errors[0]!.startsWith(`guarded_event '${guardedEvent.id}' requires`);
  return onlyError ? guardedEvent : null;
}

// ---- state transition ----

interface NextState {
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
  status: SessionStatus;
  ending_id: string | null;
  ending_trigger: string | null;
  /** Set only when this turn entered a scene whose act differs from the one just left — undefined otherwise, meaning "leave the session's existing checkpoint alone." */
  checkpoint: SessionCheckpoint | undefined;
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

function computeNextState(
  quest: Quest,
  session: Session,
  scene: SceneSpec,
  response: ModelTurnResponse,
  playerInput: string,
  /** Set only when both model attempts insisted on a guarded_event whose `requires` was never met and which declares `on_allowed.degrade` — the event is let through in degraded form instead of dead-ending. */
  forcedDegrade: GuardedEventSpec | null = null
): NextState {
  const flags: Record<string, boolean> = { ...session.flags };

  // discoverable.sets and exit.sets are quest-authored, deterministic
  // mappings the engine already knows — this is the only place flags get
  // set. There used to also be a model-reported flags_set field; it was
  // removed from the turn contract because it was a second, unchecked
  // channel for the same information: live testing showed a model setting
  // a flag directly via flags_set with no matching discovered/exit_id
  // behind it — the exact class of ungated consequence guarded_events
  // exists to catch, just through a different door. The engine deriving
  // every flag from something it already validated closes that door
  // entirely, per the general rule: never ask the model to report
  // anything the engine can derive.
  for (const discoveredId of response.discovered) {
    const discoverable = (scene.discoverable ?? []).find((d) => d.id === discoveredId);
    for (const f of discoverable?.sets ?? []) flags[f] = true;
  }
  if (response.exit_id !== null) {
    const takenExit = (scene.exits ?? []).find((e) => e.id === response.exit_id);
    for (const f of takenExit?.sets ?? []) flags[f] = true;
  }

  // Progress counter — the whole clock now runs on this, not on elapsed
  // turns or minutes. Only a declared clock.advances_on event moves it, and
  // only the first time it happens; a thorough player asking twenty
  // questions that never trigger a *new* one doesn't advance the clock at
  // all. Exits and discoverables are marked here; beats mark themselves
  // in their own loop below, since they haven't fired yet at this point.
  const progressEvents = [...session.progress_events];
  function markProgress(eventId: string) {
    if (quest.clock.advances_on.includes(eventId) && !progressEvents.includes(eventId)) {
      progressEvents.push(eventId);
    }
  }
  for (const discoveredId of response.discovered) markProgress(discoveredId);
  if (response.exit_id !== null) markProgress(response.exit_id);

  // guarded_events.on_allowed.degrade — the event was let through in a worse
  // state rather than blocked or dead-ended. Applied once per session per
  // degradation; a degradation's `unlocks` then stays in effect for every
  // later turn via the check in validateTurnResponse.
  const activeDegradations = [...session.active_degradations];
  if (forcedDegrade?.on_allowed?.degrade) {
    const degId = forcedDegrade.on_allowed.degrade;
    if (!activeDegradations.includes(degId)) activeDegradations.push(degId);
    for (const f of quest.degradations?.[degId]?.sets ?? []) flags[f] = true;
  }

  // fired_beats is shared by beats (below) and pressure (next) — both are
  // "once per session" backstops keyed by scene, so one array covers both.
  const firedBeats = [...session.fired_beats];

  const characters: Record<string, string> = { ...session.characters };
  for (const change of response.disposition_changes) {
    const characterSpec = quest.characters[change.character];
    if (!characterSpec) continue; // already rejected by validation if this could happen
    const currentLevel = characters[change.character] ?? characterSpec.disposition.starts_at;
    characters[change.character] = clampedStep(characterSpec, currentLevel, change.direction);
  }

  const invented = dedupeKeepLast([...session.invented, ...response.invented]).slice(-MAX_INVENTED);
  const transcript: TurnRecord[] = [...session.transcript, { player_input: playerInput, narration: response.narration }];

  let currentScene = session.current_scene;
  let sceneTurnCount = session.scene_turn_count;
  if (response.exit_id !== null) {
    const exit = (scene.exits ?? []).find((e) => e.id === response.exit_id)!;
    currentScene = exit.to;
    sceneTurnCount = 0;
  } else if (forcedDegrade?.on_allowed?.goto) {
    currentScene = forcedDegrade.on_allowed.goto;
    sceneTurnCount = 0;
  } else {
    sceneTurnCount += 1;
  }

  // pressure — idle-turn tracking plus the escalation backstop. A turn
  // counts as idle when it sets no flag, triggers no discoverable, takes no
  // exit, and fires no guarded event (forcedDegrade counts as firing one).
  // Scoped to the scene the player was actually idling in — `scene`, not
  // wherever this turn's own exit/forcedDegrade just sent them; if either of
  // those already moved the player on, this turn plainly wasn't idle and the
  // reset below reflects that either way.
  //
  // The exhaustion check below deliberately uses session.idle_turns — the
  // count *entering* this turn — rather than the post-this-turn value
  // computed just after it. That's the same count buildPromptParts used to
  // decide this turn's escalation hint, so the turn where the model is shown
  // the final line is exactly the turn the engine forces on_exhausted, not
  // one turn later — the model's own narration and the engine's forced
  // state change land on the same turn instead of one lagging the other.
  const wasIdle =
    response.exit_id === null && response.discovered.length === 0 && response.guarded_event_id === null && !forcedDegrade;
  const alreadyLeftScene = currentScene !== session.current_scene;
  let idleTurns = alreadyLeftScene ? 0 : wasIdle ? session.idle_turns + 1 : 0;

  if (!alreadyLeftScene && scene.pressure) {
    const { idle_after_turns, escalation, on_exhausted } = scene.pressure;
    const tier = Math.floor(session.idle_turns / idle_after_turns);
    const pressureKey = `${scene.id}#pressure`;
    if (tier >= escalation.length && !firedBeats.includes(pressureKey)) {
      // Same resolution a model-insisted degrade uses: apply on_allowed.degrade
      // only if the event's own requires is genuinely still unmet (skip it
      // if the player actually satisfied it and just lingered afterward —
      // that's not a missed opportunity, just an overstayed one), and force
      // on_allowed.goto regardless, since the opportunity closes either way.
      const pressureEvent = (scene.guarded_events ?? []).find((g) => g.id === on_exhausted)!;
      const ctxNow = buildContext(quest, flags, characters);
      const requiresUnmet = !!pressureEvent.requires && !evaluateExpression(pressureEvent.requires, ctxNow);
      if (requiresUnmet && pressureEvent.on_allowed?.degrade) {
        const degId = pressureEvent.on_allowed.degrade;
        if (!activeDegradations.includes(degId)) activeDegradations.push(degId);
        for (const f of quest.degradations?.[degId]?.sets ?? []) flags[f] = true;
      }
      if (pressureEvent.on_allowed?.goto) {
        currentScene = pressureEvent.on_allowed.goto;
        sceneTurnCount = 0;
      }
      firedBeats.push(pressureKey);
      idleTurns = 0;
    }
  }

  // story_time: purely optional narrative flavor, only touched at all when
  // the quest configures clock.story_time. Never read back for phase or a
  // deadline — those come entirely from progressEvents.length below.
  let storyTime: string | null = session.story_time;
  if (quest.clock.story_time) {
    let minutesElapsed: number;
    const takenExitForCost = response.exit_id !== null ? (scene.exits ?? []).find((e) => e.id === response.exit_id) : undefined;
    if (takenExitForCost?.costs_minutes !== undefined) {
      minutesElapsed = takenExitForCost.costs_minutes;
    } else if (response.minutes_elapsed !== undefined) {
      minutesElapsed = Math.min(response.minutes_elapsed, 60);
    } else {
      minutesElapsed = quest.clock.story_time.default_turn_cost_minutes;
    }
    storyTime = addMinutes(storyTime!, minutesElapsed);
  }

  const sceneAfterExit = quest.scenes.find((s) => s.id === currentScene);
  if (sceneAfterExit) {
    const beatsInOrder = [...(sceneAfterExit.beats ?? [])].sort((a, b) => a.at_turn - b.at_turn);
    for (const beat of beatsInOrder) {
      const key = `${sceneAfterExit.id}#${beat.at_turn}`;
      if (firedBeats.includes(key)) continue;
      if (sceneTurnCount < beat.at_turn) continue;

      for (const f of beat.sets ?? []) flags[f] = true;
      if (beat.id) markProgress(beat.id);
      if (beat.costs_minutes && quest.clock.story_time) {
        storyTime = addMinutes(storyTime!, beat.costs_minutes);
      }
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

  // Phase is derived fresh here, once every progress-contributing event this
  // turn (discoverables, the exit, and any beats above) has had its chance
  // to advance the counter.
  const phase = derivePhaseFromProgress(quest.clock.phases, progressEvents.length);

  // clock.deadline — the whole-quest backstop, checked before the
  // scene-local max_turns one below. `on_reached.mode` is a per-quest
  // choice: "ending" forces a named ending outright (and, like beats/on_fail,
  // wins over max_turns this same turn — an authored "time's up" moment
  // beats a generic, unauthored safety net); "degrade" (the default) applies
  // a named degradation and lets the story continue, so max_turns still
  // needs to apply normally on every later turn — nothing else guarantees
  // termination for a session that keeps playing past its deadline.
  // Checked against the progress counter, in plot-relevant events, not real
  // time or turn count — a thorough player who triggers no new advances_on
  // event never moves this at all.
  let deadlineForcedEnding = false;
  if (quest.clock.deadline && progressEvents.length >= quest.clock.deadline.at) {
    const onReached = quest.clock.deadline.on_reached;
    const mode = onReached.mode ?? "degrade";
    if (mode === "ending") {
      deadlineForcedEnding = true;
      currentScene = onReached.ending!;
    } else {
      const degId = onReached.degrade!;
      if (!activeDegradations.includes(degId)) activeDegradations.push(degId);
      for (const f of quest.degradations?.[degId]?.sets ?? []) flags[f] = true;
    }
  }

  // max_turns termination backstop — every scene has one (default 25)
  // whether declared or not. Checked last, after exits/beats/on_fail/
  // deadline have already had their chance to move things along, so it
  // only fires when the player is genuinely stuck in the same scene.
  // Falls back to the quest's first universal_ending when the scene
  // declares no on_exhausted of its own — the validator guarantees at
  // least one of those exists.
  let maxTurnsTriggered = false;
  const sceneForMaxTurns = deadlineForcedEnding ? undefined : quest.scenes.find((s) => s.id === currentScene);
  if (sceneForMaxTurns) {
    const maxTurns = sceneForMaxTurns.max_turns ?? 25;
    if (sceneTurnCount > maxTurns) {
      maxTurnsTriggered = true;
      if (sceneForMaxTurns.on_exhausted) {
        currentScene = sceneForMaxTurns.on_exhausted;
      } else if ((quest.universal_endings ?? []).length > 0) {
        currentScene = quest.universal_endings![0]!.id;
      }
    }
  }

  let status: SessionStatus = session.status;
  let endingId: string | null = null;
  let endingTrigger: string | null = null;
  const ending =
    quest.endings.find((e) => e.id === currentScene) ?? (quest.universal_endings ?? []).find((e) => e.id === currentScene);
  if (ending) {
    endingId = ending.id;
    status = ending.result === "win" ? "won" : "lost";
    // Only meaningful when an engine backstop is what actually landed us
    // here this turn — an ending reached through ordinary play (an exit, an
    // authored on_fail) has an obvious cause already visible in the quest
    // file, so it gets no trigger reason. The whole point of this field is
    // to separate "the story genuinely ran out of road" from "an author
    // forgot to write an ending for a branch that's actually reachable" —
    // that question only exists for the generic safety nets.
    if (deadlineForcedEnding) endingTrigger = "deadline_reached";
    else if (maxTurnsTriggered) endingTrigger = "max_turns_exceeded";
  }

  // Anything that moved the player on after pressure's own check (beats,
  // on_fail, the deadline, max_turns) leaves the scene idle_turns was
  // tracking — zero it regardless of source, same as scene_turn_count
  // conceptually restarts on any scene change.
  const finalIdleTurns = currentScene === session.current_scene ? idleTurns : 0;

  // checkpoint: written the moment play enters a scene whose act differs
  // from the one just left (undeclared act counts as its own "no act"
  // bucket, distinct from any named one). Never written for an ending —
  // there's nothing to rewind *to* there. A full snapshot, not just the
  // fields most obviously narrative (flags/characters/degradations/
  // invented): transcript and progress_events are included too, since a
  // stale transcript would leak the failed attempt straight back into the
  // next prompt via {{HISTORY}}, defeating the point of a clean rewind.
  let checkpoint: SessionCheckpoint | undefined;
  if (currentScene !== session.current_scene) {
    const previousAct = quest.scenes.find((s) => s.id === session.current_scene)?.act;
    const enteredScene = quest.scenes.find((s) => s.id === currentScene);
    if (enteredScene && enteredScene.act !== previousAct) {
      checkpoint = {
        scene: currentScene,
        phase,
        progress_events: progressEvents,
        story_time: storyTime,
        flags,
        characters,
        invented,
        transcript,
        scene_turn_count: sceneTurnCount,
        fired_beats: firedBeats,
        active_degradations: activeDegradations,
        idle_turns: finalIdleTurns,
      };
    }
  }

  return {
    current_scene: currentScene,
    phase,
    progress_events: progressEvents,
    story_time: storyTime,
    flags,
    characters,
    invented,
    transcript,
    scene_turn_count: sceneTurnCount,
    fired_beats: firedBeats,
    active_degradations: activeDegradations,
    idle_turns: finalIdleTurns,
    status,
    ending_id: endingId,
    ending_trigger: endingTrigger,
    checkpoint,
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

  // turnStart now starts here, before loadPlayerKnowledge — that DB read
  // used to run before this timer existed at all, making its ~120ms
  // invisible in total_ms and every other logged field. It's real
  // request-handling time; it belongs in the same clock as the rest.
  const turnIndex = session.transcript.length;
  const turnStart = Date.now();

  // Presence seeding, generic for every scene, not just s1_baker_street: the
  // moment a scene is freshly entered (scene_turn_count still 0 — true for a
  // brand-new session's start scene, and true again after any exit/beat/
  // pressure transition resets it), object_placement is seeded from that
  // scene's own scene.present. scene.present's only remaining role is this
  // seed value — it is no longer read as a live presence gate anywhere.
  // From here on, isPresent (computed from object_placement) decides who
  // gets a full behaviour block; a genuine departure (moveObject to null or
  // elsewhere) removes someone from it the same turn it happens, which a
  // static array never could.
  if (session.scene_turn_count === 0) {
    for (const charId of scene.present ?? []) {
      await moveObject(client, sessionId, charId, scene.id);
    }
  }

  // Object-disclosure mechanism (src/objects.ts, src/db.ts) — generic, read
  // for every scene. Only s1_baker_street has real conditional content
  // seeded into it so far; every other scene just finds nothing.
  const knownObjects = await loadPlayerKnowledge(client, sessionId);
  const objectPlacement = await loadObjectPlacement(client, sessionId);

  const sessionState: SessionState = {
    current_scene: session.current_scene,
    phase: session.phase,
    story_time: session.story_time,
    flags: session.flags,
    characters: session.characters,
    invented: session.invented,
    idle_turns: session.idle_turns,
    pressure_fired: session.fired_beats.includes(`${session.current_scene}#pressure`),
    known_objects: knownObjects,
    object_placement: objectPlacement,
  };
  const { systemStatic, systemDynamic, user: baseUser } = buildPromptParts(quest, sessionState, session.transcript, playerInput);

  const attempts: Attempt[] = [];
  attempts.push(await attemptTurn(model, systemStatic, systemDynamic, baseUser, null, quest, scene, session, objectPlacement));

  let final = attempts[0]!;
  if (!final.validation.valid) {
    const attempt2 = await attemptTurn(
      model,
      systemStatic,
      systemDynamic,
      baseUser,
      final.validation.errors,
      quest,
      scene,
      session,
      objectPlacement
    );
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

  let forcedDegrade: GuardedEventSpec | null = null;
  if (!final.validation.valid || !final.parsed) {
    forcedDegrade = final.parsed ? findDegradeEligibleGuardedEvent(final, scene) : null;
    if (!forcedDegrade) {
      // Second failure, with no degrade to fall into: commit nothing,
      // return a null-exit fallback.
      await logAllAttempts(0);
      return {
        narration: FALLBACK_NARRATION,
        status: session.status,
        refused: false,
        session,
      };
    }
    // Falls through: the event is allowed to happen after all, in degraded
    // form, using this same final attempt's narration and other fields —
    // everything about it passed validation except the one gate that's
    // about to be bent instead of enforced.
  }

  const response = final.parsed!;

  // Object-disclosure side effects, scoped to s1_baker_street. Every id used
  // here (discoveredId, guarded_event_id, exit_id) already passed
  // validateTurnResponse by this point — same trust boundary computeNextState
  // itself relies on. discloseToPlayer/discloseRelational/moveObject are the
  // only writers of player_knowledge/object_placement; nothing here ever
  // takes the model's word for who's present or what's been disclosed, only
  // what the engine just validated.
  if (scene.id === "s1_baker_street") {
    // The room itself fails the one-object test (only one action: observe —
    // no separate open/read/take of "the room"), so its ambient content is
    // disclosed as one bundle straight from the scene's own static data, not
    // through a game_objects row. Fires once per entry (scene_turn_count
    // still 0, i.e. this is the first turn since arriving); idempotent, so a
    // later re-entry just re-asserts the same content.
    if (session.scene_turn_count === 0) {
      await discloseSceneAmbient(client, sessionId, scene.id, { description: scene.opens_with });
    }

    const ctx = buildContext(quest, session.flags, session.characters);
    for (const discoveredId of response.discovered) {
      const discoverable = (scene.discoverable ?? []).find((d) => d.id === discoveredId);
      const discloses = discoverable?.discloses;
      if (!discloses) continue;
      if ("object_id" in discloses) {
        await discloseToPlayer(client, sessionId, quest, discloses.object_id, discloses.fields);
      } else {
        const relational = findRelationalKnowledge(quest, discloses.holder_id, discloses.subject_ref);
        const gateOk = !relational?.disclosure_gate || evaluateExpression(relational.disclosure_gate, ctx);
        if (gateOk) {
          await discloseRelational(client, sessionId, quest, discloses.holder_id, discloses.subject_ref, discloses.fields);
        }
      }
    }
    // Helen stepping out requires the same validated guarded_events gate as
    // everything else the model reports — never inferred from narration.
    if (response.guarded_event_id === "helen_departs") {
      await moveObject(client, sessionId, "helen", null);
    }
  }

  const next = computeNextState(quest, session, scene, response, playerInput, forcedDegrade);

  // Presence seeding, generic: if this turn's validated exit/beat/pressure
  // transition actually moved the story to a new scene, seed the
  // destination's present list immediately — same seeding as the
  // scene_turn_count===0 check above, just re-applied here so
  // object_placement reflects the destination within the SAME turn that
  // caused the transition (a beat placing Roylott into s2_intrusion, say),
  // rather than only from the next turn onward. Never inferred from
  // narration — next.current_scene only differs here because a validated
  // exit/beat/guarded_event/pressure event actually fired.
  if (next.current_scene !== session.current_scene) {
    const destScene = quest.scenes.find((s) => s.id === next.current_scene);
    for (const charId of destScene?.present ?? []) {
      await moveObject(client, sessionId, charId, next.current_scene);
    }
  }

  if (scene.id === "s1_baker_street") {
    // A real, validated exit to Surrey is the only way stoke_moran becomes
    // reachable — asking to travel without one never touches this. stoke_moran
    // is a place, never a member of any scene.present list, so it can't ride
    // the generic seeding above — it stays its own explicit rule.
    if (response.exit_id === "to_surrey") {
      await moveObject(client, sessionId, "stoke_moran", next.current_scene);
    }
  }

  const commitStart = Date.now();
  const updatedSession = await commitTurn(client, sessionId, {
    current_scene: next.current_scene,
    phase: next.phase,
    progress_events: next.progress_events,
    story_time: next.story_time,
    flags: next.flags,
    characters: next.characters,
    invented: next.invented,
    transcript: next.transcript,
    scene_turn_count: next.scene_turn_count,
    fired_beats: next.fired_beats,
    active_degradations: next.active_degradations,
    idle_turns: next.idle_turns,
    status: next.status,
    ending_id: next.ending_id,
    ending_trigger: next.ending_trigger,
    checkpoint: next.checkpoint,
  });
  const dbCommitMs = Date.now() - commitStart;

  await logAllAttempts(dbCommitMs);

  const endingSpec = next.ending_id
    ? (quest.endings.find((e) => e.id === next.ending_id) ??
      (quest.universal_endings ?? []).find((e) => e.id === next.ending_id))
    : undefined;

  return {
    narration: response.narration,
    status: updatedSession.status,
    ending: endingSpec
      ? {
          id: endingSpec.id,
          title: endingSpec.title,
          direction: endingSpec.direction,
          trigger: next.ending_trigger ?? undefined,
        }
      : undefined,
    refused: response.refused,
    session: updatedSession,
  };
}

// ---- rewind ----

/**
 * Restores a session to its most recent act-entry checkpoint — a clean
 * rewind, not a partial one. Every field the model's next prompt would read
 * (transcript for {{HISTORY}}, invented for {{INVENTED}}, flags/characters/
 * degradations for scene state, progress_events/fired_beats/scene_turn_count/
 * idle_turns for the engine's own bookkeeping) is overwritten with the
 * checkpoint's stored values, and status/ending are reset to active/null so
 * the session is playable again. Nothing about the failed attempt survives
 * anywhere the model or the engine would ever read it back — the model has
 * no memory beyond what's re-fed from session state each turn, so restoring
 * this row *is* restoring its memory, completely.
 *
 * Manual and explicit only, for now: callers decide when a loss warrants
 * offering this, not the engine. There's no rule yet for which losses
 * should and shouldn't.
 */
export async function rewindToCheckpoint(client: DbClient, sessionId: string): Promise<Session> {
  const session = await loadSession(client, sessionId);
  if (!session) throw new Error(`No session found with id '${sessionId}'`);
  if (!session.checkpoint) {
    throw new Error(`Session '${sessionId}' has no checkpoint to rewind to`);
  }
  const cp = session.checkpoint;

  return commitTurn(client, sessionId, {
    current_scene: cp.scene,
    phase: cp.phase,
    progress_events: cp.progress_events,
    story_time: cp.story_time,
    flags: cp.flags,
    characters: cp.characters,
    invented: cp.invented,
    transcript: cp.transcript,
    scene_turn_count: cp.scene_turn_count,
    fired_beats: cp.fired_beats,
    active_degradations: cp.active_degradations,
    idle_turns: cp.idle_turns,
    status: "active",
    ending_id: null,
    ending_trigger: null,
    // checkpoint itself is left untouched (commitTurn's undefined-means-
    // unchanged convention) — a second failed attempt at the same act
    // should still be able to rewind back to this same point.
  });
}
