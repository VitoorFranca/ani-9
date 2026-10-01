export * from "./types.js";
export { orderCards, explainPosition, describeCues } from "./order.js";
export { classifyAttempt } from "./cue.js";
export { STAGE_RULE_VERSION, nextStage, effectiveStage, initialProgress } from "./stage.js";
export { planNext } from "./planner.js";
export { baselineShadowModel } from "./shadow.js";
export type { ShadowDecisionModel } from "./shadow.js";
export {
  candidatePairs,
  relationsFromJudgement,
  isPairJudgement,
  answerCoverage,
  contentWords,
  renderPair,
  SUGGESTION_PROMPT,
  SUGGESTION_SCHEMA,
  DEFAULT_NEIGHBORS,
  MIN_ANSWER_COVERAGE,
} from "./suggest.js";
export type { CandidatePair, PairJudgement, RevealAnswer, BeforeAnswer } from "./suggest.js";
// Re-exported here so consumers of the study rules never load the concepts
// module's embedding stack (onnxruntime) just to get these light helpers.
export { ENGLISH_FUNCTION_WORDS, PORTUGUESE_FUNCTION_WORDS } from "../concepts/vocabulary.js";
export { generateJson, DEFAULT_GEMINI_MODEL } from "../concepts/gemini-client.js";
export type { MinimalGeminiClient } from "../concepts/gemini-client.js";
