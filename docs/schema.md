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
  degradations  — named worse-but-still-playable states, fallen into instead of blocking or dead-ending
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

## world

*(v3 addition — optional; a quest without one just skips this guidance.)* Quest-wide and unchanging, injected into every prompt identically.

```json
{
  "setting": "London, 1883. Late Victorian, gaslit, pre-telephone.",
  "register": "Formal, restrained. People do not say what they feel directly.",
  "physics": "realistic",
  "supernatural": "none",
  "absent": [
    "Electric light, telephones, motor vehicles, photography as casual record",
    "Modern medicine, antibiotics, forensics beyond the crude",
    "Modern food, modern slang, modern social attitudes"
  ],
  "present": [
    "Hansom cabs, telegrams, gas lamps, coal fires, servants",
    "Revolvers, railways, the Underground, calling cards"
  ],
  "anachronism_response": "Do not refuse out of character. The thing simply does not exist and the world does not acknowledge the concept.",
  "weirdness": 0
}
```

**`absent` is illustrative, never exhaustive.** It cannot enumerate every anachronism a player might reach for. It exists to give the model a *pattern* to generalize from — a handful of representative examples of the kind of thing that doesn't belong, so a request for something not literally on the list (an X-ray, a therapist, an instant photograph) still gets recognized as the same category. The validator warns below 3 entries, on the theory that a pattern needs more than one or two points to actually be a pattern.

**`weirdness`**, 0-10, is the deliberate-fuzziness dial. At 0 the model stays strictly inside the frame; higher values are an authorial choice (dream sequence, comedy, surreal quest) that deliberately loosens how far it may invent beyond what's declared. Default 2 if unset.

**`register` is distinct from `narrator.voice`.** Voice is how the narrator writes; register is how the people inside the world actually speak and carry themselves. They can differ — a plain, unornamented narrating voice can still describe a formally repressed cast.

---

## clock

*(Rewritten twice. First to a minutes-based story-time clock, then rolled back.)* The minutes-based version tracked real elapsed story-time — an exit could cost 180 minutes, a turn cost 5 by default — and phases and the deadline were both derived from it. Live testing found the failure mode that predicts: a 30-turn interrogation transcript, entirely genuine questions with real discoverables firing, pushed the clock forward exactly as far as 30 turns of silence would have, because *every* turn cost minutes by default, whether or not anything actually happened. Thoroughness was taxed at the same rate as stalling. That's backwards — a player asking twenty careful questions is doing exactly what the quest wants, and the clock should not know or care.

The fix: the clock now advances only on declared events, never on elapsed turns or idle conversation. `advances_on` names the specific things that count — exits, discoverables, beats — and each one moves a single quest-wide **progress counter** by exactly one, the first time it happens. Phases and any `deadline` are expressed entirely in terms of that counter.

```json
{
  "advances_on": ["the_death", "to_surrey", "the_wall", "bellpull", "the_bed", "ventilator", "safe", "to_watch"],
  "phases": [
    { "name": "morning", "until": 1 },
    { "name": "afternoon", "until": 4 },
    { "name": "dusk", "until": 10 },
    { "name": "night", "until": 999 }
  ],
  "deadline": {
    "at": 11,
    "meaning": "Whatever killed Julia comes for Helen. Thorough investigation of what the case actually needs never costs you this — only piling on optional detours past what the case requires does.",
    "on_reached": { "mode": "ending", "ending": "e_too_late" }
  }
}
```

**`advances_on` is a flat list of ids — exit ids, discoverable ids, or a beat's own (optional) `id` field.** The same id can belong to more than one scene (`to_surrey` appears in both `s1_baker_street` and `s3_commons`) and still counts as one event, since it's the same narrative action regardless of which room it was taken from. Each id in the list counts **once per session, ever** — asking the same question five different ways, or a model re-reporting an already-fired discoverable, never advances the counter twice. This is what makes the fix actually hold: an interrogation that repeats itself, or explores real but non-critical detail, simply never touches `advances_on` a second time for anything it's already covered.

