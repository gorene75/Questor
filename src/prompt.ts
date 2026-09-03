// Pure prompt assembly. No I/O, no network — the template text is compiled in
// via promptTemplate.ts (generated from prompts/play-agent.md), not read from disk.

import type { CharacterSpec, DiscoverableSpec, ExitSpec, GuardedEventSpec, Quest, SceneSpec } from "./validator.ts";
import { evaluateExpression, type ExprContext } from "./expr.ts";
import { formatTimeOfDay } from "./clock.ts";
import { PLAY_AGENT_TEMPLATE } from "./promptTemplate.ts";

export interface SessionState {
  current_scene: string;
  phase: string;
  /** ISO story-time — shown to the model as just the time-of-day, never the raw machine datetime. Null unless the quest configures optional clock.story_time; purely flavor, never implies anything about phase or a deadline. */
  story_time: string | null;
  flags: Record<string, boolean>;
  /** character id -> current disposition level. Absent entries default to that character's starts_at. */
  characters: Record<string, string>;
  /** every detail invented so far this session, across all scenes. */
  invented: string[];
  /** Consecutive idle turns in the current scene, entering this turn — drives which pressure escalation line (if any) to show. */
  idle_turns: number;
  /** True once this scene's pressure has already forced its on_exhausted guarded_event — suppresses further escalation text, since the opportunity already resolved. */
  pressure_fired: boolean;
}

export interface TurnRecord {
  /** null for the session-opening turn, which has no player input. */
  player_input: string | null;
  narration: string;
}

function joinLines(lines: string[], emptyText: string): string {
  return lines.length > 0 ? lines.join("\n") : emptyText;
}

function joinInline(items: string[]): string {
  return items.length > 0 ? items.join("; ") : "(none)";
}

function findScene(quest: Quest, sceneId: string) {
  const scene = quest.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`Unknown current_scene '${sceneId}'`);
  return scene;
}

function buildExprContext(quest: Quest, session: SessionState): ExprContext {
  const characterLevels: ExprContext["characterLevels"] = {};
  for (const [id, character] of Object.entries(quest.characters)) {
    characterLevels[id] = {
      levels: character.disposition.levels,
      current: session.characters[id] ?? character.disposition.starts_at,
    };
  }
  return { flags: session.flags, derived: quest.derived, characterLevels };
}

function buildFrame(quest: Quest): string {
  return [
    `Player role: ${quest.meta.player_role}`,
    `Premise: ${quest.meta.premise}`,
    `Voice: ${quest.narrator.voice}`,
    `Turn length: ${quest.narrator.turn_length}`,
    `Extra rules:`,
    joinLines(quest.narrator.extra_rules.map((r) => `- ${r}`), "(none)"),
    `Extra refusals:`,
    joinLines(quest.narrator.extra_refusals.map((r) => `- ${r}`), "(none)"),
  ].join("\n");
}

function buildWorld(quest: Quest): string {
  const world = quest.world;
  if (!world) return "(no world frame declared — use ordinary judgment about what belongs)";

  return [
    `Setting: ${world.setting}`,
    `Register: ${world.register}`,
    `Physics: ${world.physics}`,
    `Supernatural: ${world.supernatural}`,
    `Weirdness: ${world.weirdness}/10`,
    "",
    "Absent (illustrative pattern, not a checklist):",
    joinLines(world.absent.map((a) => `- ${a}`), "(none declared)"),
    "",
    "Present (illustrative pattern, not a checklist):",
    joinLines(world.present.map((p) => `- ${p}`), "(none declared)"),
    "",
    `Anachronism handling: ${world.anachronism_response}`,
  ].join("\n");
}

function buildCanon(quest: Quest): string {
  return [
    "Facts:",
    joinLines(quest.canon.facts.map((f) => `- ${f}`), "(none)"),
    "",
    "Secrets — never reveal, hint, or gesture toward:",
    joinLines(quest.canon.secrets.map((s) => `- ${s}`), "(none)"),
    "",
    `Secret handling: ${quest.canon.secret_handling}`,
  ].join("\n");
}

