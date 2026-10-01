import type { SessionContext } from "./types.js";

export interface ShadowDecisionModel<Id> {
  readonly name: string;
  readonly version: string;
  /** What the model would show next. Recorded only; it never decides the session. */
  propose(context: SessionContext<Id>): Id | null;
}

/**
 * Experimental placeholder for layer 3: proposes the candidate with the most
 * active relations (a "hub first" heuristic), ties by created order. It exists
 * to exercise shadow logging; it is not trained and makes no claim.
 */
export const baselineShadowModel: ShadowDecisionModel<any> = {
  name: "hub-first",
  version: "1",
  propose<Id>(context: SessionContext<Id>): Id | null {
    const degree = new Map<Id, number>();
    for (const r of context.relations) {
      if (r.status !== "active") continue;
      degree.set(r.from, (degree.get(r.from) ?? 0) + 1);
      degree.set(r.to, (degree.get(r.to) ?? 0) + 1);
    }
    const orderOf = new Map(context.cards.map((c) => [c.id, c.createdOrder]));
    let best: Id | null = null;
    for (const id of context.candidates) {
      if (best === null) {
        best = id;
        continue;
      }
      const d = (degree.get(id) ?? 0) - (degree.get(best) ?? 0);
      if (d > 0 || (d === 0 && (orderOf.get(id) ?? Infinity) < (orderOf.get(best) ?? Infinity))) best = id;
    }
    return best;
  },
};
