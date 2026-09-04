// Focused re-check: does HISTORY correctly drop turns beyond the last 6 once
// a session has actually played past 6 turns? part1-prompt-audit.ts's default
// mid-session pick doesn't stress this (too few prior turns exist yet).
import "dotenv/config";
import { createDbClientFromEnv, listTurnLogs, loadSession } from "../src/db.ts";
import { splitActualPrompt } from "./lib/prompt-sections.ts";

const sessionId = process.argv[2]!;
const client = createDbClientFromEnv();

const logs = await listTurnLogs(client, sessionId);
const validLogs = logs.filter((l) => l.validation.valid);
const last = validLogs[validLogs.length - 1]!;
console.log(`Last valid turn: id=${last.id} turn_index=${last.turn_index} (${validLogs.length} valid logs total)`);

const match = last.prompt.match(/^\[SYSTEM\]\n([\s\S]*?)\n\n\[USER\]/);
const system = match![1]!;
const split = splitActualPrompt(system);
const historyText = split.sections.HISTORY ?? "";
const narratorTurnsShown = (historyText.match(/^Narrator: /gm) ?? []).length;
console.log(`HISTORY shows ${narratorTurnsShown} turns (cap should be 6, ${last.turn_index} prior turns exist)`);

const session = await loadSession(client, sessionId);
const transcript = session!.transcript as unknown as { narration: string; player_input: string | null }[];
console.log(`Full session transcript: ${transcript.length} turns`);

// This prompt was built for turn_index=last.turn_index, i.e. BEFORE that turn
// happened — its own narration can't be in its own history. The 6-turn
// window covers the turns strictly before it: indices
// [turn_index-6, turn_index-1].
const turnIndex = last.turn_index;
const windowStart = Math.max(0, turnIndex - 6);
const windowEnd = turnIndex - 1;
console.log(`Turn ${turnIndex}'s own history window should be turns ${windowStart}..${windowEnd} (its own output, turn ${turnIndex}, is N/A — hadn't happened yet).`);
console.log(`Turns 0..${windowStart - 1} should be absent from HISTORY (older than the 6-turn window):`);
for (let i = 0; i < windowStart; i++) {
  const snippet = transcript[i]!.narration.slice(0, 50);
  const present = historyText.includes(snippet);
  console.log(`  turn ${i}: "${snippet}..." -> ${present ? "*** PRESENT (should NOT be) ***" : "absent (OK)"}`);
}
console.log(`Turns ${windowStart}..${windowEnd} should be present (within the 6-turn window):`);
for (let i = windowStart; i <= windowEnd; i++) {
  const snippet = transcript[i]!.narration.slice(0, 50);
  const present = historyText.includes(snippet);
  console.log(`  turn ${i}: "${snippet}..." -> ${present ? "present (OK)" : "*** MISSING (should be present) ***"}`);
}
