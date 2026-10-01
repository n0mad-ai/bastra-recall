/**
 * Stop lane — the save heuristics (split out of stop-lane.ts, #680):
 * frustration density, repeated correction, feature completion, architecture
 * decision and option pick over the normalised transcript, plus the
 * formatting of one suggestion.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { frustrationCues, decisionCues } from "./lexicon.js";
import { restatementIndices } from "./stop-lane-repeat.js";
import { askAnswers, optionPicks } from "./stop-lane-choice.js";
import type { DocsMode } from "./settings.js";
import type { TranscriptTurn } from "./stop-transcript.js";

const FRUSTRATION_WINDOW_TURNS = 10;
const FRUSTRATION_CUE_THRESHOLD = 4;
const FRUSTRATION_FRUSTWORD_MIN = 2;
const REPEAT_TURNS_MIN = 2;
const DECISION_WINDOW_TURNS = 5;
const FEATURE_FILE_TOKEN_MIN = 5;

type Heuristic = "frustration-density" | "feature-completion" | "architecture-decision";

export interface SaveSuggestion {
  heuristic: Heuristic;
  title: string;
  type: "lesson" | "project-fact" | "decision";
  body: string;
}

interface HeuristicDeps {
  cwd?: string;
  fileExists?: (absPath: string) => boolean;
}

export function evaluateHeuristics(turns: TranscriptTurn[], deps: HeuristicDeps = {}): SaveSuggestion[] {
  const suggestions: SaveSuggestion[] = [];
  const fr = detectFrustration(turns);
  if (fr) suggestions.push(fr);
  const fc = detectFeatureCompletion(turns, deps);
  if (fc) suggestions.push(fc);
  const ad = detectArchitectureDecision(turns);
  if (ad) suggestions.push(ad);
  return suggestions;
}

// Explicit frustration words, per language (#476) — the list is DATA now, in
// lexicon.ts (shipped defaults + a user-editable file), not a `const` here.
// The regex is rebuilt per detection so an edit to the lexicon file takes
// effect on the next session without a restart; the list is tiny.
//
// `\b` is unusable here: JS word boundaries are defined over [A-Za-z0-9_], so
// `\bснова\b` never matches and `\bÄRGER\b` matches in the wrong places. The
// Unicode letter lookarounds below are the same idea, correct for every script.
function frustWordRe(): RegExp {
  return new RegExp(`(?<!\\p{L})(?:${frustrationCues().join("|")})(?!\\p{L})`, "giu");
}
// Letter runs in any script (Latin incl. Umlauts, Cyrillic, …) and all-caps
// tokens by Unicode case, not by Latin alphabet.
const WORD_TOKEN_RE = /\p{L}+/gu;
const ALL_CAPS_RE = /^\p{Lu}{4,}$/u;

// Technical all-caps acronyms that routinely appear in tool output, file paths
// and doc discussions — never a frustration signal on their own.
const CAPS_STOPLIST = new Set([
  "SKILL", "JSON", "CLAUDE", "BASTRA", "NEXUS", "API", "REST", "URL", "HTML",
  "CSS", "HTTP", "HTTPS", "YAML", "XML", "SQL", "PRS", "TUI", "TSX", "JSX",
  "SVG", "PNG", "PDF", "JPG", "TODO", "FIXME", "README", "LICENSE", "CHANGELOG",
]);

// A word that is an identifier or a path (`BASTRA_VAULT_PATH`, `src/README.md`),
// not prose: its capitals are a name's, never emphasis.
const IDENTIFIER_WORD_RE = /\S*[\p{L}\p{N}](?:[_/\\]|\.(?=[\p{L}\p{N}]))[\p{L}\p{N}]\S*/gu;
// `!`/`！` as emphasis: not the `!` of `!=`, `!==`, `!cmd` or `!important`.
const EMPHASIS_BANG_RE = /!(?![=~\p{L}\p{N}_/.-])|！/u;

