import { resolveCloze } from "./cloze.js";

const SOUND_REF = /\[sound:[^\]]*\]/gi;
const IMG_TAG = /<img\b[^>]*>/gi;
const ANY_TAG = /<[^>]+>/g;
const WHITESPACE = /\s+/g;

const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/g, (match) => HTML_ENTITIES[match] ?? match);
}

/**
 * Normalizes a single note field: resolves cloze deletions, strips media
 * references and HTML markup, decodes entities, and collapses whitespace.
 */
export function normalizeFieldText(raw: string): string {
  let text = resolveCloze(raw);
  text = text.replace(SOUND_REF, " ");
  text = text.replace(IMG_TAG, " ");
  text = text.replace(ANY_TAG, " ");
  text = decodeHtmlEntities(text);
  text = text.replace(WHITESPACE, " ").trim();
  return text;
}
