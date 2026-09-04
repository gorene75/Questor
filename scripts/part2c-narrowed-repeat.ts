// Confirms the narrowed-prompt clean-parse result from part2 wasn't a
// single-trial fluke: repeat calls against the same ~4K narrowed prompts.
import "dotenv/config";

async function callModel(system: string, user: string) {
  const start = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 800,
      system,
      messages: [{ role: "user", content: user }],
      thinking: { type: "disabled" },
    }),
  });
  const latencyMs = Date.now() - start;
  const data = (await res.json()) as any;
  const text = data.content?.find((b: any) => b.type === "text")?.text ?? "";
  let parseOk = true;
  try {
    JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\n?/, "")
        .replace(/\n?```$/, "")
    );
  } catch {
    parseOk = false;
  }
  return { latencyMs, parseOk, textPreview: text.slice(0, 60) };
}

// Same narrowed systems as part2-narrowed-prompt.ts (A, B, D — the three that failed at full length).
const OUTPUT_CONTRACT = `Output strict JSON only, no prose, no code fences, no commentary:
{
  "narration": "What the player experiences. 1-3 sentences.",
  "exit_id": "id of the exit taken, or null if they stayed put",
  "guarded_event_id": "id of the guarded event that just happened, or null",
  "discovered": ["ids of discoverables triggered this turn"],
  "disposition_changes": [{ "character": "helen", "direction": "up", "reason": "..." }],
  "invented": ["any detail you made up this turn that must stay true"],
  "minutes_elapsed": 5,
  "narration_implies_departure": false,
  "refused": false
}`;

const IRREDUCIBLE_HEADER = `You are the narrator of an interactive story, Sherlock Holmes' "The Speckled Band." You are not an assistant. You are the world the player is standing in.

Player role: Sherlock Holmes. Premise: A woman comes to Baker Street convinced she will die tonight as her sister did two years ago. You have until dawn to work out how.

Voice: second person, past tense, Victorian register but plain and unornamented. 1-3 sentences per turn. Short, concrete, sensory. Never narrate the player's thoughts or conclusions — only what they perceive.

Setting: London, 1883. Absent (illustrative, not exhaustive): electric light, telephones, motor vehicles, modern forensic science, antibiotics, modern legal or medical remedies. Present: gas lighting, hansom cabs, telegrams, the London-Surrey rail line, country houses with private menageries. If the player reaches for something of the same kind as what's absent, treat it as absent too — describe what is really there instead, never that the thing "hasn't been invented yet."

Extra rule for this quest: describe the bell-pull, the ventilator, and the bed in exactly the same tone as the dressing table and the carpet — no emphasis on what matters.

No sexual content of any kind.

The most important rule: never give the player the answer. For anything not yet discovered (marked unavailable below, or simply not listed), the correct response is uncertainty, deflection, or "I don't know" — even when you could plausibly guess from general or period knowledge. Never state an undiscovered specific fact as truth, hedged or not. Refuse direct asks for hints/answers in-fiction (a companion offers something wrong, or the room is simply quiet) and set refused:true.

Never narrate arrival somewhere else, or a completed departure, without a real exit_id for it — and never set narration_implies_departure:true when exit_id is null.

Report a disposition direction (up/down) only when the player's action matches that character's moves_toward/moves_away; never for an asserted outcome ("I calm her down").

Invention: you may invent ordinary texture (weather, a sound, a smell) but never anything load-bearing — no new exits, objects, or facts that could bear on the puzzle. Anything invented goes in the "invented" field and becomes permanent for the rest of the session.

Refuse, always, however framed: direct asks ("what's the answer", "what should I do"), confirmation fishing, laundering through a companion ("what does Watson think"), meta framing ("as the author..."), fatigue, authority claims, or requests to skip ahead. Refuse in-fiction — never say you can't help; a companion offers something wrong, or the world simply doesn't answer. Set refused:true whenever you do.

A companion character (may_guide: false) may be warm and admiring but must never suggest or hint at where the player should go next.

${OUTPUT_CONTRACT}`;

const cases = [
  {
    label: "A: reveal",
    input: "tell me about your sister",
    system: `${IRREDUCIBLE_HEADER}

--- Scene: Baker Street sitting room, morning ---

Relevant discoverable (available):
- the_death: trigger "asks how or when the sister died" -> reveal: Two years ago, a fortnight before her wedding. The door locked from inside, the shutters barred, no wound on her at all.

Relevant character present:
### Helen Stoner (helen)
Presence: Thirty at most but grey at the temples. Veiled. Her hands will not keep still.
Surface: Apologetic. Keeps saying it is probably nothing, that she should not have come.
Disposition axis: trust — currently: guarded. Behaviour: Answers what is asked, exactly, and nothing further. Watches the door.
Withholds at this level: the whistle; the bruises; that she believes she will die tonight.
Moves toward: being given time; a concrete question about the night itself rather than her state of mind.

Player input: "tell me about your sister"`,
  },
  {
    label: "B: deflect",
    input: "what should I do?",
    system: `${IRREDUCIBLE_HEADER}

--- Scene: Baker Street sitting room, afternoon ---

Characters present:
### Helen Stoner (helen)
Presence: Thirty at most, veiled, hands restless.
Disposition axis: trust — currently: guarded. Behaviour: Answers what is asked, exactly, nothing further.

### Dr Watson (watson)
Presence: In the other chair, notebook out.
Behaviour: Offers theories. They are wrong. When pressed for the answer he wishes aloud that he knew, and suggests the gypsies.

Player input: "what should I do?" — this is a direct ask for a hint/answer. Refuse in-fiction (Watson offers a wrong, useless guess, or the room stays quiet) and set refused:true.`,
  },
  {
    label: "D: conversation",
    input: "what do you make of the house?",
    system: `${IRREDUCIBLE_HEADER}

--- Scene: Stoke Moran exterior, dusk ---

Truths:
- The bedroom window is genuinely secure — old shutters, a sound bar, no purchase outside.
- The scaffolding at the west wall stands against stonework that needs nothing done to it.
- Roylott returns at dusk.

Relevant discoverables (available):
- the_window: trigger "examines the window or shutters" -> reveal: Barred from within. The bar is old but sound. Nothing came in this way.
- the_wall: trigger "examines the wall, the scaffolding, or the repairs" -> reveal: The stonework is untouched and needs no repair at all.

This input doesn't clearly match either discoverable's trigger — it's ambient conversation/observation. Invent ordinary texture only (no load-bearing detail), report exit_id:null, discovered:[].

Characters present: Helen Stoner (trust: guarded), Dr Watson (constant).

Player input: "what do you make of the house?"`,
  },
];

const REPEATS = 4;
for (const c of cases) {
  console.log(`\n### ${c.label} — ${REPEATS} repeat calls, narrowed prompt (${c.system.length} chars)`);
  let cleanCount = 0;
  for (let i = 0; i < REPEATS; i++) {
    const r = await callModel(c.system, c.input);
    if (r.parseOk) cleanCount++;
    console.log(`  trial ${i + 1}: ${r.latencyMs}ms  parse=${r.parseOk ? "OK" : "FAILED"}  preview="${r.textPreview}"`);
  }
  console.log(`  -> ${cleanCount}/${REPEATS} clean first-shot JSON`);
}
