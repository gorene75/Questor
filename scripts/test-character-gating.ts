// Deterministic proof of Task 3: character existence gating. A character
// not in scene.present but known (canon-named, or known_when satisfied)
// appears only as a name/status line, never a full behaviour block; a
// character in scene.present gets the full block as before. Pure function
// test, no DB: buildPrompt is a pure function of quest + session state.

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

// ---- Roylott is known (canon-named case background) but not present in s1_baker_street: name/status only, no behaviour data ----
{
  const prompt = buildPrompt(quest, baseSession({ current_scene: "s1_baker_street" }), noHistory, "test");
  const hasNameLine = prompt.includes("Dr Grimesby Roylott (roylott) — known, not present");
  const hasBehaviourData = prompt.includes("Demands to know what has been said");
  const ok = hasNameLine && !hasBehaviourData;
  report(
    "Roylott, known but not present in s1_baker_street: name/status line shown, full behaviour block withheld",
    ok,
    `name line present: ${hasNameLine}, behaviour data leaked: ${hasBehaviourData}`
  );
}

// ---- Roylott IS present in s2_intrusion: full behaviour block, not just a name line
// (Helen is NOT present in this scene, so she legitimately gets a name-only line here —
// the check below is specifically about Roylott, not "no one has a name-only line") ----
{
  const prompt = buildPrompt(quest, baseSession({ current_scene: "s2_intrusion" }), noHistory, "test");
  const hasFullBlock = prompt.includes("### Dr Grimesby Roylott (roylott)") && prompt.includes("Demands to know what has been said");
  const roylottDemotedToNameOnly = prompt.includes("Dr Grimesby Roylott (roylott) — known, not present");
  const ok = hasFullBlock && !roylottDemotedToNameOnly;
  report(
    "Roylott, present in s2_intrusion: full behaviour block shown, not demoted to a name-only line",
    ok,
    `full block present: ${hasFullBlock}, incorrectly demoted: ${roylottDemotedToNameOnly}`
  );
}

// ---- Helen and Watson, present in s1_baker_street, are unaffected by the new mechanism ----
{
  const prompt = buildPrompt(quest, baseSession({ current_scene: "s1_baker_street" }), noHistory, "test");
  const ok = prompt.includes("### Helen Stoner (helen)") && prompt.includes("### Dr Watson (watson)");
  report("Helen and Watson (present in s1_baker_street) still get full behaviour blocks as before", ok, `both present: ${ok}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
