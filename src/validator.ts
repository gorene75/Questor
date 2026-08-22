// Pure quest-file validator. No I/O, no network, no database.
// Implements every rule in the "Validator rules" section of docs/schema.md.

export interface DispositionSpec {
  axis: string;
  levels: string[];
  starts_at: string;
  floor: string;
  ceiling: string;
}

export interface AtLevelSpec {
  behaviour: string;
  withholds: string[];
}

export interface CharacterSpec {
  name: string;
  presence: string;
  surface: string;
  interior: string;
  may_guide?: boolean;
  disposition: DispositionSpec;
  moves_toward: string[];
  moves_away: string[];
  never_moves_for: string[];
  at_level: Record<string, AtLevelSpec>;
}

export interface DiscoverableSpec {
  id: string;
  trigger: string;
  requires?: string;
  reveal: string;
  sets?: string[];
}

export interface ExitSpec {
  id: string;
  when: string;
  requires?: string;
  requires_phase?: string;
  to: string;
  sets?: string[];
}

export interface BeatSpec {
  at_turn: number;
  event: string;
  goto?: string;
  sets?: string[];
  once?: boolean;
}

export interface OnFailSpec {
  when: string;
  to: string;
}

export interface GuardedEventSpec {
  id: string;
  trigger: string;
  requires?: string;
  on_blocked: string;
}

export interface SceneSpec {
  id: string;
  title: string;
  opens_with: string;
  returns_with?: string;
  requires?: string;
  requires_phase?: string;
  present: string[];
  truths: string[];
  impossible: string[];
  discoverable: DiscoverableSpec[];
  exits: ExitSpec[];
  guarded_events?: GuardedEventSpec[];
  beats?: BeatSpec[];
  on_fail?: OnFailSpec;
}

export interface EndingSpec {
  id: string;
  title: string;
  direction: string;
  result: "win" | "loss";
}

export interface ClockAdvanceSpec {
  exit?: string;
  scene?: string;
  turns_in_scene?: number;
  to: string;
}

export interface ClockSpec {
  phases: string[];
  starts_at: string;
  advances_on: ClockAdvanceSpec[];
}

export interface CanonSpec {
  facts: string[];
  secrets: string[];
  secret_handling: string;
}

export interface MetaSpec {
  id: string;
  title: string;
  source?: string;
  player_role: string;
  premise: string;
  structure: "rails" | "open";
  estimated_turns: number;
  start_scene: string;
  schema_version: number;
}

export interface NarratorSpec {
  voice: string;
  turn_length: string;
  extra_rules: string[];
  extra_refusals: string[];
}