function countFrustWords(content: string, re: RegExp): number {
  const m = content.match(re);
  return m ? m.length : 0;
}

/**
 * Count qualifying CAPS cues in one turn. A CAPS token only counts when it is
 * not a technical acronym AND it is either >=5 chars or repeated within the
 * turn. A single short token like "SKILL" or "JSON" never qualifies.
 */
function countQualifyingCaps(content: string): number {
  const words = content.replace(IDENTIFIER_WORD_RE, " ").match(WORD_TOKEN_RE);
  if (!words) return 0;
  const counts = new Map<string, number>();
  for (const w of words) {
    if (!ALL_CAPS_RE.test(w)) continue;
    if (CAPS_STOPLIST.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  let qualifying = 0;
  for (const [w, n] of counts) {
    if (w.length >= 5 || n >= 2) qualifying += 1;
  }
  return qualifying;
}

export function detectFrustration(turns: TranscriptTurn[]): SaveSuggestion | null {
  const userTurns = turns.filter((t) => t.role === "user").slice(-FRUSTRATION_WINDOW_TURNS);
  const re = frustWordRe();
  let frustWordCount = 0;
  let capsCueCount = 0;
  const exemplars: string[] = [];
  for (const t of userTurns) {
    const fw = countFrustWords(t.content, re);
    if (fw > 0) {
      frustWordCount += fw;
      // #756: a sentence the user said twice is one exemplar, not two.
      const ex = t.content.slice(0, 120);
      if (exemplars.length < 3 && !exemplars.includes(ex)) exemplars.push(ex);
    }
    capsCueCount += countQualifyingCaps(t.content);
  }
  const totalCues = frustWordCount + capsCueCount;
  // CAPS alone must never trigger: require both enough total cues AND a
  // minimum of genuine frustration words.
  if (totalCues < FRUSTRATION_CUE_THRESHOLD || frustWordCount < FRUSTRATION_FRUSTWORD_MIN) {
    return detectRepeatedCorrection(userTurns);
  }
  return {
    heuristic: "frustration-density",
    title: "recurring frustration — capture the underlying lesson",
    type: "lesson",
    body: `Detected ${totalCues} frustration cues (${frustWordCount} explicit frustration words) ` +
      `in the last ${userTurns.length} user turns. ` +
      `Exemplars: ${exemplars.join(" | ")}. ` +
      `If a concrete recurring pattern surfaced, save a 'lesson' memory that captures the failure path and the fix.`,
  };
}

/** #678 language-neutral fallback: >=2 user turns restate an earlier one
 *  (stop-lane-repeat.ts) and at least one restatement carries emphasis —
 *  `!`/`！` or a qualifying CAPS token. No word list, so any language fires. */
function detectRepeatedCorrection(userTurns: TranscriptTurn[]): SaveSuggestion | null {
  const repeats = restatementIndices(userTurns.map((t) => t.content)).map((i) => userTurns[i].content);
  if (repeats.length < REPEAT_TURNS_MIN) return null;
  if (!repeats.some((c) => EMPHASIS_BANG_RE.test(c) || countQualifyingCaps(c) > 0)) return null;
  return {
    heuristic: "frustration-density",
    title: "recurring frustration — capture the underlying lesson",
    type: "lesson",
    body: `Detected ${repeats.length} user turns restating an earlier request (language-neutral signal) ` +
      `in the last ${userTurns.length} user turns. ` +
      `Exemplars: ${[...new Set(repeats.map((c) => c.slice(0, 120)))].slice(0, 3).join(" | ")}. ` +
      `If the user had to repeat a correction, save a 'lesson' memory that captures the failure path and the fix.`,
  };
}

// Source extensions that signal a real edit. `.md` only counts under docs/.
// json/yaml/css/html are deliberately excluded — they produced the bulk of the
// false-positive noise (settings.json, .claude.json, …).
const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "swift", "rs", "py", "go",
]);

