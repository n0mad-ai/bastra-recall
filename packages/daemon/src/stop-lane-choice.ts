/**
 * Language-neutral decision signals for the stop lane (#707, #701) — the
 * decision counterpart of stop-lane-repeat.ts (#678).
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
 *
 * #701: the same choice made through Claude Code's `AskUserQuestion` tool
 * never reaches a user turn at all — see {@link askAnswers}.
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
  /** Tool names the turn called (Claude `tool_use.name`). */
  tools?: string[];
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

const ASK_TOOL = "AskUserQuestion";
/** `"question"="answer"` — how Claude Code writes an AskUserQuestion result. */
const ASK_ANSWER_RE = /"[^"\n]+"="[^"\n]+"/g;

/**
 * #701: the answers the user gave through Claude Code's `AskUserQuestion`
 * tool, as `"question"="answer"` pairs. They come back as a tool result
 * (`User has answered your questions: "…"="…". …`), and the prose heuristics
 * skip tool results on purpose — a decision made by picking an option never
 * reached them. Structural like the option pick above: the assistant turn
 * called the tool, and the tool result right after it carries the pair. A
 * declined question has no pair and does not count.
 *
 * Looks at the span of the last `window` user turns, like the cue check.
 */
export function askAnswers(turns: ChoiceTurn[], window: number): string[] {
  const userIdx: number[] = [];
  turns.forEach((t, i) => {
    if (t.role === "user") userIdx.push(i);
  });
  const from = userIdx.length > window ? userIdx[userIdx.length - window] : 0;
  const answers: string[] = [];
  for (let i = from; i < turns.length; i++) {
    if (turns[i].role !== "assistant" || !turns[i].tools?.includes(ASK_TOOL)) continue;
    for (let j = i + 1; j < turns.length && turns[j].role === "tool"; j++) {
      answers.push(...(turns[j].content.match(ASK_ANSWER_RE) ?? []));
    }
  }
  return answers;
}