function describeExit(exit: ExitSpec, ctx: ExprContext, phase: string): string {
  const reasons: string[] = [];
  let available = true;

  if (exit.requires) {
    if (!evaluateExpression(exit.requires, ctx)) {
      available = false;
      reasons.push(`requires '${exit.requires}'`);
    }
  }
  if (exit.requires_phase && exit.requires_phase !== phase) {
    available = false;
    reasons.push(`requires phase '${exit.requires_phase}' (current phase is '${phase}')`);
  }

  const status = available ? "available" : "unavailable";
  const reasonText = reasons.length > 0 ? ` — ${reasons.join(", ")}` : "";
  // transition is only worth showing once the exit could actually be taken
  // this turn — an author's departure text for an exit that's still locked
  // would just be noise (and a spoiler of sorts) attached to an unavailable line.
  const transitionText = available && exit.transition ? ` — if taken, narrate the departure as: ${exit.transition}` : "";
  return `- ${exit.id} (${status}): "${exit.when}" -> ${exit.to}${reasonText}${transitionText}`;
}

function describeDiscoverable(d: DiscoverableSpec, ctx: ExprContext): string {
  const available = d.requires ? evaluateExpression(d.requires, ctx) : true;
  const status = available ? "available" : "unavailable";

  if (available) {
    return `- ${d.id} (${status}): trigger "${d.trigger}" -> reveal: ${d.reveal}`;
  }
  return `- ${d.id} (${status}): trigger "${d.trigger}" — requires '${d.requires}' — reveal withheld until then`;
}

function describeGuardedEvent(ge: GuardedEventSpec, ctx: ExprContext): string {
  const available = ge.requires ? evaluateExpression(ge.requires, ctx) : true;
  const status = available ? "available" : "blocked";

  if (available) {
    return `- ${ge.id} (${status}): trigger "${ge.trigger}"`;
  }
  return `- ${ge.id} (${status}): trigger "${ge.trigger}" — requires '${ge.requires}' — if this comes up, narrate it as: ${ge.on_blocked}`;
}

/**
 * The one escalation line (if any) to show for this turn. Tier k (1-indexed)
 * covers idle_turns in [idle_after_turns*k, idle_after_turns*(k+1) - 1);
 * tier >= escalation.length all show the last line — that's also the tier at
 * which the engine forces on_exhausted, so the last line is written to read
 * naturally as the moment itself, not just another nudge toward it.
 * pressure_fired silences this scene's pressure entirely once it's resolved.
 */
function buildPressureHint(scene: SceneSpec, session: SessionState): string | null {
  if (!scene.pressure || session.pressure_fired) return null;
  const { idle_after_turns, escalation } = scene.pressure;
  const tier = Math.floor(session.idle_turns / idle_after_turns);
  if (tier < 1) return null;
  return escalation[Math.min(tier, escalation.length) - 1]!;
}

function buildScene(quest: Quest, session: SessionState): string {
  const scene = findScene(quest, session.current_scene);
  const ctx = buildExprContext(quest, session);

  const exitLines = (scene.exits ?? []).map((exit) => describeExit(exit, ctx, session.phase));
  const discoverableLines = (scene.discoverable ?? []).map((d) => describeDiscoverable(d, ctx));
  const guardedEventLines = (scene.guarded_events ?? []).map((ge) => describeGuardedEvent(ge, ctx));
  const pressureHint = buildPressureHint(scene, session);

  const lines = [
    session.story_time ? `Current time: ${formatTimeOfDay(session.story_time)} (${session.phase})` : `Current phase: ${session.phase}`,
    "",
    "Truths:",
    joinLines(scene.truths.map((t) => `- ${t}`), "(none)"),
    "",
    "Impossible:",
    joinLines(scene.impossible.map((i) => `- ${i}`), "(none)"),
    "",
    "Discoverables:",
    joinLines(discoverableLines, "(none)"),
    "",
    "Exits:",
    joinLines(exitLines, "(none)"),
    "",
    "Guarded events:",
    joinLines(guardedEventLines, "(none)"),
  ];

  if (pressureHint) {
    lines.push(
      "",
      "World pressure — work this into your narration this turn, naturally, as something that happens rather than something you announce:",
      pressureHint
    );
  }

  return lines.join("\n");
}

