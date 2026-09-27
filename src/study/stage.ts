import type { StudyStage, StudyState } from "./types.js";

export function initialStudyState(cardId: string): StudyState {
  if (!cardId) throw new Error("Card ID is required");
  return { cardId, stage: "guided", ruleVersion: 1 };
}

/** Records one answer and returns the state eligible in a later session. */
export function advanceStudyStage(
  state: StudyState,
  rating: 1 | 2 | 3 | 4,
  hadImmediateCue: boolean,
  sessionId: string,
): StudyState {
  if (!sessionId || state.lastSessionId === sessionId) {
    throw new Error("A card can be studied only once per session");
  }
  if (![1, 2, 3, 4].includes(rating)) throw new Error("Rating must be 1–4");
  if (state.ruleVersion !== 1) throw new Error("Unsupported study rule version");
  if (state.stage === "retention") return { ...state, lastSessionId: sessionId };

  const advances = rating >= 3;
  let stage: StudyStage = state.stage;
  if (stage === "guided") {
    if (advances) stage = "reduced";
  } else if (stage === "reduced") {
    if (rating === 1) stage = "guided";
    else if (advances && !hadImmediateCue) stage = "independent";
  } else if (stage === "independent") {
    if (rating === 1) stage = "reduced";
    else if (advances && !hadImmediateCue) stage = "retention";
  }
  return { ...state, stage, lastSessionId: sessionId };
}