**`phases` are progress-counter thresholds, not time-of-day ranges — and they don't wrap.** Phase *i* covers progress in `[phases[i-1].until, phases[i].until)`; the first phase implicitly starts at 0, and progress at or beyond every threshold falls into the last-declared phase. Unlike the old time-based version, there's no circular case to special-case, because a counter that only ever goes up has no "midnight." `phase` is always *derived* — nothing stores it as an independently-authored value.

**Exits and beats may still declare `costs_minutes`, but it's inert by default.** It only does anything if the quest also configures the fully optional `story_time` block below — otherwise it's a no-op field with no effect on phase, `deadline`, or anything else. **General principle, unchanged since v3's turn contract: never gate on something the engine can't verify, and don't let a per-turn cost apply to turns that didn't earn it.**

**`deadline` is the whole-quest backstop, now expressed in plot-relevant events.** Once the progress counter reaches `at`, the engine forces `on_reached` — `on_reached.mode` is unchanged from before (`"ending"` forces a named ending outright and wins over `max_turns` on a shared turn; `"degrade"`, the default, applies a named `degradations` entry and lets the story continue, so `max_turns` keeps applying normally afterward). What changed is only what `at` counts against: not minutes elapsed, but distinct events resolved. Speckled Band's `deadline.at` is set above what winning strictly requires (7 events: hearing the account, travelling, the three room secrets, one clue from Roylott's room, and committing to the watch) but within what full optional exploration would reach (13, if every side detail is checked) — so investigating everything the case actually needs never risks it, and only chasing every optional avenue as well does.

**Tune `advances_on` and the phase thresholds together, checking against every `beat.at_turn` and `max_turns` in scenes that share them.** A beat still fires on elapsed scene-turns, same as always — that part of the engine didn't change — so a beat whose `at_turn` lands at or before a scene's `pressure` exhaustion turn can still preempt it (see `pressure`'s own note on this), and by the same logic, nothing stops an author from picking `advances_on` events so sparse that a scene's real, honest progress rarely fires at all. There's no validator check for that particular shape yet — it's a live tuning concern, not a schema violation.

**`story_time` is fully optional, and most quests should skip it.** It exists only for a quest that wants a literal elapsed-time line in narration — "the fire has burned down," "the light is going" — with no mechanical weight behind it:

```json
"story_time": {
  "starts_at": "1883-04-06T07:15:00",
  "default_turn_cost_minutes": 5
}
```

If declared, the engine advances `story_time` using the same `costs_minutes`-then-`minutes_elapsed`-then-default resolution the old mechanism used, and shows it to the model as a plain `HH:MM` (never the raw machine datetime). It is never read back for anything — not `phase`, not `deadline`, not any `requires`. Speckled Band doesn't declare it: "the hour" is narrated loosely from `phase` alone (morning/afternoon/dusk/night are plenty for a narrator's voice), and a literal clock reading would only invite the exact minutes-based reasoning this rewrite removed.

