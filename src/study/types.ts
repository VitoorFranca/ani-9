export type RelationKind = "prerequisite" | "cue";
export type RelationOrigin = "local" | "external" | "person";
export type RelationStatus = "active" | "removed";
export type Stage = "guided" | "reduced" | "independent" | "retention";
export type AttemptClass = "supported" | "independent";
export type Rating = 1 | 2 | 3 | 4;

/** `front` is what the card asks; `back` is its answer (for cloze, the hidden deletion). */
export interface StudyCard<Id> {
  id: Id;
  front: string;
  back: string;
  /** Position in the deck's normal order; ties are broken by it everywhere. */
  createdOrder: number;
}

/**
 * `prerequisite`: `from` helps to understand `to`, so `from` comes first.
 * `cue`: `from` reveals the answer of `to`.
 */
export interface Relation<Id> {
  from: Id;
  to: Id;
  kind: RelationKind;
  origin: RelationOrigin;
  status: RelationStatus;
  version: number;
  /** Short plain-language justification, when the source provides one. */
  reason?: string;
}

/**
 * A stage change made in session S only takes effect from the next session:
 * while `stageSince === S`, the effective stage is still `previousStage`.
 */
export interface CardProgress<Id> {
  cardId: Id;
  stage: Stage;
  previousStage: Stage;
  stageSince: string;
  ruleVersion: number;
}

export interface Exposure<Id> {
  cardId: Id;
  shownAt: number;
  sessionKey: string;
}

export interface SessionContext<Id> {
  sessionKey: string;
  /** Every card of the deck, for ordering. */
  cards: readonly StudyCard<Id>[];
  relations: readonly Relation<Id>[];
  /** Progress of guided cards; a candidate without progress is treated as `guided`. */
  progress: ReadonlyMap<Id, CardProgress<Id>>;
  /** Cards shown so far in this session. */
  exposures: readonly Exposure<Id>[];
  /** Cards that may be shown now: FSRS-due retention cards first, in the caller's order, then guided cards. */
  candidates: readonly Id[];
}

export type ReasonCode = "after-prerequisite" | "before-dependent" | "cue-from" | "cue-to" | "cycle" | "none";

export interface Reason<Id> {
  code: ReasonCode;
  otherId?: Id;
  text: string;
}

export interface PlanDecision<Id> {
  cardId: Id | null;
  reasons: Reason<Id>[];
}

export interface CycleReport<Id> {
  cardIds: Id[];
}
