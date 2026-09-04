// PART 1: prompt composition audit. Picks a real mid-session turn from
// turn_logs, breaks the assembled system prompt down by section (chars and
// % of total), and checks specific correctness questions: history cap,
// characters scoping, disposition-level scoping, invented growth.
import "dotenv/config";
import { createDbClientFromEnv, listTurnLogs, loadQuestByVersion, loadSession } from "../src/db.ts";
import { splitActualPrompt } from "./lib/prompt-sections.ts";

const sessionId = process.argv[2]!;
const client = createDbClientFromEnv();

const logs = await listTurnLogs(client, sessionId);
const validLogs = logs.filter((l) => l.validation.valid);
if (validLogs.length === 0) throw new Error("No valid turn_logs rows in this session");

// Pick a real mid-session turn: not the first, not the last, a clean single-shot one if possible.
const midIndex = Math.floor(validLogs.length / 2);
const chosen = validLogs[midIndex]!;
console.log(`Chosen turn: id=${chosen.id} turn_index=${chosen.turn_index} (${midIndex + 1} of ${validLogs.length} valid logs)`);

const match = chosen.prompt.match(/^\[SYSTEM\]\n([\s\S]*?)\n\n\[USER\]\n([\s\S]*)$/);
if (!match) throw new Error("Could not split system/user from stored prompt");
const system = match[1]!;
const user = match[2]!;

const split = splitActualPrompt(system);

console.log(`\nTotal system prompt length: ${split.fullLength} chars (user part: ${user.length} chars)\n`);

function pct(n: number): string {
  return ((n / split.fullLength) * 100).toFixed(1) + "%";
}

console.log("--- Section breakdown ---");
const rows: { name: string; chars: number }[] = [
  { name: "template/instructions (static prose around placeholders)", chars: split.totalStaticChars },
  { name: "FRAME (player role, premise, voice — quest-constant)", chars: split.sections.FRAME?.length ?? 0 },
  { name: "WORLD (setting/register/physics/absent/present — quest-constant)", chars: split.sections.WORLD?.length ?? 0 },
  { name: "CANON (facts + secrets + secret_handling — quest-constant)", chars: split.sections.CANON?.length ?? 0 },
  { name: "SCENE (truths/impossible/discoverables/exits/guarded_events/pressure)", chars: split.sections.SCENE?.length ?? 0 },
  { name: "CHARACTERS (present characters, current disposition level only)", chars: split.sections.CHARACTERS?.length ?? 0 },
  { name: "INVENTED (accumulated invented details)", chars: split.sections.INVENTED?.length ?? 0 },
  { name: "HISTORY (last N turns)", chars: split.sections.HISTORY?.length ?? 0 },
  { name: "INPUT placeholder (fixed text, real input sent separately)", chars: split.sections.INPUT?.length ?? 0 },
];
const sumParts = rows.reduce((s, r) => s + r.chars, 0);
for (const r of rows) {
  console.log(`  ${r.chars.toString().padStart(6)}  ${pct(r.chars).padStart(6)}  ${r.name}`);
}
console.log(`  ${sumParts.toString().padStart(6)}  ${pct(sumParts).padStart(6)}  SUM (should equal total)`);
console.log(`  ${split.fullLength.toString().padStart(6)}  100.0%  TOTAL`);

// --- Static vs dynamic ---
const staticChars =
  split.totalStaticChars + (split.sections.FRAME?.length ?? 0) + (split.sections.WORLD?.length ?? 0) + (split.sections.CANON?.length ?? 0) + (split.sections.INPUT?.length ?? 0);
const dynamicChars =
  (split.sections.SCENE?.length ?? 0) + (split.sections.CHARACTERS?.length ?? 0) + (split.sections.INVENTED?.length ?? 0) + (split.sections.HISTORY?.length ?? 0);
console.log(`\n--- Static vs dynamic ---`);
console.log(`  STATIC  (template + FRAME + WORLD + CANON + INPUT-placeholder): ${staticChars} chars, ${pct(staticChars)}`);
console.log(`  DYNAMIC (SCENE + CHARACTERS + INVENTED + HISTORY):              ${dynamicChars} chars, ${pct(dynamicChars)}`);

// --- Correctness checks ---
console.log(`\n--- Correctness checks ---`);

