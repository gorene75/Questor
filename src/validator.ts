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
  /** Expression (same syntax as a discoverable's `requires`) gating when this character becomes known — nameable/discussable but not yet able to appear or act. Omit to default to known from the start (the common case: a character already named in canon.facts as case background). Independent of scene.present, which gates actually being able to act/speak. */
  known_when?: string;
}

export interface DiscoverableSpec {
  id: string;
  trigger: string;
  requires?: string;
  reveal: string;
  sets?: string[];
  /** When this discoverable fires, copy these field names from the named game_object's resolved content into the player's player_knowledge row (via discloseToPlayer) instead of — or alongside — setting flags. See src/objects.ts. */
  discloses?: { object_id: string; fields: string[] };
}

export interface ExitSpec {
  id: string;
  when: string;
  requires?: string;
  requires_phase?: string;
  to: string;
  sets?: string[];
  /** Pure narrative flavor — only meaningful when clock.story_time is configured, and never gates anything. Taking this exit is real clock progress only if its id also appears in clock.advances_on. */
  costs_minutes?: number;
  /** Instruction for how to narrate this specific departure (2-3 sentences), shown to the model once the exit is available — parallel to a scene's opens_with, but for the passage itself. Omit for a direct cut with no explicit passage. */
  transition?: string;
}

export interface BeatSpec {
  at_turn: number;
  event: string;
  goto?: string;
  sets?: string[];
  once?: boolean;
  /** Pure narrative flavor — only meaningful when clock.story_time is configured, and never gates anything. */
  costs_minutes?: number;
  /** Optional id so this beat can be named in clock.advances_on — beats have no id otherwise, unlike exits and discoverables. */
  id?: string;
}

export interface OnFailSpec {
  when: string;
  to: string;
}

export interface GuardedEventOnAllowedSpec {
  /** Degradation id to apply when the event is ultimately allowed to happen despite `requires` never being satisfied — the model insisted through both attempts, so the story bends into a worse state instead of dead-ending. Must name a key in quest.degradations. */
  degrade?: string;
  /** Scene or ending to force when the degrade above is applied. null (or omitted) means stay in the current scene. */
  goto?: string | null;
}

export interface GuardedEventSpec {
  id: string;
  trigger: string;
  requires?: string;
  on_blocked: string;
  on_allowed?: GuardedEventOnAllowedSpec;
}

export interface DegradationSpec {
  description: string;
  sets?: string[];
  /** Exit ids (anywhere in the quest) whose `requires` gate is bypassed once this degradation is active. */
  unlocks?: string[];
  /** Flavor text describing what the degradation costs — informational, not read by the engine. */
  consequences?: string[];
  still_winnable: boolean;
  /** Required when still_winnable is false — the ending this degraded path must eventually route to. */
  ending?: string;
}

export interface PressureSpec {
  /** Consecutive idle turns (in this scene) before the first escalation line shows. Also the spacing between later tiers. */
  idle_after_turns: number;
  /** Ordered nudge lines. Tier k (1-indexed) shows escalation[k-1] once idle turns reach idle_after_turns * k. The last line covers every tier from escalation.length onward — reaching it is also the turn the engine forces on_exhausted. */
  escalation: string[];
  /** A guarded_events id declared in this same scene, forced through (same on_allowed resolution as a model-insisted degrade) once escalation is exhausted. */
  on_exhausted: string;
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
  /** Termination backstop. Defaults to 25 when unset — every scene has one whether declared or not. */
  max_turns?: number;
  /** Scene or ending id to force when max_turns is exceeded. Falls back to the quest's first universal_ending when unset. */
  on_exhausted?: string;
  /** Nudges a drifting player instead of letting them idle indefinitely — narrative escalation, then a forced guarded_event as the backstop. */
  pressure?: PressureSpec;
  /** Free-form grouping label, e.g. "act1". Scenes with no act declared are ungrouped and behave exactly as before — this is purely additive. On entering a scene whose act differs from the one just left, the engine snapshots session state into sessions.checkpoint, so a later rewind can return play to the start of that act. */
  act?: string;
}

