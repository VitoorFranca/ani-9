const CLOZE_MARKER = /\{\{c\d+::(.*?)\}\}/gis;

export function hasCloze(text: string): boolean {
  CLOZE_MARKER.lastIndex = 0;
  return CLOZE_MARKER.test(text);
}

/**
 * Resolves every cloze deletion in the text to its revealed answer, e.g.
 * `{{c1::Paris::capital}}` -> `Paris`. All clozes are resolved regardless of
 * which `ord` the resulting card belongs to: we want the full sentence for
 * concept extraction, not a simulation of what's hidden during review.
 */
export function resolveCloze(text: string): string {
  CLOZE_MARKER.lastIndex = 0;
  return text.replace(CLOZE_MARKER, (_match, inner: string) => {
    const answer = inner.split("::")[0] ?? "";
    return answer;
  });
}
