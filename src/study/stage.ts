import type { AttemptClass, CardProgress, Rating, Stage } from "./types.js";

/** Version of the provisional stage rule (spec 001 FR-005, spec 003 FR-011). Not a validated result. */
export const STAGE_RULE_VERSION = 1;

const UP: Record<Stage, Stage> = { guided: "reduced", reduced: "independent", independent: "retention", retention: "retention" };
const DOWN: Record<Stage, Stage> = { guided: "guided", reduced: "guided", independent: "reduced", retention: "retention" };

export function effectiveStage<Id>(progress: CardProgress<Id>, sessionKey: string): Stage {
  return progress.stageSince === sessionKey ? progress.previousStage : progress.stage;
}

export function initialProgress<Id>(cardId: Id, alreadyStudied: boolean, sessionKey: string): CardProgress<Id> {
  const stage: Stage = alreadyStudied ? "independent" : "guided";
  return { cardId, stage, previousStage: stage, stageSince: sessionKey, ruleVersion: STAGE_RULE_VERSION };
}

/**
 * Good/Easy without a cue move up one stage; Hard keeps it; Again moves down
 * (guided stays guided). A supported answer never moves up. Retention is
 * FSRS's business and never changes here. A change made in a session takes
 * effect only from the next one, and a card changes at most once per session.
 */
export function nextStage<Id>(
  progress: CardProgress<Id>,
  rating: Rating,
  attempt: AttemptClass,
  sessionKey: string,
): CardProgress<Id> {
  if (progress.stageSince === sessionKey) return progress;
  const current: Stage = progress.stage;
  if (current === "retention") return progress;
  let target: Stage = current;
  if (rating === 1) target = DOWN[current];
  else if (rating >= 3 && attempt === "independent") target = UP[current];
  if (target === current) return progress;
  return { cardId: progress.cardId, stage: target, previousStage: current, stageSince: sessionKey, ruleVersion: STAGE_RULE_VERSION };
}
