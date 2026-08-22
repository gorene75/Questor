# Quest schema v2

The contract between three things: the file an author (or the builder agent) produces, the engine that runs it, and the narrator prompt that plays it. Everything else in the system is downstream of this document.

**The central rule: the model judges, the engine decides.** The model interprets fuzzy player input and reports what it thinks happened. The engine holds the state and enforces what is allowed. Anything the player must not be able to do is enforced in code, never in the prompt. v1 failed this — the player reached a later scene without ever triggering the first one, because rails existed only as instructions.

---

## Top-level shape

```
{
  meta          — identity, framing, length
  clock         — time phases and how they advance
  canon         — facts, secrets, secret handling
  characters    — people with interiors and dispositions
  flags         — every boolean the quest uses, declared
  derived       — named boolean expressions over flags
  scenes        — places and what happens in them
  endings       — win and loss states
  narrator      — voice and per-quest overrides
}
```

---

## meta

```json
{
  "id": "kebab-case-unique",
  "title": "Display title",
  "source": "Attribution if adapted. Omit if original.",
  "player_role": "Who the player is. Second person throughout.",
  "premise": "One or two sentences. The situation, not the plot.",
  "structure": "rails" | "open",
  "estimated_turns": 30,
  "start_scene": "scene id",
  "schema_version": 2
}
```

`start_scene` is required. v1 relied on array order, which is implicit and fragile.

---

## clock

Time is a phase, not a flag. v1 gated the winning scene on a `dusk_reached` flag that nothing ever set, making the quest unwinnable. Phases make time explicit and validatable.

```json
{
  "phases": ["morning", "afternoon", "dusk", "night"],
  "starts_at": "morning",
  "advances_on": [
    { "exit": "to_surrey", "to": "afternoon" },
    { "turns_in_scene": 6, "scene": "s4_exterior", "to": "dusk" }
  ]
}
```

The clock only moves forward. Scenes and exits may require a phase via `requires_phase`. The engine advances the clock; the model never touches it.

---

## canon

```json
{
  "facts": ["Statements true for the whole quest. Freely stated when relevant."],
  "secrets": ["The solution and anything leading to it."],
  "secret_handling": "Instruction to the narrator about how absolutely to withhold."
}
```

The separation exists so the builder agent has an explicit job: every quest must declare what must never be said. A quest with an empty `secrets` array has no puzzle.

---

## characters

The most important addition in v2, and the fix for the failure v1 demonstrated: a character who simply answers is furniture, and players walk past furniture.

```json
{
  "helen": {
    "name": "Helen Stoner",
    "presence": "How they appear. Physical, brief.",
    "surface": "How they present before anything has happened between you.",
    "interior": "What they actually feel, want, and fear. The narrator knows this and plays it. The player is never told it.",
    "may_guide": false,

    "disposition": {
      "axis": "trust",
      "levels": ["closed", "guarded", "opening", "trusting"],
      "starts_at": "guarded",
      "floor": "closed",
      "ceiling": "trusting"
    },

    "moves_toward": [
      "Being given time. Not interrupting her.",
      "Any sign the player believes her rather than humouring her.",
      "Noticing the bruises without making her explain them."
    ],
    "moves_away": [
      "Rapid-fire questioning.",
      "Treating her fear as a symptom rather than a fact.",
      "Any hurry to leave."
    ],
    "never_moves_for": [
      "The player simply asserting a feeling — 'I calm her down', 'I reassure her'. Stating an intention is not doing the thing. Narrate the attempt landing flat.",
      "Flattery.",
      "Promises of protection made in the first minute."
    ],

    "at_level": {
      "closed": {
        "behaviour": "Apologises for coming. Says it was probably nothing. Moves toward the door.",
        "withholds": ["everything beyond the bare fact that her sister died"]
      },
      "guarded": {
        "behaviour": "Answers directly but volunteers nothing. Watches the door.",
        "withholds": ["the whistle", "the bruises", "her own fear for tonight"]
      },
      "opening": {
        "behaviour": "Begins to circle the night itself. Loses the thread and finds it again.",
        "withholds": ["the bruises"]
      },
      "trusting": {
        "behaviour": "Tells it whole, badly, in the wrong order, the way frightened people do.",
        "withholds": []
      }
    }
  }
}
```

