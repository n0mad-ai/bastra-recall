/**
 * #679 (part of #676) — guard: no NEW language-bound matcher against user text.
 *
 * Owner rule, 2026-09-25: Recall is multilingual. A matcher against user text
 * must not depend on a fixed language list, and an unknown language takes the
 * neutral path, never "never fires". #476 pinned one list with a test; the
 * same defect came back in other lanes because nothing guarded the principle.
 * This test guards it.
 *
 * It scans `packages/daemon/src` and `packages/core/src` (no `__tests__`) with
 * four deterministic detectors:
 *
 *   name   — a list/regex/Set/object constant named after a language or a cue
 *            list: `*_DE`, `DE_*`, `*_EN`, `*_RU`, `*_CUES*`, `*STOPWORDS`,
 *            `*_ACKS`, `*LANGUAGES`.
 *   keyed  — a word list keyed by language (`de: [`, `en: /`, `ru: [` …),
 *            reported with the constant it sits in.
 *   words  — a case-insensitive regex literal with an alternation of three or
 *            more word-like branches (`/\b(find|search|where …)/i`). JS `\b` is
 *            ASCII-only, so these are also where a Cyrillic cue silently never
 *            matches (#476).
 *   latin  — a character class that spells letters as `a-z` plus German
 *            umlauts (`[^a-zäöüß0-9]`): a tokenizer that drops every other
 *            script (#707: Turkish `şifresi` → `ifresi`).
 *
 * Every finding must be in ALLOWLIST with a reason that carries an issue
 * reference. The list is today's known places (#676, #707) plus the detector's
 * false positives (technical vocabulary, not natural language). It can only
 * shrink honestly: an entry whose finding is gone fails the test until it is
 * removed — so when #707 fixes a place, its line here goes too.
 *
 * Adding to the allowlist is the wrong fix for a new matcher against user
 * text. Make it language-neutral (`\p{L}`, score-gated recall, embeddings), or
 * make it per-language DATA with a neutral fallback (lexicon.ts, #678).
 *
 * Runner: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/language-bound-matchers.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCAN_ROOTS = ["packages/daemon/src", "packages/core/src"];

/** file :: finding → why it may stay (must reference an issue). */
const ALLOWLIST: Readonly<Record<string, string>> = {
  // ── #707: detection only FILES a bridge (bridges/<lang>/, else "und"); mint and fire are language-neutral ──
  "packages/daemon/src/learned-recall/language.ts :: name SUPPORTED_LANGUAGES": "#707 names the filing folder and the override values; an unknown language files under und and still mints/fires",
  "packages/daemon/src/learned-recall/language.ts :: name DE_STOPWORDS": "#707 filing-folder detection only, never a gate",
  "packages/daemon/src/learned-recall/language.ts :: name EN_STOPWORDS": "#707 filing-folder detection only, never a gate",
  "packages/daemon/src/learned-recall/language.ts :: latin [^a-zäöüß]": "#707 filing-folder detection only (a non-Latin query abstains → und)",

  // ── #707: per-language data with a documented neutral path — allowed shape ──
  "packages/core/src/stopwords.ts :: name PHRASE_STOPWORDS": "#707 union of the per-language data below; an unlisted language drops no word (neutral)",
  "packages/core/src/stopwords.ts :: name PHRASE_STOPWORDS_BY_LANGUAGE": "#707 per-language data; neutral path documented and tested (ru/tr/el)",
  "packages/core/src/stopwords.ts :: keyed PHRASE_STOPWORDS_BY_LANGUAGE": "#707 per-language data with a neutral path",
  "packages/daemon/src/prompt-classify.ts :: name TRIVIAL_ACKS": "#707 union of per-language data; an unlisted ack runs one score-gated recall (neutral)",
  "packages/daemon/src/prompt-classify.ts :: keyed TRIVIAL_ACKS_BY_LANGUAGE": "#707 per-language data; structural no-letter/≤2-char rule covers every script",
  "packages/daemon/src/lexicon.ts :: name DEFAULT_DECISION_CUES_BY_LANGUAGE": "#707 per-language data; stop-lane-choice.ts option pick is the neutral fallback",
  "packages/daemon/src/lexicon.ts :: keyed DEFAULT_DECISION_CUES_BY_LANGUAGE": "#707 per-language data with a neutral fallback (option pick)",
  "packages/daemon/src/lexicon.ts :: name DEFAULT_DECISION_CUES": "#707 flattened decision cues, neutral fallback exists",
  "packages/core/src/stopwords.ts :: keyed FUNCTION_WORDS_BY_LANGUAGE": "#707 per-language data for similarity/todo/acted-on; an unlisted language drops no word (neutral, tested with ru)",
  "packages/core/src/stopwords.ts :: keyed ALTERNATIVE_WORDS_BY_LANGUAGE": "#707 per-language data; a free-standing / or | splits alternatives in any script (tested with el)",
  "packages/daemon/src/todo-lane.ts :: keyed TODO_VERBS_BY_LANGUAGE": "#707 per-language data; an unlisted language keeps every content word as a topic (tested with ru)",
  "packages/daemon/src/lexicon.ts :: name DEFAULT_NEGATIVE_CLAIM_CUES_BY_LANGUAGE": "#707 per-language data, user-extensible; an unlisted language gets no advisory penalty",
  "packages/daemon/src/lexicon.ts :: keyed DEFAULT_NEGATIVE_CLAIM_CUES_BY_LANGUAGE": "#707 per-language data with a neutral path (no penalty)",
  "packages/daemon/src/lexicon.ts :: name DEFAULT_FIX_MARKER_CUES_BY_LANGUAGE": "#707 per-language data; a code span/fenced block counts as the fix in any script",
  "packages/daemon/src/lexicon.ts :: keyed DEFAULT_FIX_MARKER_CUES_BY_LANGUAGE": "#707 per-language data with a structural fallback (code span)",
  "packages/daemon/src/lexicon.ts :: name DEFAULT_IMPERATIVE_LEAD_CUES_BY_LANGUAGE": "#707 per-language data, user-extensible; an unlisted language gets no advisory penalty",
  "packages/daemon/src/lexicon.ts :: keyed DEFAULT_IMPERATIVE_LEAD_CUES_BY_LANGUAGE": "#707 per-language data with a neutral path (no penalty)",
  "packages/daemon/src/lexicon.ts :: name DEFAULT_COMPOSE_VERB_CUES_BY_LANGUAGE": "#707 assertion label, per-language data, user-extensible; an unlisted language recalls as an ordinary prompt (tested with el)",
  "packages/daemon/src/lexicon.ts :: keyed DEFAULT_COMPOSE_VERB_CUES_BY_LANGUAGE": "#707 per-language data with a neutral path (score-gated recall)",
  "packages/daemon/src/lexicon.ts :: name DEFAULT_OUTWARD_ARTIFACT_CUES_BY_LANGUAGE": "#707 assertion label, per-language data, user-extensible; an issue reference counts in any script",
  "packages/daemon/src/lexicon.ts :: keyed DEFAULT_OUTWARD_ARTIFACT_CUES_BY_LANGUAGE": "#707 per-language data with a structural half (#123) and a neutral path",
  "packages/daemon/src/lexicon.ts :: name DEFAULT_STATE_QUESTION_CUES_BY_LANGUAGE": "#707 assertion label, per-language data, user-extensible; an unlisted language recalls as an ordinary prompt",
  "packages/daemon/src/lexicon.ts :: keyed DEFAULT_STATE_QUESTION_CUES_BY_LANGUAGE": "#707 per-language data with a neutral path (score-gated recall)",
  "packages/daemon/src/lexicon.ts :: name DEFAULT_PROJECT_STATE_CUES_BY_LANGUAGE": "#707 assertion label, per-language data, user-extensible; an unlisted language recalls as an ordinary prompt",
  "packages/daemon/src/lexicon.ts :: keyed DEFAULT_PROJECT_STATE_CUES_BY_LANGUAGE": "#707 per-language data with a neutral path (score-gated recall)",
  "packages/daemon/src/lexicon.ts :: name DEFAULT_RETRIEVAL_LEAD_CUES_BY_LANGUAGE": "#765 retrieval label (floor 50 instead of 100, k=5, no backoff, delivers unfused), per-language data, user-extensible; an unlisted language recalls as an ordinary prompt (tested with tr)",
  "packages/daemon/src/lexicon.ts :: keyed DEFAULT_RETRIEVAL_LEAD_CUES_BY_LANGUAGE": "#765 per-language data with a neutral path (score-gated recall, #677)",

  // ── #676: per-language data with a neutral fallback (#678) — allowed shape ──
  "packages/daemon/src/lexicon.ts :: name DEFAULT_FRUSTRATION_CUES_BY_LANGUAGE": "#678 per-language data; the stop lane's neutral repeated-correction check covers other languages",
  "packages/daemon/src/lexicon.ts :: keyed DEFAULT_FRUSTRATION_CUES_BY_LANGUAGE": "#678 per-language data with a neutral fallback",
  "packages/daemon/src/lexicon.ts :: name DEFAULT_FRUSTRATION_CUES": "#678 flattened frustration cues, neutral fallback exists",

  // ── #676: impact intent stays with the Experimental milestone ──
  "packages/daemon/src/code-graph/impact-intent.ts :: name IMPACT_DE": "#676 experimental impact intent, decided there",
  "packages/daemon/src/code-graph/impact-intent.ts :: name IMPACT_EN": "#676 experimental impact intent, decided there",
  "packages/daemon/src/code-graph/impact-intent.ts :: words /dateien|files|stellen/": "#676 experimental impact intent",
  "packages/daemon/src/code-graph/impact-intent.ts :: words /anpass|ändern|andern/": "#676 experimental impact intent",
  "packages/daemon/src/code-graph/impact-intent.ts :: words /ruft|benutzt|nutzt/": "#676 experimental impact intent",
  "packages/daemon/src/code-graph/impact-intent.ts :: words /änder|ander|umbenenn/": "#676 experimental impact intent",
  "packages/daemon/src/code-graph/impact-intent.ts :: words /will|would|could/": "#676 experimental impact intent",
  "packages/daemon/src/code-graph/impact-intent.ts :: words /change|rename|remove/": "#676 experimental impact intent",
  "packages/daemon/src/code-graph/impact-intent.ts :: words /change|update|adapt/": "#676 experimental impact intent",
  "packages/daemon/src/code-graph/impact-intent.ts :: words /calls|uses|depends on/": "#676 experimental impact intent",
  "packages/daemon/src/code-graph/impact-intent.ts :: words /chang|renam|remov/": "#676 experimental impact intent",
  "packages/daemon/src/code-graph/impact-intent.ts :: words /stop|no longer|won't/": "#676 experimental impact intent",
  "packages/daemon/src/code-graph/impact-intent.ts :: words /call|caller|usage/": "#676 experimental impact intent",

  // ── #679: detector false positives — not natural language, or not user text ──
  "packages/core/src/recall-banter.ts :: keyed STAGE_PHRASES": "#679 output phrases the product writes, never matched against user text",
  "packages/core/src/recall-banter.ts :: keyed SLOW_PHRASES": "#679 output phrases the product writes, never matched against user text",
  "packages/core/src/recall-banter.ts :: keyed VERY_SLOW_PHRASES": "#679 output phrases the product writes, never matched against user text",
  "packages/core/src/recall-banter.ts :: keyed TOOL_PHRASES": "#679 output phrases the product writes, never matched against user text",
  "packages/core/src/recall-banter.ts :: keyed DEFAULT_TOOL_PHRASES": "#679 output phrases the product writes, never matched against user text",
  "packages/daemon/src/bash-fail-lane.ts :: words /exit(?:ed)?(?:\\s+with)?(?:\\s+(?:non-zero\\s+)?status)?(?:\\s+code)?|status\\s+code|exit_code/": "#679 reads tool output (exit status), not user text",
  "packages/daemon/src/boot-observers.ts :: words /CloudStorage|Dropbox|iCloud/": "#679 sync-folder path names",
  "packages/daemon/src/documents-write-handler.ts :: words /CloudStorage|Dropbox|iCloud/": "#679 sync-folder path names",
  "packages/core/src/vault.ts :: words /CloudStorage|Dropbox|iCloud/": "#679 sync-folder path names",
  "packages/daemon/src/pending-suggestions.ts :: words /eval|test|synthetic/": "#679 fixture/session-id markers",
  "packages/core/src/topics.ts :: words /jwt|bearer|oauth/": "#679 technical topic vocabulary",
  "packages/core/src/topics.ts :: words /\\bbcrypt|argon2|sha-?256/": "#679 technical topic vocabulary",
  "packages/core/src/injection-scan.ts :: keyed IGNORE_PREVIOUS_BY_LANGUAGE": "#707 per-language data for the injection signatures; flag-only, an unlisted language is read by the English signatures and the script-neutral fold",
  "packages/core/src/injection-scan.ts :: words /previous|prior|above/": "#679 prompt-injection signatures (English attack phrasing), not an intent gate",
  "packages/core/src/injection-scan.ts :: words /previous|prior|your/": "#679 prompt-injection signatures",
  "packages/core/src/injection-scan.ts :: words /instructions?|prompts?|rules?/": "#679 prompt-injection signatures",
  "packages/core/src/injection-scan.ts :: words /approved|authorized|instructed/": "#679 prompt-injection signatures",
  "packages/core/src/injection-scan.ts :: words /(?:this|it|them)(?:\\s+\\w+)?|the\\s+\\w+|all\\s+\\w+/": "#679 prompt-injection signatures",
  "packages/core/src/injection-scan.ts :: words /api[\\s_-]?keys?|passwords?|credentials?/": "#679 prompt-injection signatures",
  "packages/core/src/injection-scan.ts :: words /send|post|include/": "#679 prompt-injection signatures",
  "packages/core/src/injection-scan.ts :: words /unrestricted|jailbroken|developer/": "#679 prompt-injection signatures",
  "packages/core/src/injection-scan.ts :: words /tell|inform|alert/": "#679 prompt-injection signatures",
  "packages/core/src/injection-scan.ts :: words /pre-?approved|pre-?authorized|authorized\\s+by/": "#679 prompt-injection signatures",
  "packages/core/src/injection-scan.ts :: words /developer|creator|administrator/": "#679 prompt-injection signatures",
  "packages/core/src/injection-scan.ts :: words /run|execute|send/": "#679 prompt-injection signatures",
  "packages/core/src/injection-scan.ts :: words /send|post|upload/": "#679 prompt-injection signatures",
  "packages/core/src/injection-scan.ts :: words /command|script|code/": "#679 prompt-injection signatures",
  "packages/core/src/injection-scan.ts :: words /curl|wget|fetch/": "#679 prompt-injection signatures",
  "packages/core/src/injection-scan.ts :: words /read|collect|include/": "#679 prompt-injection signatures",
};

