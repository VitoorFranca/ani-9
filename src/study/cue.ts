import { currentRelations } from "./relations.js";
import type { CardExposure, CardRelation, RelationRef } from "./types.js";

export interface CueClassification {
  hadImmediateCue: boolean;
  relations: RelationRef[];
}

/** Only answers revealed earlier in the same session count as immediate cues. */
export function classifyAttemptCue(
  cardId: string,
  sessionId: string,
  answeredAt: number,
  exposures: readonly CardExposure[],
  revisions: readonly CardRelation[],
): CueClassification {
  if (!cardId || !sessionId || !Number.isFinite(answeredAt)) {
    throw new Error("Card, session and answer time are required");
  }
  const revealed = new Set(
    exposures
      .filter((event) => event.sessionId === sessionId && event.revealedAt < answeredAt)
      .map((event) => event.cardId),
  );
  const relations = currentRelations(revisions)
    .filter((relation) => relation.kind === "answer_hint" && relation.afterCardId === cardId && revealed.has(relation.beforeCardId))
    .map(({ id, version }) => ({ id, version }));
  return { hadImmediateCue: relations.length > 0, relations };
}
