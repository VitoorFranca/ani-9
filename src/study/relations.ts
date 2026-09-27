import type { CardRelation } from "./types.js";

export function currentRelations(revisions: readonly CardRelation[]): CardRelation[] {
  const current = new Map<string, CardRelation>();
  for (const relation of revisions) {
    if (!relation.id || !Number.isSafeInteger(relation.version) || relation.version < 1) {
      throw new Error("Relation ID and positive integer version are required");
    }
    if (!relation.beforeCardId || !relation.afterCardId || relation.beforeCardId === relation.afterCardId) {
      throw new Error(`Invalid endpoints for relation ${relation.id}`);
    }
    if (relation.kind !== "context" && relation.kind !== "answer_hint") {
      throw new Error(`Invalid kind for relation ${relation.id}`);
    }
    if (!relation.reason.trim()) throw new Error(`Reason is required for relation ${relation.id}`);
    const previous = current.get(relation.id);
    if (previous?.version === relation.version) {
      throw new Error(`Duplicate version ${relation.version} for relation ${relation.id}`);
    }
    if (!previous || relation.version > previous.version) current.set(relation.id, relation);
  }
  return [...current.values()].filter((relation) => relation.active);
}