export interface EndingSpec {
  id: string;
  title: string;
  direction: string;
  result: "win" | "loss";
}

export interface ClockPhaseSpec {
  name: string;
  /** Progress-counter value below which this phase applies. Phases are ordered ascending and never wrap — progress at or beyond every threshold falls into the last-declared phase. */
  until: number;
}

export interface DeadlineOnReachedSpec {
  /** "degrade" (default): apply a named degradation and keep playing. "ending": force a named ending outright. A per-quest choice — the deadline no longer assumes hitting it is fatal. */
  mode?: "degrade" | "ending";
  /** Required when mode is "ending". Must name a declared ending or universal_ending. */
  ending?: string;
  /** Required when mode is "degrade" (the default). Must name a key in quest.degradations. */
  degrade?: string;
}

export interface ClockDeadlineSpec {
  /** Progress-counter value — the quest-wide backstop. Once the progress counter reaches this, the engine forces `on_reached` regardless of scene. Expressed in plot-relevant events, not real time or turn count. */
  at: number;
  meaning: string;
  on_reached: DeadlineOnReachedSpec;
}

/** Fully optional — pure narrative flavor (a time-of-day line shown to the model), never used to derive phase or check a deadline. Most quests should skip this entirely. */
export interface ClockStoryTimeSpec {
  /** ISO datetime, e.g. "1883-04-06T07:15:00" — naive story-time, never timezone-aware. */
  starts_at: string;
  /** Minutes a turn costs when nothing more specific (an exit's costs_minutes) applies. */
  default_turn_cost_minutes: number;
}

export interface ClockSpec {
  /** Ids (of exits, discoverables, or beats — via BeatSpec.id) whose first occurrence advances the quest's progress counter by one. Each counts at most once per session, however many times it's re-triggered. Phases and any deadline are expressed entirely in terms of this counter — never real time, never elapsed turns. */
  advances_on: string[];
  phases: ClockPhaseSpec[];
  deadline?: ClockDeadlineSpec;
  /** Optional — see ClockStoryTimeSpec. Omit unless a quest specifically wants literal elapsed-time flavor text. */
  story_time?: ClockStoryTimeSpec;
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

export interface WorldSpec {
  setting: string;
  register: string;
  physics: string;
  supernatural: string;
  /** Illustrative, never exhaustive — a pattern for the model to generalize from, not a blocklist. */
  absent: string[];
  present: string[];
  anachronism_response: string;
  /** 0-10. How far the model may invent beyond what's declared; 0 = strictly in-frame, higher = more improvisation. */
  weirdness: number;
}

export interface Quest {
  meta: MetaSpec;
  world?: WorldSpec;
  clock: ClockSpec;
  canon: CanonSpec;
  characters: Record<string, CharacterSpec>;
  flags: Record<string, boolean>;
  derived: Record<string, string>;
  scenes: SceneSpec[];
  endings: EndingSpec[];
  /** Generic loss endings every quest inherits — a termination backstop, not part of the authored win/loss structure. Implicitly reachable from every scene via max_turns; never required to have an explicit path. */
  universal_endings?: EndingSpec[];
  /** Named worse-but-still-playable states a guarded_event or the clock deadline can fall into instead of blocking or dead-ending. */
  degradations?: Record<string, DegradationSpec>;
  narrator: NarratorSpec;
  /** World truth, hand-authored and static — the source game_objects rows are seeded from. Never read directly by prompt.ts; only discloseToPlayer (src/objects.ts / src/db.ts) may copy fields out of it into a session's player_knowledge. Experimental, scoped to s1_baker_street only for now — see src/objects.ts. */
  game_objects?: GameObjectSpec[];
}

export interface GameObjectSpec {
  id: string;
  type: "person" | "place" | "item" | "fact";
  resolved: Record<string, unknown>;
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
  const phases = new Set((quest.clock?.phases ?? []).map((p) => p.name));
  const scenes = quest.scenes ?? [];
  const endings = quest.endings ?? [];
  const universalEndings = quest.universal_endings ?? [];
  const sceneIds = new Set(scenes.map((s) => s.id));
  // Universal endings are valid targets for exit.to/beat.goto/on_fail.to/
  // on_exhausted just like authored endings — the engine can land on either.
  const endingIds = new Set([...endings, ...universalEndings].map((e) => e.id));

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
  for (const [degId, degradation] of Object.entries(quest.degradations ?? {})) {
    checkSets(degradation.sets ?? [], `degradation '${degId}' sets`);
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
    }
    // No reachability check beyond that: v3's clock has no discrete
    // "advance" triggers — every declared phase is reachable purely by
    // enough story-time passing, so there's nothing else to verify here.
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

