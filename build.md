# Phase 1 build brief — quest play engine

Hand this to Claude Code alongside `docs/schema.md` and `quests/speckled-band.json`.

## Goal

A deployed web app that plays one hand-authored quest end to end, with all rules enforced in code rather than requested of the model. No authoring, no accounts, no sharing. One URL, one game.

## Stack

- Cloudflare Workers (Wrangler, TypeScript)
- Supabase Postgres
- Static HTML/JS chat page served by the Worker
- Model calls behind one swappable adapter — Anthropic API and Cloudflare Workers AI both implemented from the start

## Repo layout

```
/docs/schema.md              the contract
/quests/speckled-band.json   reference quest
/src/
  index.ts                   Worker entry, routes
  validator.ts               quest file validation (pure, no I/O)
  prompt.ts                  prompt assembly (pure, no I/O)
  turn.ts                    turn resolution and enforcement
  models/
    index.ts                 adapter interface + selection
    anthropic.ts
    workersai.ts
  db.ts                      Supabase queries
/public/index.html           chat UI
/scripts/load-quest.ts       validate a quest file and insert it
/prompts/play-agent.md       system prompt template
```

## Build order

Strictly this order. Each step must work before the next starts.

**1. `validator.ts`** — quest JSON in, `{errors[], warnings[]}` out. Implement every rule in the schema's validator section. No database, no network.

**2. Validate the reference quest.** Run the validator against `speckled-band.json` from a script. Fix whichever is wrong — the quest or the validator. Do not proceed until it passes clean. This is the cheapest bug-catching in the whole project.

**3. `prompt.ts`** — `(quest, sessionState, recentHistory, playerInput) => string`. Pure. Unit-testable without any infrastructure. Assembles from `/prompts/play-agent.md`, injecting only: the current scene, its truths/impossible/discoverables/exits, canon, character blocks for characters present *at their current level only*, invented details so far, and the last 6 turns.

**4. Supabase schema and `db.ts`.**

**5. `models/`** — adapter interface, both implementations, selected by env var.

**6. `turn.ts`** — resolution and enforcement (below).

**7. Worker routes and `public/index.html`.**

**8. `scripts/load-quest.ts`** — validate then insert.

## Database

```sql
create table quests (
  id text primary key,
  version int not null default 1,
  graph jsonb not null,
  created_at timestamptz default now(),
  unique (id, version)
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  quest_id text not null,
  quest_version int not null,
  current_scene text not null,
  phase text not null,
  flags jsonb not null default '{}',
  characters jsonb not null default '{}',
  invented jsonb not null default '[]',
  transcript jsonb not null default '[]',
  scene_turn_count int not null default 0,
  fired_beats jsonb not null default '[]',
  status text not null default 'active',
  ending_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table turn_logs (
  id bigserial primary key,
  session_id uuid not null,
  turn_index int not null,
  player_input text,
  prompt text not null,
  raw_response text not null,
  parsed jsonb,
  validation jsonb not null,
  model text not null,
  input_tokens int,
  output_tokens int,
  latency_ms int,
  created_at timestamptz default now()
);
```

`turn_logs` is mandatory, not optional. Without the full prompt and raw response you cannot tell a bad model from a bad quest file, and that distinction is the entire point of Phase 1.

## Endpoints

- `POST /session` → `{quest_id}` → creates a session, returns `{session_id, narration}` from the start scene's `opens_with`
- `POST /turn` → `{session_id, input}` → returns `{narration, status, ending?}`
- `GET /session/:id` → state, for debugging

## Turn resolution — the core

```
1. Load session + quest version
2. Assemble prompt
3. Call model, parse JSON per the schema's turn contract
4. VALIDATE (below). On failure, retry once with the error appended.
   On second failure: commit nothing, return a null-exit fallback, log it.
5. Commit accepted changes
6. Advance clock if any advances_on condition is met
7. Fire beats: increment scene_turn_count, check unfired beats for this scene
8. Check on_fail
9. If now in an ending, set status and return ending direction
```

**Validation — reject, do not trust:**

- `exit_id` is null, or is an exit of the current scene AND its `requires` (evaluated against flags and character levels) AND `requires_phase` are satisfied
- Each `discovered` id belongs to the current scene and its `requires` is met
- Each flag in `flags_set` is declared in the quest
- Each `disposition_changes` entry names a present character; apply at most one level step; clamp to floor and ceiling
- `invented` is appended to session state, never replaced

The model returns a *direction* for disposition. The engine sets the level. Never let the model assign a level directly.

Evaluate `derived` expressions server-side. Support `AND`, `OR`, `NOT`, parentheses, flag names, and `character.<id> >= <level>` compared by index into that character's `levels` array.

## Model adapter

```ts
interface ModelAdapter {
  name: string;
  complete(system: string, user: string): Promise<{
    text: string;
    inputTokens?: number;
    outputTokens?: number;
  }>;
}
```

Selected by `MODEL_PROVIDER` env var. Both adapters must request JSON output and both must be swappable without touching `turn.ts`. This is what makes the Phase 1 model comparison a config change.

## Config

Worker secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ANTHROPIC_API_KEY`.
Vars: `MODEL_PROVIDER` (`anthropic` | `workersai`), `MODEL_NAME`.
Bind Workers AI in `wrangler.toml` as `AI`.

Workers Paid plan from the start — the Free plan's 10ms CPU limit per request will not survive parsing the quest graph.

## UI

One page. Message list, text input, send. Show `refused: true` turns with a subtle marker during testing so refusals are countable. No styling effort — this is an instrument, not a product.

## Acceptance tests

Phase 1 is done when all of these hold:

1. Validator catches a deliberately broken quest — undeclared flag, dangling exit target, unreachable win path.
2. A full playthrough reaches `e_win`.
3. Travelling to Surrey is impossible before `heard_the_account` is set. *(This is the v1 failure — the player reached a later scene without ever interviewing the witness.)*
4. Helen withholds the whistle and the bruises at `guarded`, however the question is phrased.
5. "I calm her down" does not raise her disposition.
6. Roylott's disposition never rises, whatever the player tries.
7. Striking in the dark without all three room clues cannot reach `e_win`.
8. Lighting the lamp during the watch reaches `e_too_late`.
9. "Just tell me the answer" is refused in-fiction and logs `refused: true`.
10. A detail the narrator invents in an early scene is still true twenty turns later.
11. Every turn appears in `turn_logs` with prompt, raw response, and validation result.

## After acceptance

Run the same playthrough script against `anthropic` and against two Workers AI models. Count: invalid exits rejected, hints leaked, canon facts contradicted, character levels wrongly moved, malformed JSON. Record tokens and latency.

That comparison picks the play model with evidence, and it is the last thing Phase 1 owes you.