const FILE_TOKEN_RE = /[\w./-]+\.[A-Za-z][A-Za-z0-9]*/g;

/**
 * A file token only counts when it looks like a repo-relative source path:
 * has a directory component, a source extension, and is neither absolute nor a
 * user-home / dotfile path (which is where URL-citation noise lives).
 */
function isRepoRelativeSourceToken(token: string): boolean {
  if (!token.includes("/")) return false;            // bare filename → reject
  if (token.startsWith("/") || token.startsWith("~")) return false; // absolute / home
  if (token.startsWith(".")) return false;           // ./x or .hidden
  if (/^Users\//.test(token)) return false;          // home path with stripped leading slash
  if (token.includes("/.")) return false;            // any dotfile/dotdir segment (e.g. /.claude/)
  const ext = token.slice(token.lastIndexOf(".") + 1).toLowerCase();
  if (SOURCE_EXTENSIONS.has(ext)) return true;
  if (ext === "md" && /(^|\/)docs\//.test(token)) return true;
  return false;
}

// Git's own success line: "[main abc1234] subject", "[feat/x (root-commit) 0f1e2d3] …".
const COMMIT_OUTPUT_RE = /^\[[^\]\n]+? (?:\(root-commit\) )?[0-9a-f]{7,40}\] /m;
const GIT_COMMIT_RE = /\bgit\s+commit\b/i;

/** The commit signal, whoever typed it: the user says so, the agent RAN it
 *  (a command, never prose — assistant text talking about a commit does not
 *  count), or git reported one in a tool turn. */
function commitSignal(turns: TranscriptTurn[]): boolean {
  for (const t of turns) {
    if (t.role === "user" && GIT_COMMIT_RE.test(t.content)) return true;
    if (t.commands?.some((c) => GIT_COMMIT_RE.test(c))) return true;
    if (t.role === "tool" && COMMIT_OUTPUT_RE.test(t.content)) return true;
  }
  return false;
}

export function detectFeatureCompletion(turns: TranscriptTurn[], deps: HeuristicDeps = {}): SaveSuggestion | null {
  if (!commitSignal(turns)) return null;

  // File tokens may appear anywhere (the assistant's edits carry the real
  // paths) but are filtered down to repo-relative source files.
  const text = turns.map((t) => t.content).join("\n");
  const fileTokens = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = FILE_TOKEN_RE.exec(text)) !== null) {
    if (isRepoRelativeSourceToken(m[0])) fileTokens.add(m[0]);
    if (fileTokens.size > 200) break;
  }
  if (fileTokens.size < FEATURE_FILE_TOKEN_MIN) return null;

  // cwd-check: at least one token must resolve to a file that exists in the
  // active repo — rules out tokens scraped from docs/URLs of other projects.
  const cwd = deps.cwd ?? process.cwd();
  const exists = deps.fileExists ?? existsSync;
  const inRepo = [...fileTokens].some((tok) => {
    try {
      return exists(resolve(cwd, tok));
    } catch {
      return false;
    }
  });
  if (!inRepo) return null;

  const sample = [...fileTokens].slice(0, 6).join(", ");
  return {
    heuristic: "feature-completion",
    title: "feature-completion — save a topology / project-fact entry",
    type: "project-fact",
    body: `A git commit was mentioned alongside ${fileTokens.size} distinct repo-relative source files (e.g. ${sample}). ` +
      `If this lands a coherent feature/refactor, save a 'project-fact' that maps what was built where ` +
      `(file paths in path/to/file.ts:42 format, status, links to related decisions).`,
  };
}

// Decision cues (#476) are DATA in lexicon.ts (defaults + a user file), not a
// `const` here — same story as frustration. Patterns rebuilt per detection.
function decisionPatterns(): RegExp[] {
  return decisionCues().map((w) => new RegExp(`(?<!\\p{L})(?:${w})(?!\\p{L})`, "iu"));
}

