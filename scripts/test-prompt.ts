import { readFileSync } from "node:fs";
import { buildPrompt, type SessionState, type TurnRecord } from "../src/prompt.ts";
import type { Quest } from "../src/validator.ts";

const path = process.argv[2] ?? "quests/speckled-band.json";
const quest = JSON.parse(readFileSync(path, "utf-8")) as Quest;

// Fake mid-quest state: player has heard Helen's account and is now pressing
// further while she's opened up a step from her starting 'guarded' level.
// A couple of earlier-scene invented details are carried along to prove
// INVENTED is session-wide, not scene-scoped.
const session: SessionState = {
  current_scene: "s1_baker_street",
  phase: "morning",
  story_time: "1883-04-06T09:40:00",
  // Spread the quest's own declared flags first (keeps this fixture in sync
  // as the quest gains new flags) and override only the ones this scenario
  // actually needs non-default.
  flags: {
    ...quest.flags,
    heard_the_account: true,
  },
  characters: {
    helen: "opening",
    watson: "constant",
  },
  invented: [
    "The fire in the grate has burned down to embers.",
    "A hansom cab clatters past in the street below and does not stop.",
  ],
  idle_turns: 0,
  pressure_fired: false,
  known_objects: {},
  object_placement: { helen: "s1_baker_street", watson: "s1_baker_street" },
};

// 8 fake turns, to prove HISTORY caps at the last 6 rather than the full transcript.
const recentHistory: TurnRecord[] = [
  { player_input: null, narration: "A veiled woman sits by your fire, grey with cold and something worse." },
  { player_input: "Who are you and what's wrong?", narration: "She gives her name as Helen Stoner and says she is afraid, though she can't say of what exactly." },
  { player_input: "Take your time.", narration: "She nods, gathering herself, grateful not to be rushed." },
  { player_input: "How did your sister die?", narration: "Two years ago, a fortnight before her wedding. The door was locked from inside, the shutters barred. No wound was ever found." },
  { player_input: "That must have been terrible for you.", narration: "She looks at you properly for the first time, as if deciding whether you mean it." },
  { player_input: "What made you come today, specifically?", narration: "She hesitates, then says only that things have started again." },
  { player_input: "What things?", narration: "She starts to answer, stops herself, and looks at the door instead." },
  { player_input: "You're safe here. Go on.", narration: "Something in her shoulders loosens, just slightly." },
];

const playerInput = "What have you been hearing at night?";

const prompt = buildPrompt(quest, session, recentHistory, playerInput);

console.log(prompt);
console.log("\n---");
console.log(`Prompt length: ${prompt.length} characters`);
console.log(`History turns included: ${Math.min(recentHistory.length, 6)} of ${recentHistory.length}`);
