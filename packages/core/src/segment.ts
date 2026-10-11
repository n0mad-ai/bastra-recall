/**
 * Word segmentation for scripts written without spaces (#711).
 *
 * Chinese, Japanese, Thai, Lao, Khmer, Myanmar and the other scripts of
 * Unicode line-break classes ID and SA (plus Tibetan, whose tsheg separates
 * syllables) put no space between words, so a whole sentence reached the BM25
 * index as one token and only a near-verbatim query found it. A run that holds
 * a character of such a script is split by ICU word segmentation
 * (`Intl.Segmenter`, full ICU ships with Node); every other run is returned
 * unchanged, so identifier handling stays exactly as it was. A property of the
 * script, not a list of languages, and no language detection.
 */
/**
 * Scripts whose words are not separated by spaces: Unicode line-break class ID
 * (ideographs, kana, Bopomofo, Yi, Tangut, Nüshu, Khitan) and SA (the South East
 * Asian scripts ICU breaks by dictionary or syllable), plus Tibetan, whose
 * tsheg separates syllables, not words. A property of the script, not a list
 * of languages: every language written in one of them gets the same rule.
 */
const SPACELESS_SCRIPT_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\p{Script=Yi}\p{Script=Tangut}\p{Script=Nushu}\p{Script=Khitan_Small_Script}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tai_Tham}\p{Script=Tai_Viet}\p{Script=New_Tai_Lue}\p{Script=Tai_Le}\p{Script=Ahom}\p{Script=Tibetan}]/u;


let segmenter: Intl.Segmenter | null | undefined;

function wordSegmenter(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    try {
      segmenter = new Intl.Segmenter("und", { granularity: "word" });
    } catch {
      // small-icu builds: no segmentation, runs stay whole (the old behaviour)
      segmenter = null;
    }
  }
  return segmenter;
}

/** True when `token` contains a character of a script written without spaces. */
export function hasSpacelessScript(token: string): boolean {
  return SPACELESS_SCRIPT_RE.test(token);
}

/**
 * Split one raw token into words. A token without a spaceless-script
 * character is returned as-is (`["my-app.config.ts"]`); a token with one is
 * split into ICU word segments, punctuation dropped.
 */
export function segmentWords(token: string): string[] {
  if (!hasSpacelessScript(token)) return [token];
  const seg = wordSegmenter();
  if (!seg) return [token];
  const out: string[] = [];
  for (const s of seg.segment(token)) {
    if (s.isWordLike) out.push(s.segment);
  }
  return out.length > 0 ? out : [token];
}
