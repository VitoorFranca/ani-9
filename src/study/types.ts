export interface StudyCard {
  id: string;
}

export type RelationKind = "context" | "answer_hint";

/** Each edit appends a revision; the greatest version for an ID is current. */
export interface CardRelation {
  id: string;
  beforeCardId: string;
  afterCardId: string;
  kind: RelationKind;
  reason: string;
  version: number;
  active: boolean;
}

export interface RelationRef {
  id: string;
  version: number;
}

export interface CardExposure {
  sessionId: string;
  cardId: string;
  /** Epoch milliseconds when the answer became visible. */
  revealedAt: number;
}

export type StudyStage = "guided" | "reduced" | "independent" | "retention";

export interface StudyState {
  cardId: string;
  stage: StudyStage;
  ruleVersion: 1;
  /** A card is studied at most once per session. */
  lastSessionId?: string;
}
