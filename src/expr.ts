// Pure evaluator for the boolean expression grammar defined in docs/schema.md
// (derived, requires, requires_phase, on_fail.when): AND, OR, NOT, parentheses,
// flag/derived names, and `character.<id> >= <level>`. No I/O.

export interface ExprContext {
  flags: Record<string, boolean>;
  derived: Record<string, string>;
  characterLevels: Record<string, { levels: string[]; current: string }>;
}

type Token =
  | { type: "LPAREN" | "RPAREN" | "AND" | "OR" | "NOT" }
  | { type: "CHAR_CMP"; character: string; level: string }
  | { type: "IDENT"; value: string };

const TOKEN_RE =
  /\(|\)|\bAND\b|\bOR\b|\bNOT\b|character\.([a-zA-Z_][\w-]*)\s*>=\s*([a-zA-Z_][\w-]*)|[a-zA-Z_][\w-]*/gi;

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  for (const match of expr.matchAll(TOKEN_RE)) {
    const text = match[0];
    if (text === "(") tokens.push({ type: "LPAREN" });
    else if (text === ")") tokens.push({ type: "RPAREN" });
    else if (/^AND$/i.test(text)) tokens.push({ type: "AND" });
    else if (/^OR$/i.test(text)) tokens.push({ type: "OR" });
    else if (/^NOT$/i.test(text)) tokens.push({ type: "NOT" });
    else if (match[1] !== undefined) {
      tokens.push({ type: "CHAR_CMP", character: match[1], level: match[2]! });
    } else {
      tokens.push({ type: "IDENT", value: text });
    }
  }
  return tokens;
}

export function evaluateExpression(expr: string, ctx: ExprContext): boolean {
  const tokens = tokenize(expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const advance = () => tokens[pos++];

  function parseOr(): boolean {
    let value = parseAnd();
    while (peek()?.type === "OR") {
      advance();
      const rhs = parseAnd();
      value = value || rhs;
    }
    return value;
  }

  function parseAnd(): boolean {
    let value = parseNot();
    while (peek()?.type === "AND") {
      advance();
      const rhs = parseNot();
      value = value && rhs;
    }
    return value;
  }

  function parseNot(): boolean {
    if (peek()?.type === "NOT") {
      advance();
      return !parseNot();
    }
    return parseAtom();
  }

  function parseAtom(): boolean {
    const tok = peek();
    if (!tok) throw new Error(`Unexpected end of expression: '${expr}'`);

    if (tok.type === "LPAREN") {
      advance();
      const value = parseOr();
      if (peek()?.type !== "RPAREN") {
        throw new Error(`Expected ')' in expression: '${expr}'`);
      }
      advance();
      return value;
    }

    if (tok.type === "CHAR_CMP") {
      advance();
      const state = ctx.characterLevels[tok.character];
      if (!state) throw new Error(`Unknown character '${tok.character}' in expression: '${expr}'`);
      const requiredIdx = state.levels.indexOf(tok.level);
      if (requiredIdx === -1) {
        throw new Error(`Unknown level '${tok.level}' for character '${tok.character}' in expression: '${expr}'`);
      }
      const currentIdx = state.levels.indexOf(state.current);
      return currentIdx >= requiredIdx;
    }

    if (tok.type === "IDENT") {
      advance();
      if (tok.value in ctx.flags) return ctx.flags[tok.value]!;
      if (tok.value in ctx.derived) return evaluateExpression(ctx.derived[tok.value]!, ctx);
      throw new Error(`Unknown flag or derived name '${tok.value}' in expression: '${expr}'`);
    }

    throw new Error(`Unexpected token in expression: '${expr}'`);
  }

  const result = parseOr();
  if (pos < tokens.length) {
    throw new Error(`Unexpected trailing tokens in expression: '${expr}'`);
  }
  return result;
}
