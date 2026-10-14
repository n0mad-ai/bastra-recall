/** Conservative word forms using closed affix families; exact lookup first. */

const ASCII_RE = /^[\x00-\x7f]*$/;
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;

/**
 * How many letters (and digits) `token` has, marks not counted: canonical
 * decomposition first, so a precomposed "é" is one letter, a Devanagari vowel
 * sign or virama is none ("में" = 1, "स्क्रिप्ट" = 5) and a Hangul syllable
 * counts its jamo ("배포" = 4 — a Korean syllable carries what two or three
 * Latin letters do). Code points overcount Indic words and undercount Korean
 * ones; this preserves the minimum-length contract across these scripts.
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
const ABJAD_WORD_FORM_MIN_LEN = 3;

// Closed, deliberately conservative families, not language detection. Never
// mix endings between families (e.g. German -er and English -ed would turn
// folder/folded into a match). Unknown forms stay exact; expanded triggers
// remain available for them. These lists are not a morphological dictionary:
// homonyms and words sharing an attested stem/ending can still collide.
const LATIN_RE = /^[\p{Script=Latin}\p{M}]+$/u;
const CYRILLIC_RE = /^[\p{Script=Cyrillic}\p{M}]+$/u;
const JAPANESE_RE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{M}]+$/u;
const HANGUL_RE = /^\p{Script=Hangul}+$/u;
const ARABIC_RE = /^[\p{Script=Arabic}\p{M}]+$/u;
const HEBREW_RE = /^[\p{Script=Hebrew}\p{M}]+$/u;
const endings = (values: string): ReadonlySet<string> => new Set(["", ...values.split(" ")]);
const GERMAN = endings("e en er ern em es s n");
const FINNISH = endings("n t ssa ssä sta stä lla llä lta ltä lle na nä ksi tta ttä in issa");
const TURKISH = endings("u ü i ı a e da de ta te dan den tan ten lar ler ları leri lari larında larinda lerinde");
const RUSSIAN = endings("а я у ю е и ы о ов ев ей ом ем ой ам ям ах ях ами ями ия ию ии ий ь ть ить л ла ли ет ют ешь");
const JAPANESE = endings("る た て ます ました ない");
const KOREAN = endings("은 는 이 가 을 를 에 에서 의 도 들 들을 들이 들은 들의");
const HEBREW = endings("ים ות ת");
const BARE = new Set([""]);
// English needs transitions rather than a shared suffix set: -er/-ed, for
// example, can be different lexemes. Silent e is replaced, not arbitrary d.
const ENGLISH_PAIRS = new Set(["|s", "|es", "|ed", "|ing", "e|ed", "e|ing", "ies|y"]);

function suffixMatch(a: string, b: string, suffixes: ReadonlySet<string>, minStem: number): boolean {
  let common = 0;
  while (common < Math.min(a.length, b.length) && a[common] === b[common]) common++;
  for (let at = common; at >= minStem; at--) {
    if (suffixes.has(a.slice(at)) && suffixes.has(b.slice(at))) return true;
  }
  return false;
}

function englishMatch(a: string, b: string): boolean {
  let common = 0;
  while (common < Math.min(a.length, b.length) && a[common] === b[common]) common++;
  for (let at = common; at >= 4; at--) {
    const tails = [a.slice(at), b.slice(at)].sort();
    if (ENGLISH_PAIRS.has(tails.join("|"))) return true;
  }
  return false;
}

function prefixedMatch(a: string, b: string, prefixes: readonly string[], suffixes: ReadonlySet<string>): boolean {
  for (const pa of prefixes) {
    if (!a.startsWith(pa)) continue;
    for (const pb of prefixes) {
      if (!b.startsWith(pb)) continue;
      if (suffixMatch(a.slice(pa.length), b.slice(pb.length), suffixes, 3)) return true;
    }
  }
  return false;
}

/**
 * Conservative word-form fallback for lowercased, letters-only tokens.
 * Each script/family admits only known suffixes on a shared stem, or fixed
 * articles/class prefixes. No arbitrary end or first-letter substitutions.
 * NFC keeps combining marks on their letter and Hangul syllables intact;
 * letterCount still supplies the contributor's script-sensitive threshold.
 * Callers keep their existing tokenization (ICU for Japanese; Korean words
 * retain their particles). Unknown scripts/forms use exact equality only.
 */
export function sameWordForm(a: string, b: string): boolean {
  if (a === b) return true;
  if (!LETTERS_ONLY_RE.test(a) || !LETTERS_ONLY_RE.test(b)) return false;
  a = a.normalize("NFC");
  b = b.normalize("NFC");
  if (a === b) return true;
  if (ARABIC_RE.test(a) && ARABIC_RE.test(b)) {
    return prefixedMatch(a, b, ["", "ال", "بال", "لل", "وال"], BARE);
  }
  if (HEBREW_RE.test(a) && HEBREW_RE.test(b)) {
    return prefixedMatch(a, b, ["", "ה", "וה", "ב", "בה", "ל", "לה"], HEBREW);
  }
  if (Math.min(letterCount(a), letterCount(b)) < WORD_FORM_MIN_LEN) return false;
  if (LATIN_RE.test(a) && LATIN_RE.test(b)) {
    if (englishMatch(a, b) || [GERMAN, FINNISH, TURKISH].some((s) => suffixMatch(a, b, s, 4))) return true;
    // Swahili ki-/vi- noun classes; never arbitrary swapped first letters.
    return ((a.startsWith("ki") && b.startsWith("vi")) || (a.startsWith("vi") && b.startsWith("ki"))) &&
      a.slice(2).length >= 4 && a.slice(2) === b.slice(2);
  }
  if (CYRILLIC_RE.test(a) && CYRILLIC_RE.test(b)) return suffixMatch(a, b, RUSSIAN, 3);
  if (JAPANESE_RE.test(a) && JAPANESE_RE.test(b)) return suffixMatch(a, b, JAPANESE, 4);
  if (HANGUL_RE.test(a) && HANGUL_RE.test(b)) return suffixMatch(a, b, KOREAN, 2);
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
