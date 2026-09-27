import { currentRelations } from "./relations.js";
import type { CardRelation, RelationRef, StudyCard, StudyState } from "./types.js";

export type OrderProblem =
  | { type: "missing_card"; relation: RelationRef; cardId: string }
  | { type: "cycle"; cardIds: string[] };

export interface GuidedOrder {
  cardIds: string[];
  reasonsByCardId: Record<string, { fromCardId: string; relation: RelationRef; reason: string }[]>;
  problems: OrderProblem[];
}

/** Stable topological ordering. Cyclic/blocked cards remain unscheduled. */
export function orderGuidedCards(
  cards: readonly StudyCard[],
  revisions: readonly CardRelation[],
): GuidedOrder {
  const ids = cards.map((card) => card.id);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error("Card IDs must be unique and non-empty");
  }
  const known = new Set(ids);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map(ids.map((id) => [id, new Set<string>()]));
  const reasonsByCardId: GuidedOrder["reasonsByCardId"] = Object.fromEntries(ids.map((id) => [id, []]));
  const problems: OrderProblem[] = [];

  for (const relation of currentRelations(revisions)) {
    const ref = { id: relation.id, version: relation.version };
    if (!known.has(relation.beforeCardId)) {
      problems.push({ type: "missing_card", relation: ref, cardId: relation.beforeCardId });
    }
    if (!known.has(relation.afterCardId)) {
      problems.push({ type: "missing_card", relation: ref, cardId: relation.afterCardId });
    }
    if (!known.has(relation.beforeCardId) || !known.has(relation.afterCardId)) continue;
    reasonsByCardId[relation.afterCardId]!.push({
      fromCardId: relation.beforeCardId,
      relation: ref,
      reason: relation.reason,
    });
    const edges = outgoing.get(relation.beforeCardId)!;
    if (!edges.has(relation.afterCardId)) {
      edges.add(relation.afterCardId);
      indegree.set(relation.afterCardId, indegree.get(relation.afterCardId)! + 1);
    }
  }

  const remaining = new Set(ids);
  const cardIds: string[] = [];
  while (remaining.size) {
    const next = ids.find((id) => remaining.has(id) && indegree.get(id) === 0);
    if (!next) break;
    remaining.delete(next);
    cardIds.push(next);
    for (const target of outgoing.get(next)!) indegree.set(target, indegree.get(target)! - 1);
  }
  if (remaining.size) problems.push({ type: "cycle", cardIds: ids.filter((id) => remaining.has(id)) });
  return { cardIds, reasonsByCardId, problems };
}

/** Applies the target card's current support level to a session's order. */
export function orderStudySession(
  cards: readonly StudyCard[],
  revisions: readonly CardRelation[],
  states: readonly StudyState[],
): GuidedOrder {
  const stageById = new Map(states.map((state) => [state.cardId, state.stage]));
  const adjusted = currentRelations(revisions).flatMap((relation): CardRelation[] => {
    const stage = stageById.get(relation.afterCardId) ?? "guided";
    if (stage === "retention") return [];
    if (stage === "guided" || (stage === "reduced" && relation.kind === "context")) return [relation];
    return [{
      ...relation,
      beforeCardId: relation.afterCardId,
      afterCardId: relation.beforeCardId,
      reason: `Mostrar ${relation.afterCardId} antes de ${relation.beforeCardId} para evitar pista`,
    }];
  });
  return orderGuidedCards(cards, adjusted);
}
