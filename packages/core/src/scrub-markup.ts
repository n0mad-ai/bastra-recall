/**
 * Render-side defusing of vault text that is embedded in an injected hint
 * block (#1467). Two cheap ways around the reference-only frame are closed
 * here, both structurally, without any word or tag-name list:
 *
 * - Invisible characters: format controls (zero-width, bidi overrides and
 *   isolates, Unicode tag characters), C0/C1 controls and line/paragraph
 *   separators. They hide or reorder text the reader model still sees.
 * - Markup imitation: anything shaped like an XML/HTML tag or a chat-template
 *   token keeps its text but loses its angle brackets, so a memory cannot pose
 *   as host markup (`<system>`, `</function_results>`, `<|im_start|>` …).
 *
 * Leaf module: imported by scrub.ts only.
 */

/** Joiners carry meaning between letters (Indic, Persian) and inside emoji
 * sequences; anywhere else they only hide a seam. */
const JOINER_NEIGHBOUR = /[\p{L}\p{M}\p{Extended_Pictographic}\p{Emoji_Modifier}]/u;
const VARIATION_SELECTOR = /[︀-️\u{E0100}-\u{E01EF}]/u;
const INVISIBLE = /[\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * Drop invisible characters. Kept: tab, line feed, carriage return; a joiner
 * (U+200C/U+200D) between two letters, marks or emoji; one variation selector
 * after a base character (a run of them is the "emoji smuggling" carrier).
 * Line and paragraph separators become a space, so the visible text keeps
 * its word boundary without forging a new line.
 */
export function stripInvisible(text: string): string {
  if (!/[\p{Cf}\p{Cc}\p{Zl}\p{Zp}\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u.test(text)) return text;
  const chars = Array.from(text);
  let out = "";
  let previous = "";
  for (let i = 0; i < chars.length; i++) {
    const kept = replacement(chars[i], previous, chars[i + 1] ?? "");
    if (kept === "") continue;
    out += kept;
    previous = chars[i];
  }
  return out;
}

/** What one character becomes: itself, a space, or "" (dropped). */
function replacement(c: string, previous: string, next: string): string {
  if (c === "\t" || c === "\n" || c === "\r") return c;
  if (c === "\u2028" || c === "\u2029") return " ";
  if (c === "\u200c" || c === "\u200d") return JOINER_NEIGHBOUR.test(previous) && JOINER_NEIGHBOUR.test(next) ? c : "";
  if (VARIATION_SELECTOR.test(c)) return previous === "" || VARIATION_SELECTOR.test(previous) ? "" : c;
  return INVISIBLE.test(c) ? "" : c;
}

/**
 * Tag-shaped markup: `<name …>`, `</name>`, `<name/>`, and chat-template
 * tokens `<|…|>`. The name may contain a kept joiner, so a joiner cannot shield
 * a tag from this pattern. Attributes stop at the next angle bracket, which
 * keeps the scan linear on openers that never close.
 */
const TAG_SHAPE = /<(\/?[\p{L}_][\p{L}\p{N}\p{M}\p{Cf}_:.-]*(?:\s[^<>]*)?\/?|\|[^<>|\s]{1,64}\|)>/gu;

/** Replace the angle brackets of tag-shaped markup with ‹ › (U+2039/U+203A):
 * the text stays readable, but no longer parses as markup. A lone `<` or `>`
 * in prose (`a < b`) is no tag shape and stays. */
export function defuseMarkup(text: string): string {
  if (!text.includes("<")) return text;
  return text.replace(TAG_SHAPE, "‹$1›");
}