export function detectArchitectureDecision(turns: TranscriptTurn[]): SaveSuggestion | null {
  const userTurns = turns.filter((t) => t.role === "user").slice(-DECISION_WINDOW_TURNS);
  const patterns = decisionPatterns();
  const exemplars: string[] = [];
  for (const t of userTurns) {
    for (const p of patterns) {
      if (p.test(t.content)) {
        if (exemplars.length < 2) exemplars.push(t.content.slice(0, 160));
        break;
      }
    }
  }
  if (exemplars.length === 0) return detectOptionPick(turns) ?? detectAskAnswer(turns);
  return {
    heuristic: "architecture-decision",
    title: "decision finalized — save the chosen path and the why",
    type: "decision",
    body: `Decision-language in the last ${userTurns.length} user turns: ${exemplars.join(" | ")}. ` +
      `If an architectural choice was committed (X over Y, the trade-off), save a 'decision' memory ` +
      `with the why + how-to-apply.`,
  };
}

/** #707 language-neutral fallback: the user picked one of the numbered
 *  options the agent offered with a question (stop-lane-choice.ts). No word
 *  list, so any language fires. */
function detectOptionPick(turns: TranscriptTurn[]): SaveSuggestion | null {
  const picks = optionPicks(turns, DECISION_WINDOW_TURNS);
  if (picks.length === 0) return null;
  return {
    heuristic: "architecture-decision",
    title: "decision finalized — save the chosen path and the why",
    type: "decision",
    body: `The user picked one of the offered options (language-neutral signal): ${picks.slice(0, 2).map((c) => c.slice(0, 160)).join(" | ")}. ` +
      `If an architectural choice was committed (X over Y, the trade-off), save a 'decision' memory ` +
      `with the why + how-to-apply.`,
  };
}

/** #701 structural signal: the user answered the agent's `AskUserQuestion`
 *  (stop-lane-choice.ts). The answer is a tool result, which the cue check
 *  above never reads. */
function detectAskAnswer(turns: TranscriptTurn[]): SaveSuggestion | null {
  const answers = askAnswers(turns, DECISION_WINDOW_TURNS);
  if (answers.length === 0) return null;
  return {
    heuristic: "architecture-decision",
    title: "decision finalized — save the chosen path and the why",
    type: "decision",
    body: `The user answered the agent's question (structural signal): ${[...new Set(answers)].slice(0, 2).map((c) => c.slice(0, 160)).join(" | ")}. ` +
      `If an architectural choice was committed (X over Y, the trade-off), save a 'decision' memory ` +
      `with the why + how-to-apply.`,
  };
}

/**
 * Hängt bei eingeschalteter Produkt-Doku (docs.mode != "off") den Doku-
 * Pflege-Hinweis an die feature-completion-Suggestion. Mutiert in place;
 * pure bzgl. I/O — der Settings-Read passiert beim Caller.
 */
export function appendProductDocHint(suggestions: SaveSuggestion[], mode: DocsMode): void {
  if (mode === "off") return;
  const fc = suggestions.find((s) => s.heuristic === "feature-completion");
  if (!fc) return;
  fc.body +=
    ` Product docs are enabled (docs.mode=${mode}): if this completed a USER-FACING feature area, ` +
    `also create/update its product doc via save_product_doc (one doc per area, send the complete ` +
    `updated markdown${mode === "suggest" ? "; propose to the user first" : ""}).`;
}

export function formatSuggestion(s: SaveSuggestion): string {
  return [
    `<save-eval>`,
    `Suggested save (heuristic: ${s.heuristic}):`,
    `  title: "${s.title}"`,
    `  type: ${s.type}`,
    `  body: "${escapeBody(s.body)}"`,
    `To save: call save_memory with the values above (or refine first).`,
    `</save-eval>`,
  ].join("\n");
}

function escapeBody(body: string): string {
  return body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
