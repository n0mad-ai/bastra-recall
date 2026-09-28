/**
 * Lightweight, zero-dependency language detection for the shared learned-recall
 * layer (#120). It is deliberately heuristic (stopword overlap + diacritic
 * signal) rather than a dependency: recall runs on a 500 ms hook budget, queries
 * are short, and a cheap guess that abstains on low confidence beats a heavy
 * library that still fails on 3-word, code-token-heavy inputs.
 *
 * #707: detection only FILES a bridge. It picks the folder a new bridge is
 * written to (bridges/<lang>/); it no longer decides whether a bridge is minted
 * or fires. Only de and en have stopword sets, so any other language — and any
 * query detection abstains on — is filed under "und" (BCP-47 "undetermined")
 * and mints and fires like every other bridge. Before, abstain meant "no pool":
 * a Russian owner's prompts never minted a bridge and never got one.
 *
 * detectLanguage still ABSTAINS (lang=null) when the input is too short,
 * code-shaped, or ambiguous; bridgeLanguage() turns that into "und".
 */

/** Languages detectLanguage can name, and the values the `bastra bridges
 *  language` override accepts. Extend deliberately — each new language needs a
 *  stopword set below or detection silently never picks it. A language that is
 *  not here is not locked out: its bridges live under "und" (#707). */
export const SUPPORTED_LANGUAGES = ["de", "en"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export function isSupportedLanguage(v: unknown): v is SupportedLanguage {
  return typeof v === "string" && (SUPPORTED_LANGUAGES as readonly string[]).includes(v);
}

export interface LanguageResult {
  /** Detected language, or null when the detector abstains (too short / ambiguous / code). */
  lang: SupportedLanguage | null;
  /** 0..1 separation between the top language and the runner-up. 0 on abstain. */
  confidence: number;
  /** Per-language raw signal counts (stopword hits + diacritic weight). For debugging/telemetry. */
  scores: Record<SupportedLanguage, number>;
}

// The ~40 most frequent function words per language. Function words are the most
// reliable short-text language signal: they are high-frequency, language-specific,
// and survive in fragments where content words (and code tokens) do not.
const DE_STOPWORDS = new Set([
  "der", "die", "das", "und", "oder", "aber", "wenn", "dann", "ich", "du", "er",
  "sie", "es", "wir", "ihr", "nicht", "ist", "sind", "war", "waren", "mit", "für",
  "auf", "von", "zu", "im", "am", "ein", "eine", "einen", "einem", "einer", "wie",
  "was", "wo", "wer", "warum", "wieder", "schon", "noch", "nur", "auch", "sehr",
  "bei", "nach", "über", "unter", "durch", "gegen", "ohne", "um", "den", "dem",
  "des", "soll", "sollte", "muss", "kann", "machen", "werden", "wird", "haben",
  "hat", "sich", "dass", "weil", "damit", "beim", "zum", "zur",
]);

const EN_STOPWORDS = new Set([
  "the", "and", "or", "but", "if", "then", "is", "are", "was", "were", "with",
  "for", "on", "of", "to", "in", "at", "a", "an", "how", "what", "where", "who",
  "why", "this", "that", "these", "those", "not", "very", "also", "into", "over",
  "under", "through", "against", "without", "about", "should", "must", "can",
  "make", "made", "will", "have", "has", "be", "been", "it", "its", "we", "you",
  "they", "from", "when", "because", "so", "do", "does", "did",
]);

// Tokens shorter than this many real word-characters give no language signal.
const MIN_ALPHA_TOKENS = 2;
// Below this top-vs-runner-up separation we abstain, UNLESS a diacritic forces DE.
const MIN_CONFIDENCE = 0.2;
// German diacritics are a near-certain DE signal; weight each occurrence.
const DIACRITIC_WEIGHT = 2;

const EMPTY_SCORES = (): Record<SupportedLanguage, number> => ({ de: 0, en: 0 });

/** lowercase, split on non-letters (keeping German diacritics), drop empties. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zäöüß]+/i)
    .filter((t) => t.length > 0);
}

/**
 * Detect the language of a (typically short) query or text. Returns lang=null
 * when there is not enough signal to route confidently — the caller must treat
 * that as "no language pool", not as a default.
 */
export function detectLanguage(text: string): LanguageResult {
  const scores = EMPTY_SCORES();
  if (!text || text.trim() === "") return { lang: null, confidence: 0, scores };

  const tokens = tokenize(text);
  // Code-shaped queries ("NSPanel resignKey Observer") have letters but no
  // function words; they fall through to total===0 below and abstain.
  if (tokens.length < MIN_ALPHA_TOKENS) return { lang: null, confidence: 0, scores };

  let deStop = 0;
  let enStop = 0;
  for (const t of tokens) {
    if (DE_STOPWORDS.has(t)) deStop += 1;
    if (EN_STOPWORDS.has(t)) enStop += 1;
  }
  const diacritics = (text.match(/[äöüß]/gi) ?? []).length;
  const diacriticTokens = new Set(tokens.filter((t) => /[äöüß]/.test(t))).size;

  // A German diacritic is a strong DE signal — UNLESS it comes from a single token
  // in an otherwise English-stopword-dominated query (a German proper noun like
  // "Müller" inside an English sentence). In that case it must NOT flip the result
  // to German: a misrouted bridge is worse than no bridge.
  const diacriticForcesDe = diacritics > 0 && !(enStop > deStop && diacriticTokens <= 1);

  scores.de = deStop + (diacriticForcesDe ? diacritics * DIACRITIC_WEIGHT : 0);
  scores.en = enStop;

  const total = scores.de + scores.en;
  if (total === 0) return { lang: null, confidence: 0, scores };

  const top: SupportedLanguage = scores.de >= scores.en ? "de" : "en";
  const topScore = Math.max(scores.de, scores.en);
  const runnerUp = Math.min(scores.de, scores.en);
  const confidence = (topScore - runnerUp) / total;

  // Abstain on low separation, unless a DE-committing diacritic forces the call.
  if (confidence < MIN_CONFIDENCE && !diacriticForcesDe) {
    return { lang: null, confidence, scores };
  }
  return { lang: top, confidence, scores };
}

/** #707: the folder for bridges whose language detection could not name. */
export const UNDETERMINED_LANGUAGE = "und";

/** #707: the folder a bridge minted from `text` is filed under — the detected
 *  language, or "und". Never null: filing never blocks a mint. */
export function bridgeLanguage(text: string): string {
  return detectLanguage(text).lang ?? UNDETERMINED_LANGUAGE;
}

/** A bridge folder name: a 2–3 letter language code ("de", "en", "und", and
 *  whatever a Commons clone adds). The shape check keeps a cloned file's `lang`
 *  out of path tricks without naming languages. */
export function isBridgeLanguage(v: unknown): v is string {
  return typeof v === "string" && /^[a-z]{2,3}$/.test(v);
}