// ─── detectors ───────────────────────────────────────────────────────────────

const NAME_DECL = /\b(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*(?::[^=\n]+)?=\s*(?:\/|\[|new Set|\{|Object\.|`|")/g;
const LANGUAGE_NAME = /(?:^|_)(?:DE|EN|RU)(?:_|$)|_CUES(?:_|$)|STOPWORDS|_ACKS$|LANGUAGES$/;
const KEYED = /^\s*(?:de|en|ru)\s*:\s*(?:\[|\/|new Set)/gm;
const ANY_DECL = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
// A regex literal: after an operator/opening token, `return`, or at line start.
const REGEX_LITERAL = /(?<=[(,=:\[!&|?{};]\s*|return\s+|^\s*)\/((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+)\/([dgimsuyv]*)/gm;
const LATIN_CLASS = /\[\^?(?=[^\]\n]*a-z)(?=[^\]\n]*[äöüß])[^\]\n]*\]/g;

/** Top-level alternatives of every group (and of the whole body) in a regex source. */
function alternations(body: string): string[][] {
  const out: string[][] = [];
  const stack: { start: number; cuts: number[] }[] = [{ start: -1, cuts: [] }];
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") { i++; continue; }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") inClass = true;
    else if (c === "(") stack.push({ start: i, cuts: [] });
    else if (c === "|") stack[stack.length - 1].cuts.push(i);
    else if (c === ")" && stack.length > 1) {
      const g = stack.pop()!;
      if (g.cuts.length > 0) out.push(split(body, g.start + 1, i, g.cuts));
    }
  }
  if (stack[0].cuts.length > 0) out.push(split(body, 0, body.length, stack[0].cuts));
  return out;
}

function split(body: string, from: number, to: number, cuts: number[]): string[] {
  const bounds = [from, ...cuts.map((c) => c + 1)];
  const ends = [...cuts, to];
  return bounds.map((b, k) => body.slice(b, ends[k]).replace(/^\?(?::|<[^>]+>|=|!)/, ""));
}

const wordLike = (alt: string) => /^(?:\\b)?\s*\p{L}{3,}/u.test(alt);

function enclosingName(src: string, index: number): string {
  let name = "(top)";
  for (const m of src.slice(0, index).matchAll(ANY_DECL)) name = m[1];
  return name;
}

/** Findings for one file, as `kind detail` strings (deduplicated). */
function findLanguageBound(src: string): string[] {
  const found = new Set<string>();
  for (const m of src.matchAll(NAME_DECL)) if (LANGUAGE_NAME.test(m[1])) found.add(`name ${m[1]}`);
  for (const m of src.matchAll(KEYED)) found.add(`keyed ${enclosingName(src, m.index)}`);
  for (const m of src.matchAll(REGEX_LITERAL)) {
    const [, body, flags] = m;
    if (flags.includes("i")) {
      for (const alts of alternations(body)) {
        const words = alts.filter(wordLike);
        if (words.length >= 3 && words.length >= alts.length * 0.6) found.add(`words /${alts.slice(0, 3).join("|")}/`);
      }
    }
    for (const c of body.matchAll(LATIN_CLASS)) found.add(`latin ${c[0]}`);
  }
  return [...found];
}

function* sourceFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e !== "__tests__" && e !== "node_modules") yield* sourceFiles(p);
    } else if (/\.(?:ts|mts|mjs|js)$/.test(e) && !e.endsWith(".d.ts")) {
      yield p;
    }
  }
}

function scan(): Set<string> {
  const findings = new Set<string>();
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(join(ROOT, root))) {
      const rel = relative(ROOT, file).split("\\").join("/");
      const src = readFileSync(file, "utf8");
      for (const f of findLanguageBound(src)) findings.add(`${rel} :: ${f}`);
    }
  }
  return findings;
}

// ─── tests ───────────────────────────────────────────────────────────────────

test("#679: no new language-bound matcher in daemon/core sources", () => {
  const unlisted = [...scan()].filter((k) => !(k in ALLOWLIST));
  assert.deepEqual(
    unlisted,
    [],
    `New language-bound matcher(s):\n  ${unlisted.join("\n  ")}\n` +
      `Recall is multilingual (#676): make it language-neutral (\\p{L} with the u flag, score-gated recall, ` +
      `embeddings) or per-language data with a neutral fallback (lexicon.ts, #678). Only a detector false ` +
      `positive (not natural language, not user text) belongs in ALLOWLIST, with an issue reference.`,
  );
});

test("#679: every allowlist entry still exists (a fixed place leaves the list)", () => {
  const found = scan();
  const stale = Object.keys(ALLOWLIST).filter((k) => !found.has(k));
  assert.deepEqual(stale, [], `Allowlist entries no longer found — remove them from ALLOWLIST:\n  ${stale.join("\n  ")}`);
});

test("#679: every allowlist entry names an issue", () => {
  for (const [key, why] of Object.entries(ALLOWLIST)) assert.match(why, /#\d+/, key);
});

test("#679: the detectors see each shape they are for (the guard cannot go blind)", () => {
  // Revert-check: break any one detector and its line here fails.
  assert.deepEqual(findLanguageBound(`const LOOKUP_RU = /^(найди|где)/;`), ["name LOOKUP_RU"]);
  assert.deepEqual(findLanguageBound(`const ACKS = {\n  en: ["ok"],\n};`), ["keyed ACKS"]);
  assert.deepEqual(findLanguageBound(`const ASK = /\\b(find|search|where is)\\b/i;`), ["words /find|search|where is/"]);
  assert.deepEqual(findLanguageBound(`s.split(/[^a-zäöü0-9]+/);`), ["latin [^a-zäöü0-9]"]);
  // Language-neutral forms stay quiet.
  assert.deepEqual(findLanguageBound(`s.split(/[^\\p{L}\\p{N}]+/u); const MAX_CUES = 5;`), []);
  assert.deepEqual(findLanguageBound(`const RM = /\\brm\\s+(-r|--recursive)/;`), []);
});