Scenes and exits may still require a phase via `requires_phase`, checked against the *derived* phase exactly as before — the only thing that changed is what derives it.

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
      "sets": [],
      "costs_minutes": 180
    }
  ],

  "guarded_events": [
    {
      "id": "helen_departs",
      "trigger": "player dismisses Helen, says goodbye, or otherwise signals the interview is over",
      "requires": "heard_the_account",
      "on_blocked": "Something keeps her a moment longer — she hesitates at the door, or Watson asks one more question, or she simply isn't ready to leave yet. She does not actually go.",
      "on_allowed": { "degrade": "no_account", "goto": null }
    }
  ],

  "pressure": {
    "idle_after_turns": 3,
    "escalation": [
      "Watson glances at the clock on the mantelpiece.",
      "Helen says quietly that she must be home before her stepfather notices she has gone.",
      "Helen stands and reaches for her gloves. She is running out of time."
    ],
    "on_exhausted": "helen_departs"
  },

  "beats": [
    { "at_turn": 10, "event": "Roylott arrives.", "goto": "s3_intrusion", "once": true },
    { "at_turn": 12, "event": "A step creaks on the stair below.", "sets": ["overstayed"], "once": true }
  ],

  "on_fail": { "when": "condition", "to": "ending id" },

  "max_turns": 25,
  "on_exhausted": "scene id or ending id",

  "act": "act1"
}
```

**`requires` on both scenes and exits is enforced by the engine**, not requested of the model. If the condition is unmet, the exit does not exist that turn. The model is not told why — it narrates the attempt failing in-world.

**`requires` on a discoverable is the character gate.** This is where the interior mechanic pays off: the locked door is not available at `guarded`, no matter how the player phrases the question. Helen is not withholding strategically — she is frightened, and frightened people do not lead with the worst part.

**`impossible` is separate from `truths`** because it is the list the model most needs in front of it. The bed does not move. The window does not open.

**`guarded_events` is the same mechanism as `exits`, extended to narrated consequences that aren't a scene transition.** v1's `to_surrey` bug was fixed by putting real gates on literal exits — but a player can also narrate a character *out* of the story without ever taking an exit ("goodbye", "I dismiss her"), and nothing about that requires the engine's permission unless something explicitly gates it. If Helen leaves before `heard_the_account` is set, `ready_to_travel` can never become true and the quest soft-locks with no path to any ending, even though every exit and discoverable individually still validates fine — the failure is a narrated event nobody enforced, not a broken gate. `guarded_events` closes that: each entry names a `trigger` an author anticipates (a dismissal, a threat, an ending-adjacent line), a `requires` condition, and an `on_blocked` line telling the narrator how to hold the line gracefully when it fires too early. Same enforcement posture as everything else in this file — the engine decides, the model narrates within the decision.

**`on_allowed` is optional, and only matters once `requires` fails twice in the same turn.** The retry flow is unchanged: first failure gets `on_blocked` fed back, hoping for a graceful self-correction. If the model insists a second time, a guarded event with no `on_allowed` still dead-ends exactly as before — commit nothing, fall back to a null-exit narration. A guarded event that declares `on_allowed.degrade`, though, is *let through* instead: the model's own narration commits, the named `degradations` entry (below) is applied, and — since the event still isn't a scene transition on its own — `on_allowed.goto` optionally forces one (`null`, as above, means the story stays in the current scene). This is the mechanism that turns "the model won't stop insisting on something the quest can't allow" from a dead end into a worse-but-still-playable branch.

**`pressure` is what old text adventures never had: a third response to a drifting player, besides allow-it or refuse-it.** A turn counts as *idle* when it sets no flag, triggers no discoverable, takes no exit, and fires no guarded event — the player is present but not moving anything forward. `idle_after_turns` is both the threshold for the first escalation line and the spacing between every later one: tier *k* (1-indexed) shows `escalation[k-1]` once idle turns reach `idle_after_turns * k`. Three idle turns and the world nudges (Watson checks the time). Six and it nudges harder (Helen names the reason she has to go). Once idle turns reach `idle_after_turns * escalation.length` — the last tier, which the last line is written for — escalation is exhausted and the engine forces `on_exhausted` (a `guarded_events` id declared on this same scene) through, with no further chance for the model to head it off. It's resolved exactly like a model-insisted `on_allowed.degrade`, except the check that decides whether to actually apply the degrade — is the event's `requires` still unmet? — happens fresh at the moment of forcing: a player who satisfied it and simply lingered afterward gets waved on cleanly, not punished for something they already did. Nobody is ever told they can't do something; the story just keeps applying gravity, and this is also what stops the old "Watson is two minutes gone" loop — idle turns cannot accumulate forever, because eventually the opportunity genuinely closes.

**Check `idle_after_turns * escalation.length` against every `beat.at_turn` (and `max_turns`) in the same scene.** Idle turns can never outrun the scene's own turn count — every idle turn is also a scene turn — so if a beat's threshold falls at or before pressure's exhaustion point, the beat always fires first and pressure's hard exhaustion never gets reached at all, no matter how the player plays. The nudges still show (they're keyed to the same, always-reachable count), but the actual `on_exhausted` force becomes dead code. Above, exhaustion lands at turn 9 (`idle_after_turns` 3 × 3 lines) and the first beat is pushed to 10 specifically so it doesn't preempt it.

**A beat may `sets` flags in addition to (or instead of) `goto`.** A time-based consequence — being caught searching, missing a window — is a deterministic threshold on `scene_turn_count`, not something the model is trusted to notice on its own. `on_fail` is evaluated immediately after beats fire each turn, so a beat that sets the flag named in `on_fail.when` ends the scene that same turn, without needing its own `goto`.

**`max_turns` is a v3 addition — a termination backstop every scene has, default 25, whether declared or not.** `on_fail` and `beats` cover the endings an author thought to write; `max_turns` covers the ones nobody anticipated — a player who circles a scene indefinitely without triggering anything else. On exceeding it, the engine forces `on_exhausted` (a scene or ending id, same target rules as `beat.goto`); if the scene declares none, it falls back to the quest's first `universal_ending`. This is invisible to the model — like `beats` and `on_fail`, it is never shown in `{{SCENE}}` and the model never reasons about it; it just keeps narrating, and the engine cuts in if the scene has genuinely run too long. The validator requires every scene to have *somewhere* to go when this fires: either its own `on_exhausted`, or at least one `universal_ending` declared at the quest level.

**`act` is a free-form grouping label, and purely additive.** A scene with no `act` behaves exactly as it always has — nothing about acts is required, and a quest that never sets it never touches any of the machinery below. Its only effect: crossing from a scene in one act into a scene in a different act (an undeclared act counts as its own bucket, distinct from any named one) writes a checkpoint. See the next section.

---

## Acts and rewind

A `checkpoint` is a full snapshot of session state — everything a later turn or the model's next prompt could read: `flags`, `characters`, `active_degradations`, `invented`, `transcript`, `progress_events`, `fired_beats`, `scene_turn_count`, `idle_turns`, and the scene itself. The engine writes one automatically, overwriting whatever was there before, the moment play enters a scene whose `act` differs from the one just left. Nothing else about ordinary play changes — `checkpoint` just accumulates in the background, always holding the most recent act-entry snapshot, or `null` if the quest declares no acts (or hasn't entered one with a checkpoint yet).

**Rewind restores it.** Given a session with a checkpoint, `rewindToCheckpoint` overwrites `flags`/`characters`/`active_degradations`/`invented`/`transcript`/`progress_events`/`fired_beats`/`scene_turn_count`/`idle_turns` with the checkpoint's stored values, resets `current_scene` to the scene the checkpoint was written at, and sets `status: "active"` / `ending_id: null` / `ending_trigger: null` — un-ending the session if it had lost or won. The checkpoint itself is left in place afterward, so a second failed attempt at the same act can rewind again.

**Why the full snapshot, not just the obviously narrative fields.** The model has no memory beyond what's re-fed into its prompt each turn — `{{HISTORY}}` from `transcript`, `{{INVENTED}}` from `invented`, scene state from `flags`/`characters`. Restoring the DB row *is* restoring the model's effective memory, but only if every field the prompt reads is actually restored. A rewind that reset flags and characters but left `transcript` pointing at the failed attempt would still show the model those turns in `{{HISTORY}}` on the very next call — the story would "forget" mechanically while still talking about what it forgot.

**Manual and explicit, for now.** Nothing in the engine auto-triggers a rewind on any particular loss — a `POST /session/:id/rewind` endpoint exposes it, and a caller (a human, or a future rule) decides when reaching for it makes sense. Not every loss should necessarily offer one — an ending an author deliberately wrote as final is a different thing from a player who wandered into a fight they couldn't have known to avoid — and that distinction isn't made yet. This stage only builds the mechanism.

---

## degradations

Quest-level, named by id, referenced from a `guarded_event.on_allowed.degrade` or a `clock.deadline.on_reached` in `"degrade"` mode. The lesson behind this mechanism: a player who insisted on something the quest couldn't allow, and got a dead end for it, is a player who stopped playing. Failure should cost something other than a restart.

```json
"degradations": {
  "no_account": {
    "description": "Helen left before telling you about the whistle or the locked door.",
    "sets": ["missed_account"],
    "unlocks": ["to_surrey"],
    "consequences": [
      "The night watch is far harder — you do not know to expect a sound.",
      "You will not recognise the significance of the ventilator without prompting."
    ],
    "still_winnable": true
  }
}
```

**`sets`** applies flags exactly like a discoverable or exit — the same `sets`-is-the-only-channel rule from the turn contract applies here too.

**`unlocks` names exits (anywhere in the quest, by id) whose `requires` gate is bypassed for the rest of the session once this degradation is active.** `to_surrey` normally requires `ready_to_travel` (= `heard_the_account`); if Helen left before that was ever set, the clean path to Stoke Moran is gone for good unless something else opens it. `no_account` is that something else — the player can still go, just without knowing what to look for.

**`consequences` is flavor text, read by nobody but the author.** The engine doesn't act on it; it exists to document, at the point of authorship, what the degradation is supposed to cost, so the tradeoff is legible without having to trace it through play.

**`still_winnable` is the honesty check.** `true` means the degraded path can still reach a win ending, just harder (as `no_account` does — the player travels blind, but the room still tells its story to someone paying attention). `still_winnable: false` is permitted for a degradation that closes off winning entirely, but it **must** then name the `ending` it eventually routes to — a degraded path that can neither win nor end is exactly the bug `guarded_events` exists to prevent, just reached through a different door, and the validator rejects it.

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

**`universal_endings` — v3 addition, same shape, quest-level, not per-scene.** A small set of generic endings every quest inherits, so a termination backstop (`max_turns`, and later `pressure`) always has somewhere to land without every scene needing a bespoke `on_exhausted` written for it:

```json
"universal_endings": [
  { "id": "u_too_slow", "result": "loss", "direction": "The moment passed while you were elsewhere. Do not explain what was missed." },
  { "id": "u_turned_away", "result": "loss", "direction": "You were asked for help and did not give it. The story went on without you." },
  { "id": "u_lost_thread", "result": "loss", "direction": "Whatever you were following is gone. Do not explain what it was." }
]
```

Implicitly reachable from every scene that doesn't declare its own `on_exhausted` — the validator never requires a bespoke path to one, and "ending unreachable" is never raised against them. When a scene falls back to one, the engine uses the **first** entry in the array; order it deliberately if you declare more than one. Every session that resolves via an engine backstop — not just a universal ending; a scene's own `on_exhausted`, or an ending forced by `clock.deadline` in `"ending"` mode, count too — gets an `ending_trigger` recorded alongside `ending_id`, currently one of `"max_turns_exceeded"` or `"deadline_reached"`, with more to follow as other termination backstops (`pressure`) land. A deadline in `"degrade"` mode never sets `ending_trigger`, because it doesn't reach an ending at all — it applies a degradation and the session stays active. `ending_trigger` stays `null` for an ending reached through ordinary play (an exit, an authored `on_fail`) — specifically so a bare "the story ended generically" can be told apart from "the story reached the ending the author actually wrote for this," which is not otherwise visible from `ending_id` alone.

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
  "disposition_changes": [
    { "character": "helen", "direction": "up", "reason": "gave her time, did not press" }
  ],
  "invented": ["details invented this turn that must stay true"],
  "minutes_elapsed": 5,
  "refused": false
}
```