export interface Quest {
  meta: MetaSpec;
  clock: ClockSpec;
  canon: CanonSpec;
  characters: Record<string, CharacterSpec>;
  flags: Record<string, boolean>;
  derived: Record<string, string>;
  scenes: SceneSpec[];
  endings: EndingSpec[];
  narrator: NarratorSpec;
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

// ---- expression parsing ----
// Supported grammar: AND, OR, NOT, parentheses, bare flag/derived identifiers,
// and `character.<id> >= <level>`.

interface CharacterRef {
  character: string;
  level: string;
}

interface ParsedExpression {
  identifiers: string[];
  characterRefs: CharacterRef[];
}

const CHARACTER_REF_RE = /character\.([a-zA-Z_][\w-]*)\s*>=\s*([a-zA-Z_][\w-]*)/g;
const KEYWORDS = new Set(["and", "or", "not"]);

function parseExpression(expr: string): ParsedExpression {
  const characterRefs: CharacterRef[] = [];
  let stripped = expr;
  for (const match of expr.matchAll(CHARACTER_REF_RE)) {
    characterRefs.push({ character: match[1]!, level: match[2]! });
  }
  stripped = stripped.replace(CHARACTER_REF_RE, " ");

  const identifiers = stripped
    .split(/[^a-zA-Z0-9_-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .filter((token) => !KEYWORDS.has(token.toLowerCase()));

  return { identifiers, characterRefs };
}

// ---- main entry point ----

export function validateQuest(quest: Quest): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const declaredFlags = new Set(Object.keys(quest.flags ?? {}));
  const declaredDerived = new Set(Object.keys(quest.derived ?? {}));
  const declaredCharacters = new Set(Object.keys(quest.characters ?? {}));
  const phases = new Set(quest.clock?.phases ?? []);
  const scenes = quest.scenes ?? [];
  const endings = quest.endings ?? [];
  const sceneIds = new Set(scenes.map((s) => s.id));
  const endingIds = new Set(endings.map((e) => e.id));

  const flagsRead = new Set<string>();
  const flagsSet = new Set<string>();

  // Every flag ever named in a `sets` array. Also must be declared.
  function checkSets(flagIds: string[], context: string) {
    for (const f of flagIds) {
      flagsSet.add(f);
      if (!declaredFlags.has(f)) {
        errors.push(`Flag '${f}' set in ${context} is not declared`);
      }
    }
  }

  for (const scene of scenes) {
    for (const exit of scene.exits ?? []) {
      checkSets(exit.sets ?? [], `exit '${exit.id}' (scene '${scene.id}') sets`);
    }
    for (const d of scene.discoverable ?? []) {
      checkSets(d.sets ?? [], `discoverable '${d.id}' (scene '${scene.id}') sets`);
    }
    for (const beat of scene.beats ?? []) {
      checkSets(beat.sets ?? [], `beat at_turn ${beat.at_turn} (scene '${scene.id}') sets`);
    }
  }

  // Resolve a single expression: check identifiers/character-refs against
  // declared flags/derived/characters/levels, and record reads.
  function checkExpression(expr: string, context: string) {
    const { identifiers, characterRefs } = parseExpression(expr);

    for (const id of identifiers) {
      const isFlag = declaredFlags.has(id);
      const isDerived = declaredDerived.has(id);
      if (!isFlag && !isDerived) {
        errors.push(
          `Flag or derived expression '${id}' referenced in ${context} is not declared`
        );
        continue;
      }
      if (isFlag) flagsRead.add(id);
    }

    for (const ref of characterRefs) {
      if (!declaredCharacters.has(ref.character)) {
        errors.push(
          `Character '${ref.character}' referenced in ${context} is not declared`
        );
        continue;
      }
      const levels = quest.characters[ref.character]!.disposition?.levels ?? [];
      if (!levels.includes(ref.level)) {
        errors.push(
          `Disposition level '${ref.level}' referenced in ${context} is not a valid level for character '${ref.character}' (levels: ${levels.join(", ")})`
        );
      }
    }
  }

  // Requires-on-a-flag-that's-never-set check needs its own tracking,
  // since it only applies to identifiers used to *gate* something
  // (requires / derived), not to every mention.
  const gatingFlagUsages = new Map<string, string>(); // flag -> first context

  function checkGatingExpression(expr: string, context: string) {
    checkExpression(expr, context);
    const { identifiers } = parseExpression(expr);
    for (const id of identifiers) {
      if (declaredFlags.has(id) && !gatingFlagUsages.has(id)) {
        gatingFlagUsages.set(id, context);
      }
    }
  }

  function checkRequiresPhase(phase: string | undefined, context: string) {
    if (!phase) return;
    if (!phases.has(phase)) {
      errors.push(
        `requires_phase '${phase}' in ${context} is not one of the clock's declared phases (${[...phases].join(", ")})`
      );
      return;
    }
    const reachablePhases = new Set<string>([quest.clock.starts_at]);
    for (const adv of quest.clock.advances_on ?? []) reachablePhases.add(adv.to);
    if (!reachablePhases.has(phase)) {
      errors.push(
        `requires_phase '${phase}' in ${context} is never reached by clock.advances_on`
      );
    }
  }

  // derived formulas are expressions too, and their flag references count
  // as both "read" and "gating" (a derived value gates something).
  for (const [name, formula] of Object.entries(quest.derived ?? {})) {
    checkGatingExpression(formula, `derived '${name}'`);
  }

  // meta / start_scene
  if (!quest.meta?.start_scene) {
    errors.push("meta.start_scene is missing");
  } else if (!sceneIds.has(quest.meta.start_scene)) {
    errors.push(`meta.start_scene '${quest.meta.start_scene}' does not exist among scenes`);
  }

  // canon.secrets vs win endings
  const hasWinEnding = endings.some((e) => e.result === "win");
  if (hasWinEnding && (quest.canon?.secrets?.length ?? 0) === 0) {
    errors.push("canon.secrets is empty but the quest has a win ending");
  }

  // Build reachability graph over scenes + endings.
  const adjacency = new Map<string, string[]>();
  function addEdge(from: string, to: string) {
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from)!.push(to);
  }

  function checkTarget(id: string | undefined, kind: string, context: string): boolean {
    if (!id) return false;
    if (!sceneIds.has(id) && !endingIds.has(id)) {
      errors.push(`${kind} '${id}' in ${context} does not point to an existing scene or ending`);
      return false;
    }
    return true;
  }

  for (const scene of scenes) {
    // present characters declared
    for (const charId of scene.present ?? []) {
      if (!declaredCharacters.has(charId)) {
        errors.push(`Character '${charId}' referenced in scene '${scene.id}' present list is not declared`);
      }
    }

    // scene-level requires / requires_phase
    if (scene.requires) {
      checkGatingExpression(scene.requires, `scene '${scene.id}' requires`);
    }
    checkRequiresPhase(scene.requires_phase, `scene '${scene.id}'`);

    // discoverables
    for (const d of scene.discoverable ?? []) {
      if (d.requires) {
        checkGatingExpression(d.requires, `discoverable '${d.id}' (scene '${scene.id}') requires`);
      }
    }

    // guarded_events — same gating mechanism as exits, no scene transition of their own
    for (const ge of scene.guarded_events ?? []) {
      if (ge.requires) {
        checkGatingExpression(ge.requires, `guarded_event '${ge.id}' (scene '${scene.id}') requires`);
      }
    }

    // exits
    for (const exit of scene.exits ?? []) {
      if (exit.requires) {
        checkGatingExpression(exit.requires, `exit '${exit.id}' (scene '${scene.id}') requires`);
      }
      checkRequiresPhase(exit.requires_phase, `exit '${exit.id}' (scene '${scene.id}')`);

      if (checkTarget(exit.to, "exit.to", `scene '${scene.id}' exit '${exit.id}'`)) {
        addEdge(scene.id, exit.to);
      }
    }

    // beats
    for (const beat of scene.beats ?? []) {
      if (beat.goto) {
        if (checkTarget(beat.goto, "beat.goto", `scene '${scene.id}' beat at_turn ${beat.at_turn}`)) {
          addEdge(scene.id, beat.goto);
        }
      }
    }

    // on_fail
    if (scene.on_fail) {
      checkGatingExpression(scene.on_fail.when, `scene '${scene.id}' on_fail.when`);
      if (checkTarget(scene.on_fail.to, "on_fail.to", `scene '${scene.id}' on_fail`)) {
        addEdge(scene.id, scene.on_fail.to);
      }
    }

    // scene with no exits and no on_fail
    if ((scene.exits ?? []).length === 0 && !scene.on_fail) {
      warnings.push(`Scene '${scene.id}' has no exits and no on_fail`);
    }
  }

  // reachability from start_scene
  const reachable = new Set<string>();
  if (quest.meta?.start_scene && (sceneIds.has(quest.meta.start_scene) || endingIds.has(quest.meta.start_scene))) {
    const queue = [quest.meta.start_scene];
    reachable.add(quest.meta.start_scene);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of adjacency.get(current) ?? []) {
        if (!reachable.has(next)) {
          reachable.add(next);
          queue.push(next);
        }
      }
    }
  }

  for (const scene of scenes) {
    if (!reachable.has(scene.id)) {
      errors.push(`Scene '${scene.id}' is unreachable from start_scene '${quest.meta?.start_scene}'`);
    }
  }

  const reachableWinEndings = endings.filter((e) => e.result === "win" && reachable.has(e.id));
  if (endings.length > 0 && reachableWinEndings.length === 0) {
    errors.push("No path from start_scene to any win ending");
  }

  for (const ending of endings) {
    if (!reachable.has(ending.id)) {
      warnings.push(`Ending '${ending.id}' is unreachable from start_scene`);
    }
  }

  // flags used in a requires/derived gate but never set anywhere (the v1 dusk_reached bug)
  for (const [flag, context] of gatingFlagUsages) {
    if (!flagsSet.has(flag)) {
      errors.push(`Flag '${flag}' is required in ${context} but is never set by any exit or discoverable`);
    }
  }

  // flags declared but never set, or set and never read
  for (const flag of declaredFlags) {
    if (!flagsSet.has(flag)) {
      warnings.push(`Flag '${flag}' is declared but never set`);
    } else if (!flagsRead.has(flag)) {
      warnings.push(`Flag '${flag}' is set but never read`);
    }
  }

  // characters: ceiling above starts_at but no moves_toward
  for (const [charId, character] of Object.entries(quest.characters ?? {})) {
    const disposition = character.disposition;
    if (!disposition) continue;
    const levels = disposition.levels ?? [];
    const startIdx = levels.indexOf(disposition.starts_at);
    const ceilingIdx = levels.indexOf(disposition.ceiling);
    if (startIdx === -1 || ceilingIdx === -1) continue;
    if (ceilingIdx > startIdx && (character.moves_toward ?? []).length === 0) {
      warnings.push(`Character '${charId}' has ceiling above starts_at but no moves_toward entries`);
    }
  }

  // discoverables unreachable because their character-level gate exceeds that character's ceiling
  for (const scene of scenes) {
    for (const d of scene.discoverable ?? []) {
      if (!d.requires) continue;
      const { characterRefs } = parseExpression(d.requires);
      for (const ref of characterRefs) {
        const character = quest.characters?.[ref.character];
        if (!character?.disposition) continue;
        const levels = character.disposition.levels ?? [];
        const requiredIdx = levels.indexOf(ref.level);
        const ceilingIdx = levels.indexOf(character.disposition.ceiling);
        if (requiredIdx === -1 || ceilingIdx === -1) continue;
        if (requiredIdx > ceilingIdx) {
          warnings.push(
            `Discoverable '${d.id}' (scene '${scene.id}') requires character.${ref.character} >= ${ref.level}, but '${ref.character}' can never rise above ceiling '${character.disposition.ceiling}'`
          );
        }
      }
    }
  }

  // guarded events: a scene with a present character whose discoverables set
  // a flag required elsewhere, but the scene has no guarded_events at all —
  // that character can be narrated out of the story with nothing gating it.
  // This is a heuristic, not a precise character-attribution check: the
  // schema has no field tying a discoverable to which present character
  // reveals it, so this flags at the scene level and expects author judgment
  // (e.g. a discoverable that's a physical object rather than something a
  // character says isn't actually at risk, even if it sets a load-bearing flag).
  for (const scene of scenes) {
    if ((scene.guarded_events ?? []).length > 0) continue;
    const loadBearingDiscoverable = (scene.discoverable ?? []).find((d) =>
      (d.sets ?? []).some((f) => gatingFlagUsages.has(f))
    );
    if (!loadBearingDiscoverable) continue;
    for (const charId of scene.present ?? []) {
      warnings.push(
        `Scene '${scene.id}' has character '${charId}' present and a discoverable ('${loadBearingDiscoverable.id}') that sets a flag required elsewhere, but no guarded_events — the character could be narrated as leaving/dismissed with nothing gating it`
      );
    }
  }

  return { errors, warnings };
}
