import type { AttemptClass, Exposure, Relation } from "./types.js";

/**
 * An answer is `supported` if, and only if, another card holding an active
 * cue relation to it ("reveals its answer") was shown earlier in the same
 * session. Exposures from earlier sessions are history, not an immediate cue.
 */
export function classifyAttempt<Id>(
  cardId: Id,
  session: { sessionKey: string; exposures: readonly Exposure<Id>[] },
  relations: readonly Relation<Id>[],
): AttemptClass {
  const revealers = new Set(
    relations.filter((r) => r.kind === "cue" && r.status === "active" && r.to === cardId && r.from !== cardId).map((r) => r.from),
  );
  if (revealers.size === 0) return "independent";
  return session.exposures.some((e) => e.sessionKey === session.sessionKey && revealers.has(e.cardId)) ? "supported" : "independent";
}