`minutes_elapsed` is a suggestion, not a contract field, and inert for almost every quest — see `clock` above. It's used at all only when the quest configures optional `clock.story_time`, and even then purely as flavor: it never derives `phase`, never feeds a `deadline`, never gates anything. The engine prefers an exit's authored `costs_minutes` when one applies, and only falls back to this for free-form turns; a missing or nonsensical value just falls back further, to `story_time.default_turn_cost_minutes`.

There is no `flags_set` field. `discoverable.sets` and `exit.sets` already declare which flags a given discoverable or exit raises — the engine applies them the moment it validates `discovered`/`exit_id`, so asking the model to separately name the same flags is redundant bookkeeping with no independent check behind it. Live testing found exactly the failure that predicts: a model reporting a flag directly, with no discoverable or exit behind it at all. General rule going forward: never ask the model to report anything the engine can derive.

**Engine validation before committing anything:**

1. `exit_id` is null or is a legal exit of the current scene
2. That exit's `requires` and `requires_phase` are satisfied
3. `guarded_event_id` is null or is a legal `guarded_events` id of the current scene, and its `requires` is satisfied — checked exactly like `exit_id`, but it names a narrated consequence rather than a scene transition, so satisfying it doesn't change `current_scene` on its own
4. Each `discovered` id belongs to the current scene and its `requires` is met; the flags it declares in `sets` are applied
5. If `exit_id` is non-null, the flags it declares in `sets` are applied
6. `disposition_changes` are clamped to one step, within floor and ceiling
7. `invented` is appended to session state and fed back in every subsequent turn

