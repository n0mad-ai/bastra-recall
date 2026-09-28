/**
 * Language-neutral decision signal for the stop lane (#707) — the decision
 * counterpart of stop-lane-repeat.ts (#678).
 *
 * The decision cue lists in lexicon.ts know German, English and Russian; a
 * decision typed in any other language never fired. This signal needs no word
 * list: the agent laid out numbered options and asked, and the user's next
 * turn picks one of them by its number ("2", "вариант 2", "2 lütfen", "το 2").
 *
 * Deliberately narrow. The assistant turn needs at least two numbered lines
 * AND a question mark (a numbered list of steps is not a choice); the user
 * turn must be short and name exactly one number, and that number must be one
 * of the offered options.
 */

/** A numbered list line: "1. …", "2) …", "**3.** …", "- 4. …". */
const OPTION_LINE_RE = /^[ \t]*(?:[-*][ \t]+)?\**(\d{1,2})[.)]\**[ \t]+\S/gm;
/** Question marks across scripts: Latin/fullwidth/Arabic/Greek. */
const QUESTION_RE = /[?？؟\u037E]/u;
/** A standalone number — not part of a Latin identifier ("v2", "2nd"), a
 *  version or a longer number. Other scripts may touch it: CJK writes "2で",
 *  "案2" without a space. */
const STANDALONE_NUMBER_RE = /(?<![\p{N}\p{Script=Latin}.])\d{1,2}(?![\p{N}\p{Script=Latin}]|\.\d)/gu;
/** A pick is a short answer, not a new request that happens to contain a digit. */
const PICK_MAX_CHARS = 60;
const MIN_OPTIONS = 2;

export interface ChoiceTurn {
  role: string;
  content: string;
}

function offeredOptions(assistantText: string): Set<string> {
  if (!QUESTION_RE.test(assistantText)) return new Set();
  const options = new Set<string>();
  for (const m of assistantText.matchAll(OPTION_LINE_RE)) options.add(String(Number(m[1])));
  return options.size >= MIN_OPTIONS ? options : new Set();
}

function pickedOption(userText: string, options: Set<string>): boolean {
  const text = userText.trim();
  if (text.length === 0 || text.length > PICK_MAX_CHARS) return false;
  const numbers = new Set((text.match(STANDALONE_NUMBER_RE) ?? []).map((n) => String(Number(n))));
  if (numbers.size !== 1) return false;
  return options.has([...numbers][0]);
}

/**
 * The user turns (content) among the last `window` user turns that pick one
 * of the numbered options the preceding assistant turn offered. Tool and
 * injected turns between the two are skipped.
 */
export function optionPicks(turns: ChoiceTurn[], window: number): string[] {
  const userIdx: number[] = [];
  turns.forEach((t, i) => {
    if (t.role === "user") userIdx.push(i);
  });
  const picks: string[] = [];
  for (const i of userIdx.slice(-window)) {
    let j = i - 1;
    while (j >= 0 && turns[j].role !== "assistant" && turns[j].role !== "user") j--;
    if (j < 0 || turns[j].role !== "assistant") continue;
    const options = offeredOptions(turns[j].content);
    if (options.size > 0 && pickedOption(turns[i].content, options)) picks.push(turns[i].content);
  }
  return picks;
}