function buildCharacterBlock(charId: string, character: CharacterSpec, session: SessionState): string {
  const level = session.characters[charId] ?? character.disposition.starts_at;
  const atLevel = character.at_level[level];
  if (!atLevel) {
    throw new Error(`Character '${charId}' has no at_level entry for level '${level}'`);
  }

  return [
    `### ${character.name} (${charId})`,
    `Presence: ${character.presence}`,
    `Surface: ${character.surface}`,
    `Interior: ${character.interior}`,
    `May guide: ${character.may_guide ?? false}`,
    `Disposition axis: ${character.disposition.axis} — currently: ${level}`,
    `Behaviour at this level: ${atLevel.behaviour}`,
    `Withholds at this level: ${joinInline(atLevel.withholds)}`,
    `Moves toward: ${joinInline(character.moves_toward)}`,
    `Moves away: ${joinInline(character.moves_away)}`,
    `Never moves for: ${joinInline(character.never_moves_for)}`,
  ].join("\n");
}

function buildCharacters(quest: Quest, session: SessionState): string {
  const scene = findScene(quest, session.current_scene);
  const blocks = (scene.present ?? []).map((charId) => {
    const character = quest.characters[charId];
    if (!character) throw new Error(`Scene '${scene.id}' lists unknown character '${charId}'`);
    return buildCharacterBlock(charId, character, session);
  });
  return blocks.length > 0 ? blocks.join("\n\n") : "(no one present)";
}

function buildInvented(session: SessionState): string {
  return joinLines(
    session.invented.map((detail) => `- ${detail}`),
    "(nothing invented yet)"
  );
}

function buildHistory(recentHistory: TurnRecord[]): string {
  const last6 = recentHistory.slice(-6);
  if (last6.length === 0) return "(this is the first turn)";

  return last6
    .map((turn) => {
      const lines: string[] = [];
      if (turn.player_input !== null) lines.push(`Player: ${turn.player_input}`);
      lines.push(`Narrator: ${turn.narration}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function fillPlaceholder(template: string, name: string, content: string): string {
  const placeholderLine = new RegExp(`^\\{\\{${name}\\}\\}$`, "m");
  if (!placeholderLine.test(template)) {
    throw new Error(`Prompt template is missing placeholder line {{${name}}}`);
  }
  return template.replace(placeholderLine, () => content);
}

function fillTemplate(
  quest: Quest,
  session: SessionState,
  recentHistory: TurnRecord[],
  inputSectionContent: string
): string {
  const sections: Record<string, string> = {
    FRAME: buildFrame(quest),
    WORLD: buildWorld(quest),
    CANON: buildCanon(quest),
    SCENE: buildScene(quest, session),
    CHARACTERS: buildCharacters(quest, session),
    INVENTED: buildInvented(session),
    HISTORY: buildHistory(recentHistory),
    INPUT: inputSectionContent,
  };

  let output = PLAY_AGENT_TEMPLATE;
  for (const [name, content] of Object.entries(sections)) {
    output = fillPlaceholder(output, name, content);
  }
  return output;
}

/**
 * Single combined string, matching BUILD.md's documented prompt.ts
 * signature — every placeholder filled, including the player's literal
 * input. Kept for eyeballing/debugging (scripts/test-prompt.ts) and
 * backward compatibility; the real model call uses buildPromptParts below,
 * which keeps the player's input out of the instructional block entirely.
 */
export function buildPrompt(
  quest: Quest,
  session: SessionState,
  recentHistory: TurnRecord[],
  playerInput: string
): string {
  return fillTemplate(quest, session, recentHistory, playerInput);
}

/**
 * Splits the prompt into system (frame/canon/scene/characters/invented/
 * history plus all instructions) and user (just the player's raw input).
 * Sending the whole assembled prompt as a single user-role message — as
 * buildPrompt's output would be, passed through unsplit — reads to a model
 * trained on the system/user convention as a briefing to acknowledge, not a
 * question to answer: live testing on Claude Haiku showed a 100% first-
 * attempt failure rate ("I understand this system prompt completely...
 * what quest are we running?") purely from that structural mismatch, with
 * every turn needing a second call to actually respond.
 */
export function buildPromptParts(
  quest: Quest,
  session: SessionState,
  recentHistory: TurnRecord[],
  playerInput: string
): { system: string; user: string } {
  const system = fillTemplate(quest, session, recentHistory, "(sent separately as the next message — respond to it directly)");
  return { system, user: playerInput };
}