Any failure: retry once with the error appended. On second failure, commit nothing, return a null-exit fallback narration, and log it — unless the failure is specifically an unmet `guarded_event.requires` and that event declares `on_allowed.degrade`, in which case the event is let through in degraded form instead (see `degradations` above) rather than falling back. The log is how you tell a bad model from a bad file.

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
- `requires_phase` naming a phase not in the clock
- Character referenced in `present` or a `requires` but not declared
- Disposition level referenced in a requirement but not in that character's `levels`
- Empty `secrets` on a quest with a win condition
- A scene with no `on_exhausted` and the quest with no `universal_endings` declared — nothing catches that scene if `max_turns` is ever exceeded
- A `clock.phases` entry's `until` that isn't a non-negative integer, or isn't strictly greater than the previous phase's `until` — progress is a monotonic counter, so thresholds must be ascending, with no circular case the way time-of-day once needed
- `clock.deadline.at` that isn't a positive integer
- `clock.deadline.on_reached` with an invalid `mode`, an `"ending"` mode with no `ending` field or one naming an undeclared ending, or a `"degrade"` mode (default) with no `degrade` field or one naming an undeclared degradation
- A `clock.advances_on` entry that doesn't match any exit, discoverable, or beat id anywhere in the quest
- `clock.story_time.starts_at`, if declared, that isn't a valid naive ISO datetime
- A `guarded_event.on_allowed.degrade` naming an undeclared degradation
- A `degradation.unlocks` entry naming an exit id that doesn't exist in any scene
- A degradation with `still_winnable: false` that names no ending, or names one that doesn't exist
- `pressure.on_exhausted` naming a guarded_events id not declared on that same scene

