// Pure prompt assembly. No I/O, no network — the template text is compiled in
// via promptTemplate.ts (generated from prompts/play-agent.md), not read from disk.

import type { CharacterSpec, DiscoverableSpec, ExitSpec, Quest } from "./validator.ts";
import { evaluateExpression, type ExprContext } from "./expr.ts";
import { PLAY_AGENT_TEMPLATE } from "./promptTemplate.ts";

export interface SessionState {
  current_scene: string;
  phase: string;
  flags: Record<string, boolean>;
  /** character id -> current disposition level. Absent entries default to that character's starts_at. */
  characters: Record<string, string>;
  /** every detail invented so far this session, across all scenes. */
  invented: string[];
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
  return `- ${exit.id} (${status}): "${exit.when}" -> ${exit.to}${reasonText}`;
}

function describeDiscoverable(d: DiscoverableSpec, ctx: ExprContext): string {
  const available = d.requires ? evaluateExpression(d.requires, ctx) : true;
  const status = available ? "available" : "unavailable";

  if (available) {
    return `- ${d.id} (${status}): trigger "${d.trigger}" -> reveal: ${d.reveal}`;
  }
  return `- ${d.id} (${status}): trigger "${d.trigger}" — requires '${d.requires}' — reveal withheld until then`;
}

function buildScene(quest: Quest, session: SessionState): string {
  const scene = findScene(quest, session.current_scene);
  const ctx = buildExprContext(quest, session);

  const exitLines = (scene.exits ?? []).map((exit) => describeExit(exit, ctx, session.phase));
  const discoverableLines = (scene.discoverable ?? []).map((d) => describeDiscoverable(d, ctx));

  return [
    `Current phase: ${session.phase}`,
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
  ].join("\n");
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

export function buildPrompt(
  quest: Quest,
  session: SessionState,
  recentHistory: TurnRecord[],
  playerInput: string
): string {
  const sections: Record<string, string> = {
    FRAME: buildFrame(quest),
    CANON: buildCanon(quest),
    SCENE: buildScene(quest, session),
    CHARACTERS: buildCharacters(quest, session),
    INVENTED: buildInvented(session),
    HISTORY: buildHistory(recentHistory),
    INPUT: playerInput,
  };

  let output = PLAY_AGENT_TEMPLATE;
  for (const [name, content] of Object.entries(sections)) {
    output = fillPlaceholder(output, name, content);
  }
  return output;
}