**Mechanics.** The engine sends the model the character's current level and only that level's `at_level` block, plus the movement rules. The model returns a *direction* — `up`, `down`, or nothing — with a reason. The model never sets a level.

The engine applies it: **one step maximum per turn**, clamped to `floor` and `ceiling`. This is what stops a player talking their way from `closed` to `trusting` in a sentence, and it is enforced in code.

A character who cannot be won over gets `ceiling` equal to `starts_at`. Roylott starts and ends at `hostile`; the model may report `up` all it likes and nothing happens. That is how "charm does not work on him" becomes a fact rather than a hope.

`may_guide: false` on every character unless deliberately set. v1's Watson pointed the player toward the next scene, leaking the exit list through dialogue. Companions may be warm, admiring, and wrong. They may not navigate.

---

## flags

```json
{ "heard_the_account": false, "saw_ventilator": false }
```

Every flag the quest uses must be declared here. The validator rejects any flag referenced in an exit, requirement, or discoverable that is not declared, and warns on any flag declared but never set.

---

## derived

Named boolean expressions, so requirements read clearly and live in one place.

```json
{ "understands_room": "saw_dummy_bellpull AND saw_clamped_bed AND saw_ventilator" }
```

Supported: `AND`, `OR`, `NOT`, parentheses, flag names, and `character.helen >= opening`.

---

## scenes

```json
{
  "id": "s1_baker_street",
  "title": "221B Baker Street",
  "opens_with": "First-time entry text. Two sentences maximum.",
  "returns_with": "Text when re-entering. Shorter.",
  "requires": "derived expression or flag — engine-enforced entry condition",
  "requires_phase": "morning",

  "present": ["helen", "watson"],
  "truths": ["Facts true here. Held identically however often asked."],
  "impossible": ["Things the player will try that must fail plainly."],

  "discoverable": [
    {
      "id": "the_locked_door",
      "trigger": "asks how her sister died",
      "requires": "character.helen >= opening",
      "reveal": "What the player learns.",
      "sets": ["heard_the_account"]
    }
  ],

  "exits": [
    {
      "id": "to_surrey",
      "when": "player sets off for Stoke Moran",
      "requires": "heard_the_account",
      "to": "s4_exterior",
      "sets": []
    }
  ],

  "guarded_events": [
    {
      "id": "helen_departs",
      "trigger": "player dismisses Helen, says goodbye, or otherwise signals the interview is over",
      "requires": "heard_the_account",
      "on_blocked": "Something keeps her a moment longer — she hesitates at the door, or Watson asks one more question, or she simply isn't ready to leave yet. She does not actually go."
    }
  ],

  "beats": [
    { "at_turn": 8, "event": "Roylott arrives.", "goto": "s3_intrusion", "once": true },
    { "at_turn": 12, "event": "A step creaks on the stair below.", "sets": ["overstayed"], "once": true }
  ],

  "on_fail": { "when": "condition", "to": "ending id" }
}
```

**`requires` on both scenes and exits is enforced by the engine**, not requested of the model. If the condition is unmet, the exit does not exist that turn. The model is not told why — it narrates the attempt failing in-world.

**`requires` on a discoverable is the character gate.** This is where the interior mechanic pays off: the locked door is not available at `guarded`, no matter how the player phrases the question. Helen is not withholding strategically — she is frightened, and frightened people do not lead with the worst part.

**`impossible` is separate from `truths`** because it is the list the model most needs in front of it. The bed does not move. The window does not open.

**`guarded_events` is the same mechanism as `exits`, extended to narrated consequences that aren't a scene transition.** v1's `to_surrey` bug was fixed by putting real gates on literal exits — but a player can also narrate a character *out* of the story without ever taking an exit ("goodbye", "I dismiss her"), and nothing about that requires the engine's permission unless something explicitly gates it. If Helen leaves before `heard_the_account` is set, `ready_to_travel` can never become true and the quest soft-locks with no path to any ending, even though every exit and discoverable individually still validates fine — the failure is a narrated event nobody enforced, not a broken gate. `guarded_events` closes that: each entry names a `trigger` an author anticipates (a dismissal, a threat, an ending-adjacent line), a `requires` condition, and an `on_blocked` line telling the narrator how to hold the line gracefully when it fires too early. Same enforcement posture as everything else in this file — the engine decides, the model narrates within the decision.

