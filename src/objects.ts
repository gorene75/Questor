// Pure object-graph lookups. No I/O, no database — resolveObject is the
// only reader of quest.game_objects (world truth, hand-authored, static).
// Everything stateful (seeding game_objects into the DB, writing
// player_knowledge) lives in db.ts; prompt.ts must never import this
// module's game_objects data directly, only the already-fetched
// player_knowledge a session has actually been disclosed.

import type { GameObjectSpec, Quest, RelationalKnowledgeSpec } from "./validator.ts";

/** The object's fixed, full resolved content, or undefined if no such object is declared for this quest. Deterministic, no side effects. */
export function resolveObject(quest: Quest, objectId: string): GameObjectSpec["resolved"] | undefined {
  return quest.game_objects?.find((o) => o.id === objectId)?.resolved;
}

/** What `holderId` knows about the entity referred to as `subjectRef` (e.g. helen's "stepfather"), or undefined if no such pair is declared. Deterministic, no side effects. */
export function findRelationalKnowledge(
  quest: Quest,
  holderId: string,
  subjectRef: string
): RelationalKnowledgeSpec | undefined {
  return quest.character_relational_knowledge?.find((rk) => rk.holder_id === holderId && rk.subject_ref === subjectRef);
}

/** Whether `objectId` is currently placed in `currentScene`, per this session's object_placement. Pure — takes the already-loaded placement map, never touches the DB itself. */
export function isPresent(placement: Record<string, string | null>, objectId: string, currentScene: string): boolean {
  return placement[objectId] === currentScene;
}
