import { explainPosition, orderCards } from "./order.js";
import { effectiveStage } from "./stage.js";
import type { PlanDecision, SessionContext, Stage } from "./types.js";

/**
 * Next card of a guided session. Due retention cards keep FSRS's order and
 * come first; guided cards follow the relation order. A card is skipped for
 * now when its stage forbids what was already shown this session: in
 * `reduced`, a card revealing its answer; in `independent`, any related card.
 */
export function planNext<Id>(context: SessionContext<Id>): PlanDecision<Id> {
  const stageOf = (id: Id): Stage => {
    const p = context.progress.get(id);
    return p ? effectiveStage(p, context.sessionKey) : "guided";
  };
  const shownNow = new Set(context.exposures.filter((e) => e.sessionKey === context.sessionKey).map((e) => e.cardId));
  const active = context.relations.filter((r) => r.status === "active" && r.from !== r.to);

  const allowed = (id: Id): boolean => {
    const stage = stageOf(id);
    if (stage === "reduced") return !active.some((r) => r.kind === "cue" && r.to === id && shownNow.has(r.from));
    if (stage === "independent") {
      return !active.some((r) => (r.to === id && shownNow.has(r.from)) || (r.from === id && shownNow.has(r.to)));
    }
    return true;
  };

  const retention = context.candidates.filter((id) => stageOf(id) === "retention");
  const guided = new Set(context.candidates.filter((id) => stageOf(id) !== "retention"));
  const { order } = orderCards(context.cards, context.relations);
  const inOrder = new Set(order);
  const ranked = [...order.filter((id) => guided.has(id)), ...[...guided].filter((id) => !inOrder.has(id))];

  const chosen = [...retention, ...ranked].find(allowed) ?? null;
  return { cardId: chosen, reasons: chosen === null ? [] : explainPosition(chosen, context.cards, context.relations) };
}
