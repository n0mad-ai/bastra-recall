/**
 * Word forms: when two tokens are the same word, in any suffixing,
 * agglutinating or prefixing language, without a stemmer or a word list.
 *
 * Exact token equality is right for English and wrong for most languages: a
 * Russian case ending ("арка" / "арке"), a German verb form ("Antwort" /
 * "antworten"), a Finnish or Turkish case suffix, an Arabic or Hebrew article
 * prefix. `sameWordForm` accepts a long enough common stem with a bounded
 * ending, a long ending on a long stem, or a short prefix before the stem;
 * short tokens, identifiers and numbers stay exact. Lengths are counted in
 * letters (`letterCount`), not code points.
 */

const ASCII_RE = /^[\x00-\x7f]*$/;
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;

/**
 * How many letters (and digits) `token` has, marks not counted: canonical
 * decomposition first, so a precomposed "é" is one letter, a Devanagari vowel
 * sign or virama is none ("में" = 1, "स्क्रिप्ट" = 5) and a Hangul syllable
 * counts its jamo ("배포" = 4 — a Korean syllable carries what two or three
 * Latin letters do). Code points overcount Indic words and undercount Korean
 * ones; letters make one threshold mean the same thing in every script.
 */
export function letterCount(token: string): number {
  if (ASCII_RE.test(token)) {
    let n = 0;
    for (let i = 0; i < token.length; i++) {
      const c = token.charCodeAt(i);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) n++;
    }
    return n;
  }
  let n = 0;
  for (const ch of token.normalize("NFD")) if (LETTER_OR_DIGIT_RE.test(ch)) n++;
  return n;
}


const LETTERS_ONLY_RE = /^[\p{L}\p{M}]+$/u;
/** Below this many letters two different tokens are never one word. */
export const WORD_FORM_MIN_LEN = 4;
/** The abjads write consonants only: a three-letter Hebrew or Arabic word
 *  (ספר, كتب) carries what a five- or six-letter Latin word does. */
const ABJAD_WORD_FORM_MIN_LEN = 3;
const ABJAD_RE = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Samaritan}\p{Script=Mandaic}]/u;
/** An ending longer than this is a different word, not an inflection… */
const WORD_FORM_MAX_GAP = 3;
/** …unless the stem itself is at least this long: agglutinative endings
 *  (Finnish -ssakin, Turkish -larında, Korean particle chains) are long, but
 *  they hang on long stems. */
const LONG_STEM = 6;
/** A prefix (article, clitic, noun-class marker) is at most this long. */
const WORD_FORM_MAX_PREFIX = 3;
/** The stem a prefix is stripped against must be this long outside the
 *  abjads — shorter stems rhyme by accident ("range"/"orange"). */
const PREFIXED_STEM_MIN = 6;

function minWordFormLetters(token: string): number {
  return ABJAD_RE.test(token) ? ABJAD_WORD_FORM_MIN_LEN : WORD_FORM_MIN_LEN;
}

/**
 * The characters `sameWordForm` compares: canonical decomposition with every
 * combining mark kept on its base letter, so "й", "é" and a Devanagari
 * consonant with its vowel sign each stay one character, while a Hangul
 * syllable opens into its jamo (letters in their own right, not marks).
 */
function formUnits(token: string): string[] {
  const out: string[] = [];
  for (const ch of token.normalize("NFD")) {
    if (out.length > 0 && COMBINING_MARK_RE.test(ch)) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}
const COMBINING_MARK_RE = /\p{M}/u;

function indexOfRun(hay: string[], needle: string[], from: number, to: number): number {
  outer: for (let i = from; i <= to && i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Are `a` and `b` forms of the same word? Case-sensitive — callers compare
 * lowercased tokens. Exact equality always holds. Otherwise both
 * must be letters only (identifiers, numbers and paths stay exact), the
 * shorter at least `WORD_FORM_MIN_LEN` letters (three in the abjads), and one
 * of three shapes must hold, compared on canonically decomposed characters:
 *
 * - suffix: the common prefix covers the shorter token except its last
 *   character (≤ 5 characters) or its last two, and the lengths are at most
 *   `WORD_FORM_MAX_GAP` apart — or any distance when the shared stem is the
 *   whole shorter token less one character and at least `LONG_STEM` long;
 * - prefix: the shorter token, less at most two trailing characters, sits
 *   inside the longer one after a prefix of one to `WORD_FORM_MAX_PREFIX`
 *   characters (or with its first character swapped for another one), with
 *   at most `WORD_FORM_MAX_GAP` after it; that stem needs `PREFIXED_STEM_MIN`
 *   characters outside the abjads.
 *
 *   арка ~ арке · Antwort ~ antworten · 切り替え ~ 切り替える · update ~ updated
 *   laskun ~ laskuissa · şablonu ~ şablonlarında · 청구서 ~ 청구서들을
 *   قالب ~ بالقالب · חשבונית ~ החשבוניות · kiolezo ~ violezo
 *   state ≁ statement · range ≁ orange · code ≁ card · ci ≁ cd
 */
export function sameWordForm(a: string, b: string): boolean {
  if (a === b) return true;
  if (!LETTERS_ONLY_RE.test(a) || !LETTERS_ONLY_RE.test(b)) return false;
  const ua = formUnits(a);
  const ub = formUnits(b);
  const [s, l] = ua.length <= ub.length ? [ua, ub] : [ub, ua];
  const shorter = s === ua ? a : b;
  const minLetters = minWordFormLetters(shorter);
  if (letterCount(shorter) < minLetters) return false;
  const gap = l.length - s.length;

  let prefix = 0;
  while (prefix < s.length && s[prefix] === l[prefix]) prefix++;
  if (prefix === s.length && gap === 0) return true; // NFC vs NFD spelling
  // A three-character stem has no ending to spare: ספר ~ ספרים, not ספר ~ ספק.
  const need = s.length <= 3 ? s.length : Math.max(3, s.length <= 5 ? s.length - 1 : s.length - 2);
  if (prefix >= need && gap <= WORD_FORM_MAX_GAP) return true;
  // A long ending needs the whole shorter token (less one character) as its
  // stem: laskun ~ laskuissa, not contract ~ contradiction.
  if (prefix >= Math.max(LONG_STEM, s.length - 1)) return true;

  const stemMin = minLetters === WORD_FORM_MIN_LEN ? PREFIXED_STEM_MIN : ABJAD_WORD_FORM_MIN_LEN;
  for (let lead = 0; lead <= 1; lead++) {
    for (let trail = 0; trail <= 2; trail++) {
      const stem = s.slice(lead, s.length - trail);
      if (stem.length < stemMin) continue;
      // A changed first character is a swapped prefix of the same size
      // (ki-/vi-, ال/لل), not room for a longer one (decision ≁ precision).
      const at = indexOfRun(l, stem, 1, lead === 1 ? 1 : WORD_FORM_MAX_PREFIX);
      if (at < 0) continue;
      if (l.length - at - stem.length <= WORD_FORM_MAX_GAP) return true;
    }
  }
  return false;
}

/**
 * Does `tokens` contain a form of `word`? Exact lookup first (O(1)); the
 * word-form scan only runs when the exact lookup misses.
 */
export function hasWordForm(tokens: ReadonlySet<string>, word: string): boolean {
  if (tokens.has(word)) return true;
  if (letterCount(word) < ABJAD_WORD_FORM_MIN_LEN) return false;
  for (const t of tokens) {
    if (sameWordForm(word, t)) return true;
  }
  return false;
}
