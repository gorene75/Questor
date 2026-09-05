// Deterministic proof of the three-bucket rebuild's structural fix: presence
// is computed from object_placement (never a static scene.present array),
// and "known but not present" is sourced entirely from player_knowledge
// (never the old known_when-defaults-to-known-from-the-start mechanism,
// which is gone). Pure function test, no DB: buildPrompt is a pure function
// of quest + session state.

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
    known_objects: {},
    object_placement: {},
    ...overrides,
  };
}

// ---- A genuinely never-referenced character has NO mention at all — not "known, not present", not a name line, nothing ----
{
  const prompt = buildPrompt(
    quest,
    baseSession({ current_scene: "s1_baker_street", object_placement: { helen: "s1_baker_street", watson: "s1_baker_street" } }),
    noHistory,
    "test"
  );
  // Checked narrowly against the CHARACTERS block's own patterns, not the
  // whole prompt — "Roylott" legitimately appears in about_stepfather's own
  // reveal text (a discoverable not yet fired), which is a different,
  // correct mechanism, not a CHARACTERS-block leak.
  const hasSparseLine = prompt.includes("- roylott (known:");
  const hasFullBlock = prompt.includes("### Dr Grimesby Roylott (roylott)");
  const hasNameOnlyLine = prompt.includes("Dr Grimesby Roylott (roylott) — known, not present");
  report(
    "Roylott: with no player_knowledge row and not present, he gets no CHARACTERS-block mention at all — 'unknown until disclosed' is the default, not 'known, not present'",
    !hasSparseLine && !hasFullBlock && !hasNameOnlyLine,
    `sparse line: ${hasSparseLine}, full block: ${hasFullBlock}, old-style name-only line: ${hasNameOnlyLine}`
  );
}

// ---- Once known (a player_knowledge row exists) but not present in THIS scene, a sparse name/status line — never the full behaviour block ----
{
  const prompt = buildPrompt(
    quest,
    baseSession({
      current_scene: "s2_intrusion", // roylott present here per scene.present, but object_placement below doesn't place him here
      object_placement: { watson: "s2_intrusion" },
      known_objects: { roylott: { known: { name: "Dr Grimesby Roylott", role: "Helen's stepfather" }, merged_into: "roylott" } },
    }),
    noHistory,
    "test"
  );
  const hasSparseLine = prompt.includes("- roylott (known:") && prompt.includes("not present");
  const hasBehaviourData = prompt.includes("Demands to know what has been said");
  report(
    "Roylott: known (player_knowledge row exists) but object_placement doesn't put him in this scene — sparse line shown, full behaviour block withheld",
    hasSparseLine && !hasBehaviourData,
    `sparse line present: ${hasSparseLine}, behaviour data leaked: ${hasBehaviourData}`
  );
}

// ---- Roylott present (object_placement puts him in s2_intrusion): full behaviour block, not demoted to a name-only line ----
{
  const prompt = buildPrompt(
    quest,
    baseSession({
      current_scene: "s2_intrusion",
      object_placement: { roylott: "s2_intrusion", watson: "s2_intrusion" },
      known_objects: { roylott: { known: { name: "Dr Grimesby Roylott", role: "Helen's stepfather" }, merged_into: "roylott" } },
    }),
    noHistory,
    "test"
  );
  const hasFullBlock = prompt.includes("### Dr Grimesby Roylott (roylott)") && prompt.includes("Demands to know what has been said");
  const demotedToSparse = prompt.includes("- roylott (known:") && prompt.includes("not present");
  report(
    "Roylott, present per object_placement in s2_intrusion: full behaviour block shown, not demoted to a sparse line",
    hasFullBlock && !demotedToSparse,
    `full block present: ${hasFullBlock}, incorrectly demoted: ${demotedToSparse}`
  );
}

// ---- Helen and Watson, placed via object_placement in s1_baker_street, are unaffected by the new mechanism ----
{
  const prompt = buildPrompt(
    quest,
    baseSession({ current_scene: "s1_baker_street", object_placement: { helen: "s1_baker_street", watson: "s1_baker_street" } }),
    noHistory,
    "test"
  );
  const ok = prompt.includes("### Helen Stoner (helen)") && prompt.includes("### Dr Watson (watson)");
  report("Helen and Watson, placed via object_placement in s1_baker_street, still get full behaviour blocks", ok, `both present: ${ok}`);
}

// ---- Structural check for a scene other than s1_baker_street: presence is computed from object_placement, not a static array, even with no real content conversion done for that scene ----
{
  // s4_exterior's own scene.present is ["helen", "watson"] — but nothing here
  // seeds object_placement for it (no processTurn ran), so with an EMPTY
  // object_placement, nobody should be present, proving the static array is
  // no longer read directly.
  const prompt = buildPrompt(quest, baseSession({ current_scene: "s4_exterior", object_placement: {} }), noHistory, "test");
  const nobodyPresent = prompt.includes("(no one present)");
  const noHelenBlock = !prompt.includes("### Helen Stoner (helen)");
  report(
    "s4_exterior (unconverted scene): with object_placement empty, nobody is present — scene.present's own array is not read as a live gate here either",
    nobodyPresent && noHelenBlock,
    `shows '(no one present)': ${nobodyPresent}, Helen block absent: ${noHelenBlock}`
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