// 1. History cap: count "Narrator:" occurrences (one per turn shown) in HISTORY.
const historyText = split.sections.HISTORY ?? "";
const narratorTurnsShown = (historyText.match(/^Narrator: /gm) ?? []).length;
console.log(`  HISTORY: ${narratorTurnsShown} turns shown (cap should be 6). ${narratorTurnsShown <= 6 ? "OK" : "*** OVER CAP ***"}`);
console.log(`  HISTORY length: ${historyText.length} chars`);

// 2. Full transcript leak check: does HISTORY (or anything else) contain the session's very
// first turn's narration if this is well past turn 6? Load full session transcript from db.
const session = await loadSession(client, sessionId);
if (session) {
  const transcript = session.transcript as unknown as { narration: string; player_input: string | null }[];
  console.log(`  Session transcript has ${transcript.length} total turns recorded.`);
  if (transcript.length > 6) {
    const earlyTurn = transcript[0]!;
    const earlySnippet = earlyTurn.narration.slice(0, 40);
    const leaked = system.includes(earlySnippet);
    console.log(
      `  Earliest transcript turn snippet "${earlySnippet}..." found anywhere in prompt: ${leaked} ${
        leaked ? "*** POSSIBLE LEAK (or coincidental overlap with canon/scene text — inspect) ***" : "(not present — OK, transcript is not leaking beyond HISTORY's cap)"
      }`
    );
  } else {
    console.log(`  (Session has <=6 turns so far — full-transcript-leak check not meaningful yet.)`);
  }

  // 3. Characters scoping: compare CHARACTERS section against quest's full character roster.
  const questRow = await loadQuestByVersion(client, session.quest_id, session.quest_version);
  if (questRow) {
    const allCharIds = Object.keys(questRow.graph.characters);
    const scene = questRow.graph.scenes.find((s) => s.id === session.current_scene);
    const presentIds = scene?.present ?? [];
    console.log(`\n  Quest has ${allCharIds.length} total characters: [${allCharIds.join(", ")}]`);
    console.log(`  Scene '${session.current_scene}'.present: [${presentIds.join(", ")}]`);
    const charsText = split.sections.CHARACTERS ?? "";
    const headingsFound = [...charsText.matchAll(/^### .+? \(([a-z_]+)\)$/gm)].map((m) => m[1]);
    console.log(`  Character blocks actually in prompt: [${headingsFound.join(", ")}]`);
    const notPresentButShown = headingsFound.filter((id) => !presentIds.includes(id!));
    console.log(
      notPresentButShown.length === 0
        ? `  OK: only characters in scene.present are shown.`
        : `  *** LEAK: characters shown that are NOT in scene.present: ${notPresentButShown.join(", ")} ***`
    );

    // 4. Disposition level scoping: for each character shown, confirm only ONE
    // "Behaviour at this level" line appears (not all levels), and check none of
    // the OTHER levels' behaviour/withholds text leaked in.
    for (const charId of presentIds) {
      const charSpec = questRow.graph.characters[charId];
      if (!charSpec) continue;
      const behaviourCount = (charsText.match(new RegExp(`### ${charSpec.name}`, "g")) ?? []).length;
      const otherLevelTexts = Object.entries(charSpec.at_level)
        .filter(([lvl]) => lvl !== (session.characters[charId] ?? charSpec.disposition.starts_at))
        .map(([, v]) => v.behaviour);
      const leakedOtherLevel = otherLevelTexts.filter((t) => charsText.includes(t));
      console.log(
        `  ${charId}: shown ${behaviourCount}x, current level='${session.characters[charId] ?? charSpec.disposition.starts_at}', other-level text leaked: ${
          leakedOtherLevel.length > 0 ? "*** YES: " + JSON.stringify(leakedOtherLevel) + " ***" : "no (OK)"
        }`
      );
    }
  }
}

// 5. Invented growth across the session — walk every valid log's INVENTED section length.
console.log(`\n--- INVENTED growth across session ---`);
for (const log of validLogs) {
  const m = log.prompt.match(/^\[SYSTEM\]\n([\s\S]*?)\n\n\[USER\]/);
  if (!m) continue;
  try {
    const s = splitActualPrompt(m[1]!);
    const inventedLen = s.sections.INVENTED?.length ?? 0;
    const inventedCount = (s.sections.INVENTED?.match(/^- /gm) ?? []).length;
    console.log(`  turn_index=${log.turn_index} id=${log.id}: INVENTED = ${inventedLen} chars, ${inventedCount} entries`);
  } catch (err) {
    console.log(`  turn_index=${log.turn_index} id=${log.id}: (skipped: ${err instanceof Error ? err.message : err})`);
  }
}
