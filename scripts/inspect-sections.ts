import { splitActualPrompt } from "./lib/prompt-sections.ts";
import { readFileSync } from "node:fs";

const file = process.argv[2]!;
const full = readFileSync(file, "utf8");
const m = full.match(/^\[SYSTEM\]\n([\s\S]*?)\n\n\[USER\]\n([\s\S]*)$/);
const s = splitActualPrompt(m![1]!);
console.log("=== FRAME ===\n" + s.sections.FRAME);
console.log("\n=== SCENE ===\n" + s.sections.SCENE);
console.log("\n=== CHARACTERS ===\n" + s.sections.CHARACTERS);
console.log("\n=== USER INPUT (from [USER] block) ===\n" + m![2]);
