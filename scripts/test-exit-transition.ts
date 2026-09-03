// Deterministic proof of Fix 2: exit.transition text reaches the prompt
// when (and only when) the exit is actually available this turn — an
// unavailable exit's transition would be noise at best, a spoiler of the
// destination at worst, attached to a line the model is told not to take.
// Pure function test, no DB: buildPrompt is a pure function of quest +
// session state.

import { readFileSync } from "node:fs";
import { buildPrompt, type SessionState, type TurnRecord } from "../src/prompt.ts";
import { validateQuest, type Quest } from "../src/validator.ts";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, evidence: string) {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  console.log(`  ${evidence}`);
  if (ok) pass++;
  else fail++;
}

const quest = JSON.parse(readFileSync("quests/speckled-band.json", "utf-8")) as Quest;
const { errors } = validateQuest(quest);
if (errors.length > 0) {
  console.error("Quest has validation errors, aborting:", errors);
  process.exit(1);
}

const toSurreyTransition = "The carriage ride passes mostly in silence. Helen watches the countryside change. You arrive as the light is going.";
const toCommonsTransition = "A cab into the city, the usual traffic. The clerk's office smells of dust and old paper before you've even sat down.";

const noHistory: TurnRecord[] = [];

function baseSession(overrides: Partial<SessionState>): SessionState {
  return {
    current_scene: "s1_baker_street",
    phase: "morning",
    story_time: null,
    flags: { ...quest.flags },
    characters: {},
    invented: [],
    idle_turns: 0,
    pressure_fired: false,
    ...overrides,
  };
}

// ---- to_commons has no gate — its transition is always shown ----
{
  const prompt = buildPrompt(quest, baseSession({}), noHistory, "test");
  const ok = prompt.includes(toCommonsTransition);
  report("to_commons (ungated): its transition text is shown from the very first turn", ok, `prompt contains transition: ${ok}`);
}

// ---- to_surrey is gated on heard_the_account — its transition is absent while unavailable ----
{
  const prompt = buildPrompt(quest, baseSession({ flags: { ...quest.flags, heard_the_account: false } }), noHistory, "test");
  const ok = !prompt.includes(toSurreyTransition) && prompt.includes("to_surrey (unavailable)");
  report(
    "to_surrey (gated, heard_the_account false): marked unavailable and its transition text is withheld",
    ok,
    `prompt contains transition: ${prompt.includes(toSurreyTransition)}, marked unavailable: ${prompt.includes("to_surrey (unavailable)")}`
  );
}

// ---- once heard_the_account is true, to_surrey becomes available and its transition appears ----
{
  const prompt = buildPrompt(quest, baseSession({ flags: { ...quest.flags, heard_the_account: true } }), noHistory, "test");
  const ok = prompt.includes(toSurreyTransition) && prompt.includes("to_surrey (available)");
  report(
    "to_surrey (heard_the_account true): marked available and its transition text is shown",
    ok,
    `prompt contains transition: ${prompt.includes(toSurreyTransition)}, marked available: ${prompt.includes("to_surrey (available)")}`
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