**A beat may `sets` flags in addition to (or instead of) `goto`.** A time-based consequence — being caught searching, missing a window — is a deterministic threshold on `scene_turn_count`, not something the model is trusted to notice on its own. `on_fail` is evaluated immediately after beats fire each turn, so a beat that sets the flag named in `on_fail.when` ends the scene that same turn, without needing its own `goto`.

---

## endings

```json
{
  "id": "e_win",
  "title": "Shown to the player",
  "direction": "Instruction to the narrator, not text to recite.",
  "result": "win" | "loss"
}
```

`direction` rather than `text` so the ending still responds to how the player arrived. Every ending should carry an instruction not to explain the mechanism — the image does the work, and explaining it retroactively hands over the secret the whole quest protected.

---

## narrator

Per-quest overrides on the base prompt.

```json
{
  "voice": "Second person, past tense, Victorian register but plain.",
  "turn_length": "1-3 sentences",
  "extra_rules": [],
  "extra_refusals": []
}
```

---

## Turn contract

What the model must return. The engine parses this and rejects anything malformed.

```json
{
  "narration": "1-3 sentences.",
  "exit_id": "legal exit id, or null",
  "guarded_event_id": "legal guarded_events id, or null",
  "discovered": ["discoverable ids triggered this turn"],
  "flags_set": ["flags to raise"],
  "disposition_changes": [
    { "character": "helen", "direction": "up", "reason": "gave her time, did not press" }
  ],
  "invented": ["details invented this turn that must stay true"],
  "refused": false
}
```

**Engine validation before committing anything:**

1. `exit_id` is null or is a legal exit of the current scene
2. That exit's `requires` and `requires_phase` are satisfied
3. `guarded_event_id` is null or is a legal `guarded_events` id of the current scene, and its `requires` is satisfied — checked exactly like `exit_id`, but it names a narrated consequence rather than a scene transition, so satisfying it doesn't change `current_scene` on its own
4. Each `discovered` id belongs to the current scene and its `requires` is met
5. Each flag in `flags_set` is declared
6. `disposition_changes` are clamped to one step, within floor and ceiling
7. `invented` is appended to session state and fed back in every subsequent turn

Any failure: retry once with the error appended. On second failure, commit nothing, return a null-exit fallback narration, and log it. The log is how you tell a bad model from a bad file.

**When a `guarded_event_id` fails validation, the retry is seeded with that event's `on_blocked` text**, not just a bare rejection — the point isn't to make the model guess its way to a legal response, it's to get a *narratively graceful* one on the first retry: the character hesitates, gets interrupted, isn't ready, rather than the turn just silently failing twice and falling back to a null-exit non-answer.

---

## Validator rules

Runs before a quest is playable. Phase 2's builder agent calls this in a loop, so write it standalone.

**Errors — quest is unplayable:**
- Flag referenced anywhere but not declared
- Exit `to` pointing at a scene or ending that does not exist
- `start_scene` missing or nonexistent
- Scene unreachable from `start_scene`
- No path from start to any `result: "win"` ending
- `requires` on a flag that no exit or discoverable ever sets *(this is the v1 `dusk_reached` bug)*
- `requires_phase` naming a phase not in the clock, or unreachable given `advances_on`
- Character referenced in `present` or a `requires` but not declared
- Disposition level referenced in a requirement but not in that character's `levels`
- Empty `secrets` on a quest with a win condition

**Warnings — playable but suspect:**
- Flag declared and never set, or set and never read
- Discoverable no path can reach
- Character with `ceiling` above `starts_at` but no `moves_toward` entries
- Scene with no exits and no `on_fail`
- Ending unreachable
- A scene has a character present whose discoverables set a flag required elsewhere (by a `requires` or `derived` expression anywhere in the quest), but the scene has no `guarded_events` at all *(this is the s1 Helen-departure bug — a character can be narrated out of the story with nothing gating it, silently soft-locking the quest)*

The win-path check is the one that matters most. It is what a human author cannot reliably do by eye, and it is exactly the bug I shipped in v1.
