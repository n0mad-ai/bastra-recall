/**
 * One spelling and one case fold for every matcher.
 *
 * Each matcher normalised text its own way, or not at all, so text typed on
 * macOS (NFD), a Turkish word in capitals ("İ" lowercases to i + U+0307), a
 * German "GRÖSSE", fullwidth ＡＰＩ or half-width ｶﾅ from an IME, a ZWSP in Thai
 * text or a niqqud-pointed Hebrew word never met its plain spelling.
 *
 * `normalizeText` is the spelling every matcher compares: NFKC, invisible
 * format characters and Arabic tatweel removed, the optional vowel points of
 * the abjads dropped, an in-word apostrophe of a non-Latin script joined.
 * `foldTerm` adds a case fold that does not depend on the host locale and
 * folds Turkish İ/ı and German ß with their pairs. No word lists.
 */

const ASCII_RE = /^[\x00-\x7f]*$/;
/** Invisible format characters (ZWSP, ZWNJ, ZWJ, soft hyphen, bidi marks,
 *  BOM) and Arabic tatweel: typography, never part of a word's identity. */
const INVISIBLE_RE = /[\p{Cf}\u0640]/gu;
/** The optional vowel points of the abjads: niqqud, harakat, shadda. Written
 *  in textbooks and poetry, left out everywhere else — the word is the same. */
const ABJAD_POINT_RE = /(?=\p{Mn})[\p{Script_Extensions=Hebrew}\p{Script_Extensions=Arabic}\p{Script_Extensions=Syriac}]/gu;
/** An apostrophe between two letters of a non-Latin script is part of the
 *  word — the Ukrainian/Belarusian apostrophe ("п'ятниця", "обʼєкт"), the
 *  Hebrew geresh typed as "'" ("סטייג'ינג") — and would otherwise split it
 *  into fragments. Latin keeps the split: there it marks elision and
 *  contraction ("l'état", "don't"). */
const INWORD_APOSTROPHE_RE = /(?<=(?!\p{Script=Latin})\p{L}\p{M}*)['\u2019\u02bc\u05f3](?=(?!\p{Script=Latin})\p{L})/gu;

/**
 * The spelling every matcher compares, case left alone: NFKC, invisible
 * format characters and tatweel removed, abjad vowel points dropped, an
 * in-word apostrophe of a non-Latin script joined. Pure, idempotent; identity
 * for ASCII.
 */
export function normalizeText(text: string): string {
  if (ASCII_RE.test(text)) return text;
  return text
    .normalize("NFKC")
    .replace(INVISIBLE_RE, "")
    .replace(ABJAD_POINT_RE, "")
    .replace(INWORD_APOSTROPHE_RE, "")
    .normalize("NFC");
}

/**
 * `normalizeText` plus a case fold that is the same on every host. `toLowerCase`
 * alone leaves "ß" ≠ "SS"→"ss", and turns Turkish "İ" into "i" + a combining
 * dot, so a Turkish word typed in capitals never met its lowercase form. The
 * round trip through upper case folds ß/ẞ, final sigma and long s; the dotted
 * and dotless i of Turkish fold to "i" together (on a keyboard without them
 * users type i/I anyway). Idempotent.
 */
export function foldTerm(term: string): string {
  if (ASCII_RE.test(term)) return term.toLowerCase();
  return normalizeText(term).toUpperCase().toLowerCase().replace(/i\u0307/g, "i");
}

