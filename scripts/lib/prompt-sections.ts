// Splits an actually-assembled system prompt back into its named sections by
// anchoring on the fixed literal text of PLAY_AGENT_TEMPLATE around each
// {{PLACEHOLDER}} line. Read-only string surgery on a dumped prompt — does
// not touch src/prompt.ts or require re-deriving state from the quest/db.
import { PLAY_AGENT_TEMPLATE } from "../../src/promptTemplate.ts";

export interface SplitPrompt {
  /** Section name -> its filled-in content (no surrounding template text). */
  sections: Record<string, string>;
  /** The literal template text that is NOT any placeholder's content, in original order. */
  staticSpans: string[];
  totalStaticChars: number;
  fullLength: number;
}

const PLACEHOLDER_LINE = /^\{\{([A-Z]+)\}\}$/gm;

function splitTemplateOnPlaceholders(template: string): { statics: string[]; names: string[] } {
  const statics: string[] = [];
  const names: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  PLACEHOLDER_LINE.lastIndex = 0;
  while ((match = PLACEHOLDER_LINE.exec(template))) {
    statics.push(template.slice(lastIndex, match.index));
    names.push(match[1]!);
    lastIndex = match.index + match[0].length;
  }
  statics.push(template.slice(lastIndex));
  return { statics, names };
}

// prompt.ts's real fillTemplateParts strips this marker line out of the
// actual assembled prompt (it only exists in the source template to mark
// where the static/dynamic split happens) — strip it here too so the
// anchor text we search for matches what's really in the prompt.
const DYNAMIC_MARKER = "\n<<<DYNAMIC>>>\n";

export function splitActualPrompt(actualSystemPrompt: string): SplitPrompt {
  const templateForAnchors = PLAY_AGENT_TEMPLATE.replace(DYNAMIC_MARKER, "\n");
  const { statics, names } = splitTemplateOnPlaceholders(templateForAnchors);
  const sections: Record<string, string> = {};
  const staticSpans: string[] = [];
  let cursor = 0;

  for (let i = 0; i < names.length; i++) {
    const staticPiece = statics[i]!;
    const idx = actualSystemPrompt.indexOf(staticPiece, cursor);
    if (idx !== cursor) {
      throw new Error(
        `Static anchor mismatch before {{${names[i]}}}: expected at offset ${cursor}, found at ${idx}. ` +
          `The actual prompt no longer matches PLAY_AGENT_TEMPLATE's fixed text — was it regenerated recently?`
      );
    }
    staticSpans.push(staticPiece);
    cursor = idx + staticPiece.length;

    const nextStatic = statics[i + 1]!;
    let nextIdx = nextStatic.length > 0 ? actualSystemPrompt.indexOf(nextStatic, cursor) : actualSystemPrompt.length;
    // A whitespace-only static span may have been eaten entirely by
    // fillTemplateParts's .trim() on the real prompt's dynamic half — this
    // can only happen at the very end (the last static span, after the
    // final placeholder), so only fall back there; anywhere else a search
    // miss is a real mismatch and should still throw.
    if (nextIdx === -1 && nextStatic.trim().length === 0 && i === names.length - 1) {
      nextIdx = actualSystemPrompt.length;
    }
    if (nextIdx === -1) {
      throw new Error(`Could not find the static text following {{${names[i]}}} anywhere after offset ${cursor}`);
    }
    sections[names[i]!] = actualSystemPrompt.slice(cursor, nextIdx);
    cursor = nextIdx;
  }

  const trailingStatic = statics[statics.length - 1]!;
  if (trailingStatic.trim().length > 0 || cursor < actualSystemPrompt.length) {
    const idx = actualSystemPrompt.indexOf(trailingStatic, cursor);
    if (idx !== cursor && trailingStatic.trim().length > 0) {
      throw new Error(`Static anchor mismatch for trailing template text: expected at ${cursor}, found at ${idx}`);
    }
  }
  staticSpans.push(trailingStatic);

  return {
    sections,
    staticSpans,
    totalStaticChars: staticSpans.reduce((sum, s) => sum + s.length, 0),
    fullLength: actualSystemPrompt.length,
  };
}