  // clock: phase thresholds must be positive integers, strictly ascending —
  // progress is a monotonic counter, not a wrapping time-of-day, so there's
  // no circular case to allow for.
  let previousPhaseUntil = -1;
  for (const phase of quest.clock?.phases ?? []) {
    if (!Number.isInteger(phase.until) || phase.until < 0) {
      errors.push(`clock.phases '${phase.name}'.until = '${phase.until}' is not a non-negative integer`);
    } else if (phase.until <= previousPhaseUntil) {
      errors.push(`clock.phases '${phase.name}'.until (${phase.until}) is not strictly greater than the previous phase's until (${previousPhaseUntil})`);
    } else {
      previousPhaseUntil = phase.until;
    }
  }
  if (quest.clock?.story_time && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(quest.clock.story_time.starts_at)) {
    errors.push(`clock.story_time.starts_at '${quest.clock.story_time.starts_at}' is not a valid naive ISO datetime`);
  }
  if (quest.clock?.deadline) {
    const { at, on_reached } = quest.clock.deadline;
    if (!Number.isInteger(at) || at <= 0) {
      errors.push(`clock.deadline.at '${at}' is not a positive integer (progress-counter threshold)`);
    }
    const mode = on_reached?.mode ?? "degrade";
    if (mode !== "degrade" && mode !== "ending") {
      errors.push(`clock.deadline.on_reached.mode must be 'degrade' or 'ending', got '${mode}'`);
    } else if (mode === "ending") {
      if (!on_reached.ending) {
        errors.push(`clock.deadline.on_reached.mode is 'ending' but no 'ending' field is given`);
      } else if (!endingIds.has(on_reached.ending)) {
        errors.push(`clock.deadline.on_reached.ending '${on_reached.ending}' does not name a declared ending`);
      }
    } else {
      if (!on_reached.degrade) {
        errors.push(`clock.deadline.on_reached.mode is 'degrade' but no 'degrade' field is given`);
      } else if (!(quest.degradations ?? {})[on_reached.degrade]) {
        errors.push(`clock.deadline.on_reached.degrade '${on_reached.degrade}' does not name a declared degradation`);
      }
    }
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

  for (const [charId, character] of Object.entries(quest.characters ?? {})) {
    if (character.known_when) {
      checkGatingExpression(character.known_when, `character '${charId}' known_when`);
    }
  }

  const declaredGameObjects = new Set<string>();
  for (const obj of quest.game_objects ?? []) {
    if (declaredGameObjects.has(obj.id)) {
      errors.push(`game_objects has a duplicate id '${obj.id}'`);
    }
    declaredGameObjects.add(obj.id);
  }

  for (const scene of scenes) {
    // present characters declared
    for (const charId of scene.present ?? []) {
      if (!declaredCharacters.has(charId)) {
        errors.push(`Character '${charId}' referenced in scene '${scene.id}' present list is not declared`);
      }
    }

    // discoverable.discloses references a declared game_object
    for (const d of scene.discoverable ?? []) {
      if (d.discloses && !declaredGameObjects.has(d.discloses.object_id)) {
        errors.push(
          `discoverable '${d.id}' (scene '${scene.id}') discloses.object_id '${d.discloses.object_id}' does not name a declared game_object`
        );
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

    // guarded_events — same gating mechanism as exits. on_allowed.degrade is
    // the one way a guarded event does change reachability: falling into a
    // degradation instead of blocking or dead-ending forever.
    for (const ge of scene.guarded_events ?? []) {
      if (ge.requires) {
        checkGatingExpression(ge.requires, `guarded_event '${ge.id}' (scene '${scene.id}') requires`);
      }
      if (ge.on_allowed?.degrade && !(quest.degradations ?? {})[ge.on_allowed.degrade]) {
        errors.push(
          `guarded_event '${ge.id}' (scene '${scene.id}') on_allowed.degrade '${ge.on_allowed.degrade}' does not name a declared degradation`
        );
      }
      if (ge.on_allowed?.goto) {
        if (checkTarget(ge.on_allowed.goto, "guarded_event.on_allowed.goto", `scene '${scene.id}' guarded_event '${ge.id}'`)) {
          addEdge(scene.id, ge.on_allowed.goto);
        }
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

    // pressure — on_exhausted must name a guarded_event actually declared on
    // this same scene, since that's the only thing the engine knows how to
    // force through (reusing the same on_allowed resolution a model-insisted
    // degrade uses).
    if (scene.pressure) {
      const target = (scene.guarded_events ?? []).find((ge) => ge.id === scene.pressure!.on_exhausted);
      if (!target) {
        errors.push(
          `pressure.on_exhausted '${scene.pressure.on_exhausted}' (scene '${scene.id}') does not name a guarded_events id declared on this scene`
        );
      }

      // Idle turns can never outrun the scene's own turn count — every idle
      // turn is also a scene turn — so a beat or max_turns at or before
      // pressure's own exhaustion point always fires first, and pressure's
      // hard exhaustion (its on_exhausted force) can never actually be
      // reached, no matter how the player plays. The nudges still show
      // (they're keyed to the same always-reachable count); only the force
      // becomes dead code, which is easy to miss since the quest still
      // validates and plays.
      const exhaustionTurn = scene.pressure.idle_after_turns * scene.pressure.escalation.length;
      for (const beat of scene.beats ?? []) {
        if (beat.at_turn <= exhaustionTurn) {
          warnings.push(
            `Scene '${scene.id}' pressure exhausts at turn ${exhaustionTurn}, but beat at_turn ${beat.at_turn} fires no later — pressure's on_exhausted can never actually be reached`
          );
        }
      }
      const effectiveMaxTurns = scene.max_turns ?? 25;
      if (exhaustionTurn > effectiveMaxTurns) {
        warnings.push(
          `Scene '${scene.id}' pressure exhausts at turn ${exhaustionTurn}, but max_turns is ${effectiveMaxTurns} — pressure's on_exhausted can never actually be reached`
        );
      }
    }

    // on_exhausted — the max_turns termination backstop. Every scene has a
    // max_turns (default 25) whether declared or not, so every scene needs
    // somewhere to go when it's exceeded: either its own on_exhausted, or a
    // quest-wide universal_ending to fall back on.
    if (scene.on_exhausted) {
      if (checkTarget(scene.on_exhausted, "on_exhausted", `scene '${scene.id}'`)) {
        addEdge(scene.id, scene.on_exhausted);
      }
    } else if (universalEndings.length === 0) {
      errors.push(
        `Scene '${scene.id}' has no on_exhausted and the quest declares no universal_endings — nothing catches this scene if max_turns is ever exceeded`
      );
    }

    // scene with no exits and no on_fail
    if ((scene.exits ?? []).length === 0 && !scene.on_fail) {
      warnings.push(`Scene '${scene.id}' has no exits and no on_fail`);
    }

    // a scene busy enough to drift in deserves pressure to pull a player back
    if (!scene.pressure && ((scene.exits ?? []).length > 4 || (scene.discoverable ?? []).length > 4)) {
      warnings.push(`Scene '${scene.id}' has more than four exits or discoverables but no pressure declared`);
    }
  }

  // acts: partial adoption is the likely mistake here — a quest either uses
  // act grouping or it doesn't. There's no separate quest-level act
  // registry (acts are purely inferred from scene.act), so "an act with no
  // scenes" can't structurally happen; the only shape worth flagging is
  // some scenes opting in and others silently being left out.
  const scenesWithAct = scenes.filter((s) => s.act);
  if (scenesWithAct.length > 0) {
    const scenesWithoutAct = scenes.filter((s) => !s.act);
    for (const scene of scenesWithoutAct) {
      warnings.push(`Scene '${scene.id}' has no act declared, but other scenes in this quest do — likely an oversight`);
    }
  }

  // degradations: a still_winnable:false path must name somewhere it
  // eventually ends up, or it's exactly bug #2 — a branch that can neither
  // win nor terminate. unlocks must point at exits that actually exist
  // somewhere in the quest.
  const allExitIds = new Set(scenes.flatMap((s) => (s.exits ?? []).map((e) => e.id)));
  const referencedDegradations = new Set<string>();
  for (const ge of scenes.flatMap((s) => s.guarded_events ?? [])) {
    if (ge.on_allowed?.degrade) referencedDegradations.add(ge.on_allowed.degrade);
  }
  if (quest.clock?.deadline?.on_reached?.degrade) {
    referencedDegradations.add(quest.clock.deadline.on_reached.degrade);
  }
  for (const [degId, degradation] of Object.entries(quest.degradations ?? {})) {
    if (degradation.still_winnable === false) {
      if (!degradation.ending) {
        errors.push(`Degradation '${degId}' has still_winnable: false but names no ending`);
      } else if (!endingIds.has(degradation.ending)) {
        errors.push(`Degradation '${degId}' names ending '${degradation.ending}', which does not exist`);
      }
    }
    for (const exitId of degradation.unlocks ?? []) {
      if (!allExitIds.has(exitId)) {
        errors.push(`Degradation '${degId}' unlocks exit '${exitId}', which does not exist in any scene`);
      }
    }
    if (!referencedDegradations.has(degId)) {
      warnings.push(
        `Degradation '${degId}' is declared but never referenced by any guarded_event.on_allowed.degrade or clock.deadline.on_reached.degrade`
      );
    }
  }

  // clock.advances_on entries must name something that actually exists —
  // an exit id, a discoverable id, or a beat's own (optional) id. A typo
  // here silently means that event can never advance the progress counter.
  const allDiscoverableIds = new Set(scenes.flatMap((s) => (s.discoverable ?? []).map((d) => d.id)));
  const allBeatIds = new Set(scenes.flatMap((s) => (s.beats ?? []).flatMap((b) => (b.id ? [b.id] : []))));
  for (const eventId of quest.clock?.advances_on ?? []) {
    if (!allExitIds.has(eventId) && !allDiscoverableIds.has(eventId) && !allBeatIds.has(eventId)) {
      errors.push(`clock.advances_on '${eventId}' does not match any exit, discoverable, or beat id in the quest`);
    }
  }

  // universal_endings are an implicit edge from every scene (the max_turns
  // backstop can land on one even without on_exhausted declared) — wire
  // that into the reachability graph so they don't need bespoke exits, and
  // so their presence keeps every scene's termination story genuinely covered.
  if (universalEndings.length > 0) {
    for (const scene of scenes) {
      if (!scene.on_exhausted) addEdge(scene.id, universalEndings[0]!.id);
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

  // world.absent needs a pattern to generalize from, not a checklist — too
  // short and the model has nothing to extrapolate an era's missing
  // technology/attitudes from.
  if (quest.world && quest.world.absent.length < 3) {
    warnings.push(
      `world.absent has only ${quest.world.absent.length} entries — the model needs a pattern to generalize from, not a checklist (aim for at least 3)`
    );
  }

  return { errors, warnings };
}