**Warnings — playable but suspect:**
- Flag declared and never set, or set and never read
- Discoverable no path can reach
- Character with `ceiling` above `starts_at` but no `moves_toward` entries
- Scene with no exits and no `on_fail`
- Ending unreachable
- A scene has a character present whose discoverables set a flag required elsewhere (by a `requires` or `derived` expression anywhere in the quest), but the scene has no `guarded_events` at all *(this is the s1 Helen-departure bug — a character can be narrated out of the story with nothing gating it, silently soft-locking the quest)*
- `world.absent` with fewer than 3 entries — not enough for the model to generalize a pattern from
- A `degradations` entry declared but never referenced by any `guarded_event.on_allowed.degrade` or `clock.deadline.on_reached.degrade`
- A scene with more than four `exits` or `discoverable` entries but no `pressure` declared — busy enough for a player to drift in, with nothing pulling them back
- A scene's `pressure` exhaustion turn (`idle_after_turns * escalation.length`) landing at or after a `beat.at_turn` in the same scene, or after `max_turns` — the beat or the scene budget always fires first, so `on_exhausted` can never actually be reached
- A scene with no `act` declared when at least one other scene in the quest declares one — partial adoption is the likely mistake, since acts are all-or-nothing in practice even though nothing in the schema requires it

The win-path check is the one that matters most. It is what a human author cannot reliably do by eye, and it is exactly the bug I shipped in v1.
