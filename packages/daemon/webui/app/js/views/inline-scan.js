/**
 * The reader's inline elements of one line, found in linear time: [[wiki links]], `code`, **bold**,
 * [links](https://…), bare web addresses and *emphasis*. Same result as running the renderer's former
 * expression
 *
 *   /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:[^)\s]+)\)|
 *    (https?:\/\/[^\s<)]*[^\s<)?!.,:;*_~])|(^|[^*\w])\*([^*\s][^*]*)\*\/g
 *
 * over the line (same elements, same groups), but an opener without its closer no longer makes every
 * later start position search to the end of the line again: "where is the next `]`, `*`, …" is
 * answered from tables built once per line. The daemon's question status (task-report-status.ts)
 * imports this module, so the reader and the status read lines alike (#1656); types for it in
 * inline-scan.d.ts.
 */

/** @typedef {{ index: number, end: number, groups: (string | undefined)[] }} InlineMatch
 *  index: where the element starts, as the expression's match index (emphasis: with its leading
 *  character); end: where it ends; groups: [0] the whole match, [1]–[9] the expression's groups,
 *  undefined when not taking part. */

const SPACE = /\s/;
const WORD = /\w/;
/** What a bare address does not end with (#1671, GFM's extended autolinks plus ";"); it stays text. */
const TRAILING = /[?!.,:;*_~]/;

/** For every position p, the first position ≥ p whose character is a stop (text.length when none). */
function nextStop(text, stop) {
  const next = new Int32Array(text.length + 1);
  next[text.length] = text.length;
  for (let p = text.length - 1; p >= 0; p--) next[p] = stop(text[p]) ? p : next[p + 1];
  return next;
}

/** For every end e, the end without the trailing characters before it: e, or less when text[e - 1] is one. */
function withoutTrailing(text) {
  const end = new Int32Array(text.length + 1);
  for (let e = 1; e <= text.length; e++) end[e] = TRAILING.test(text[e - 1]) ? end[e - 1] : e;
  return end;
}

function match(line, index, end, at) {
  const groups = Array.from({ length: 10 }, (_, g) => at[g]);
  groups[0] = line.text.slice(index, end);
  return { index, end, groups };
}

/** After "http:" or "https:" at `p` (with `slashes`: "http://" …), the position behind it, else -1. */
function afterScheme(text, p, slashes) {
  if (!text.startsWith("http", p)) return -1;
  let q = p + 4;
  if (text[q] === "s") q++;
  if (text[q] !== ":") return -1;
  if (!slashes) return q + 1;
  return text.startsWith("//", q + 1) ? q + 3 : -1;
}

/** [[id]] or [[id|label]] */
function wikiAt(line, i) {
  const { text } = line;
  if (text[i + 1] !== "[") return null;
  const j = line.closeOrBar[i + 2];
  if (j === i + 2 || j === text.length) return null;
  if (text[j] === "]") return text[j + 1] === "]" ? match(line, i, j + 2, { 1: text.slice(i + 2, j) }) : null;
  const k = line.close[j + 1];
  if (k === j + 1 || text[k + 1] !== "]") return null;
  return match(line, i, k + 2, { 1: text.slice(i + 2, j), 2: text.slice(j + 1, k) });
}

/** [label](http…) */
function linkAt(line, i) {
  const { text } = line;
  const k = line.close[i + 1];
  if (k === i + 1 || k === text.length || text[k + 1] !== "(") return null;
  const p = afterScheme(text, k + 2, false);
  if (p < 0) return null;
  const e = line.urlEnd[p];
  if (e === p || text[e] !== ")") return null;
  return match(line, i, e + 1, { 5: text.slice(i + 1, k), 6: text.slice(k + 2, e) });
}

/** `code` */
function codeAt(line, i) {
  const k = line.tick[i + 1];
  if (k === i + 1 || k === line.text.length) return null;
  return match(line, i, k + 1, { 3: line.text.slice(i + 1, k) });
}

/** **bold** */
function boldAt(line, i) {
  const { text } = line;
  if (text[i + 1] !== "*") return null;
  const k = line.star[i + 2];
  if (k === i + 2 || text[k + 1] !== "*") return null;
  return match(line, i, k + 2, { 4: text.slice(i + 2, k) });
}

/** a bare http:// or https:// address, without trailing punctuation */
function bareAt(line, i) {
  const p = afterScheme(line.text, i, true);
  if (p < 0) return null;
  const e = line.bareTrim[line.bareEnd[p]];
  return e <= p ? null : match(line, i, e, { 7: line.text.slice(i, e) });
}

/** *emphasis*, at the line start or after a character that is neither * nor a word character */
function emphasisAt(line, i) {
  const { text } = line;
  const atStart = i === 0 && text[0] === "*";
  if (!atStart && (i >= text.length || text[i] === "*" || WORD.test(text[i]))) return null;
  const star = atStart ? i : i + 1;
  const first = text[star + 1];
  if (text[star] !== "*" || first === undefined || first === "*" || SPACE.test(first)) return null;
  const k = line.star[star + 2];
  if (k === text.length) return null;
  return match(line, i, k + 1, { 8: atStart ? "" : text[i], 9: text.slice(star + 1, k) });
}

/** The element starting at `i`, trying the forms in the expression's order. */
function elementAt(line, i) {
  const c = line.text[i];
  return (
    (c === "[" ? (wikiAt(line, i) ?? linkAt(line, i)) : null) ??
    (c === "`" ? codeAt(line, i) : null) ??
    (c === "*" ? boldAt(line, i) : null) ??
    (c === "h" ? bareAt(line, i) : null) ??
    emphasisAt(line, i)
  );
}

/** The inline elements of `text`, left to right and without overlap. */
/** @returns {InlineMatch[]} */
export function inlineMatches(text) {
  const line = {
    text,
    close: nextStop(text, (c) => c === "]"),
    closeOrBar: nextStop(text, (c) => c === "]" || c === "|"),
    tick: nextStop(text, (c) => c === "`"),
    star: nextStop(text, (c) => c === "*"),
    urlEnd: nextStop(text, (c) => c === ")" || SPACE.test(c)),
    bareEnd: nextStop(text, (c) => c === ")" || c === "<" || SPACE.test(c)),
    bareTrim: withoutTrailing(text),
  };
  const out = [];
  for (let i = 0; i < text.length;) {
    const m = elementAt(line, i);
    if (m) out.push(m);
    i = m ? m.end : i + 1;
  }
  return out;
}
