/**
 * Topic detection for PreToolUse hooks, including Codex apply_patch (#15).
 *
 * Pure, deterministic, no IO. Given a tool invocation we are about to make
 * (Write / Edit / MultiEdit), turn it into a recall() query plus topic tags
 * that future-Claude has likely tagged in the vault.
 *
 * The heuristic is intentionally simple — extension + path segments +
 * content keywords. AST parsing is out of scope until v0.5; the recall
 * weighting puts `recall_when` at 5x and title at 4x, so even rough hints
 * tend to retrieve the right memory if the saver populated `recall_when`
 * with action phrases ("writing tsx with input", etc.).
 */
import { basename, extname } from "node:path";
import { existsSync } from "node:fs";
import { dirname, join as joinPath, resolve as resolvePath } from "node:path";
import { normalizeScopeKey } from "./scope.js";

export interface ToolIntent {
  tool_name: "Write" | "Edit" | "MultiEdit" | "NotebookEdit" | string;
  file_path: string | null;
  /** Concatenated content / new_string excerpt(s). May be empty. */
  content_excerpt: string;
}

export interface TopicResult {
  /** Natural-language query string for recall(). */
  query: string;
  /** Distinct topics, ordered by signal strength. */
  topics: string[];
  /** Detected file kind, e.g. "tsx", "css", "sql". May be "" if unknown. */
  filetype: string;
}

const EXT_TOPICS: Record<string, string[]> = {
  ".tsx": ["react", "tsx", "component", "ui"],
  ".jsx": ["react", "jsx", "component", "ui"],
  ".ts": ["typescript"],
  ".js": ["javascript"],
  ".mjs": ["javascript", "esm"],
  ".cjs": ["javascript", "commonjs"],
  ".css": ["css", "styles"],
  ".scss": ["scss", "css", "styles"],
  ".html": ["html", "markup"],
  ".vue": ["vue", "component", "ui"],
  ".svelte": ["svelte", "component", "ui"],
  ".py": ["python"],
  ".rb": ["ruby"],
  ".go": ["golang"],
  ".rs": ["rust"],
  ".swift": ["swift"],
  ".kt": ["kotlin"],
  ".java": ["java"],
  ".sh": ["shell", "bash"],
  ".zsh": ["shell", "zsh"],
  ".sql": ["sql", "database", "schema"],
  ".prisma": ["prisma", "schema", "database"],
  ".graphql": ["graphql", "schema"],
  ".gql": ["graphql", "schema"],
  ".yaml": ["yaml", "config"],
  ".yml": ["yaml", "config"],
  ".toml": ["toml", "config"],
  ".json": ["json", "config"],
  ".md": ["markdown", "docs"],
  ".mdx": ["mdx", "markdown", "docs"],
};

const PATH_SEGMENT_TOPICS: Record<string, string[]> = {
  api: ["api", "endpoint"],
  apis: ["api", "endpoint"],
  routes: ["routing", "api"],
  pages: ["routing", "page"],
  app: ["routing"],
  components: ["component", "ui"],
  hooks: ["react-hook"],
  tests: ["testing", "test"],
  __tests__: ["testing", "test"],
  spec: ["testing", "test"],
  e2e: ["testing", "e2e"],
  migrations: ["migration", "schema", "database"],
  schema: ["schema"],
  models: ["model", "schema"],
  styles: ["css", "styles"],
  ui: ["ui"],
  forms: ["form", "ui"],
  auth: ["auth", "security"],
  middleware: ["middleware"],
  lib: ["library"],
  utils: ["utility"],
  scripts: ["script"],
  daemon: ["daemon"],
};

/** Order matters — the first match wins for filetype labelling. */
const CONTENT_PATTERNS: { re: RegExp; topics: string[] }[] = [
  // React / JSX intent
  { re: /<input\b/i, topics: ["input", "form"] },
  { re: /<button\b/i, topics: ["button", "ui"] },
  { re: /<form\b/i, topics: ["form", "ui"] },
  { re: /<select\b/i, topics: ["select", "form"] },
  { re: /<textarea\b/i, topics: ["textarea", "form"] },
  { re: /\buseState\b/, topics: ["react-hook", "state"] },
  { re: /\buseEffect\b/, topics: ["react-hook", "effect"] },
  { re: /\buseMemo\b|\buseCallback\b/, topics: ["react-hook", "memoization"] },
  { re: /\buseRef\b/, topics: ["react-hook", "ref"] },
  // CSS intent
  { re: /\b(display\s*:\s*grid|grid-template)/i, topics: ["css-grid", "layout"] },
  { re: /\b(display\s*:\s*flex|flex-direction)/i, topics: ["flexbox", "layout"] },
  { re: /:focus(-visible|-within)?\b/, topics: ["focus", "accessibility"] },
  { re: /\b(outline|box-shadow|ring-)/, topics: ["focus-ring", "outline"] },
  { re: /\bz-index\b/i, topics: ["stacking", "z-index"] },
  { re: /\boverflow\s*:/i, topics: ["overflow", "scrollbar"] },
  { re: /\bscrollbar\b/i, topics: ["scrollbar"] },
  // SQL / migration intent
  { re: /\bCREATE\s+TABLE\b/i, topics: ["sql", "schema", "migration"] },
  { re: /\bALTER\s+TABLE\b/i, topics: ["sql", "migration", "schema-change"] },
  { re: /\bINSERT\s+INTO\b/i, topics: ["sql", "insert"] },
  { re: /\bSELECT\b.+\bFROM\b/is, topics: ["sql", "query"] },
  // Auth / security
  { re: /\b(jwt|bearer|oauth|session)\b/i, topics: ["auth", "security"] },
  { re: /\bbcrypt|argon2|sha-?256|crypto\b/i, topics: ["crypto", "security"] },
  // Tests
  { re: /\b(describe|it|test|expect)\s*\(/, topics: ["testing"] },
];

/**
 * Scan path segments looking for known topic-rich folders.
 * Walks left→right so the deepest topic ends up first.
 */
function pathSegmentTopics(filePath: string): string[] {
  const segments = filePath.split("/").map((s) => s.toLowerCase());
  const out: string[] = [];
  for (const seg of segments) {
    const t = PATH_SEGMENT_TOPICS[seg];
    if (t) out.push(...t);
  }
  return out;
}

/** Common repo-root segments — a path segment right after one of these is a
 *  real project-root hit, not a guess. */
const PROJECT_ROOTS = new Set(["projekte", "projects", "code", "workspace", "src", "repos"]);

export interface DetectedProject {
  /** The path segment verbatim, in its on-disk casing (e.g. "CarNexus"). */
  raw: string;
  /** Canonical comparison key ({@link normalizeScopeKey} of `raw`) — the
   *  ONLY field a scope/project FILTER may use. `raw` is for display and
   *  telemetry only. */
  key: string;
  /** "git-root": das nächstgelegene `.git` bestimmt das Projekt — die einzige
   *  Auskunft, die wirklich sagt "hier fängt ein Repo an". "root-match": ein
   *  bekanntes Container-Segment (Projekte/projects/code/…) wurde getroffen —
   *  eine Heuristik. "fallback": nur das letzte Pfadsegment, ein Rateschluss,
   *  den jeder nichtleere Pfad produziert. "none": kein Pfad. */
  confidence: "git-root" | "root-match" | "fallback" | "none";
}

/** The words a hook-composed recall query can be made of. See {@link hookQueryVocabulary}. */
export interface HookQueryVocabulary {
  /** File labels: the extensions `detectTopics` turns into `fileLabel`, without the dot. */
  readonly fileLabels: readonly string[];
  /** Every topic any of the three sources can contribute. */
  readonly topics: readonly string[];
}

let vocabularyCache: HookQueryVocabulary | undefined;

/**
 * The vocabulary a hook-composed recall query is built from (#413).
 *
 * The gold set must not contain queries the hooks BUILT — they are real traffic
 * but they are not formulations, and a set of them measures how well the index
 * matches a template. The harvester's filter recognised only the English form
 * (`editing ts involving typescript, daemon, testing`), while the
 * language-neutral default of #231 — `fileLabel` plus its topics, joined by
 * spaces — has been the shipped composition since then and passed through
 * completely: 46 of 400 staged queries in the measured batch.
 *
 * A recogniser for that form cannot work on shape alone, because a
 * space-joined keyword chain is exactly what a genuine telemetry query looks
 * like too. It needs to know the WORDS, so the vocabulary is exported here
 * rather than restated in the harvester: a second copy would drift from the
 * composition it is supposed to recognise the first time either changes.
 *
 * Computed on first call and cached — the hook path never asks for it, so it
 * costs the recall budget nothing.
 */
export function hookQueryVocabulary(): HookQueryVocabulary {
  if (!vocabularyCache) {
    vocabularyCache = {
      fileLabels: Object.keys(EXT_TOPICS)
        .map((e) => (e.startsWith(".") ? e.slice(1) : e))
        .sort(),
      topics: [
        ...new Set([
          ...Object.values(EXT_TOPICS).flat(),
          ...Object.values(PATH_SEGMENT_TOPICS).flat(),
          ...CONTENT_PATTERNS.flatMap((p) => p.topics),
        ]),
      ].sort(),
    };
  }
  return vocabularyCache;
}

/**
 * Structured project detection (#360-Folgefund C): the old `detectProject()`
 * collapsed EVERY outcome — a real repo-root match, a last-segment guess, and
 * "no cwd at all" — into one string-or-null, so callers could never tell
 * detection from a guess. `/Users/x/Projekte` → "Projekte" and
 * `/tmp/worktree/packages/core` → "core" both came back looking equally
 * confident as `/Users/x/Projekte/bastra-recall` → "bastra-recall".
 */
export function detectProjectDetailed(cwd: string): DetectedProject {
  if (!cwd) return { raw: "", key: "", confidence: "none" };
  const cached = detectCache.get(cwd);
  if (cached !== undefined) return cached;
  const result = detectUncached(cwd);
  // Ein Hook feuert bei jedem Tool-Call mit demselben cwd — die Aufwärtssuche
  // nach `.git` darf nicht jedes Mal das Dateisystem anfassen. Der Cache ist
  // prozesslokal und lebt so lange wie der Daemon; ein cwd wechselt sein Repo
  // nicht.
  detectCache.set(cwd, result);
  return result;
}

const detectCache = new Map<string, DetectedProject>();

function detectUncached(cwd: string): DetectedProject {
  // Windows-Pfade tragen `\`, und ein reines Split auf `/` hätte dort EIN
  // Segment gesehen (Codex-Gegenreview, P2).
  const parts = cwd.split(/[\\/]/).filter(Boolean);

  // Der nächstgelegene `.git`-Ordner ist die einzige Auskunft, die wirklich
  // "hier fängt ein Repo an" bedeutet. Die Container-Heuristik darunter nahm
  // das ERSTE passende Segment und lag damit bei jeder verschachtelten
  // Struktur falsch: `/Users/me/Projects/company/repos/real-repo/packages/core`
  // ergab "company", weil `Projects` zuerst kam — mit voller Zuversicht. Ein
  // scharfer Scope-Filter entfernt dann die Memories von `real-repo`.
  //
  // Kein Prozess-Spawn: `existsSync` je Ebene, ein paar Ebenen tief, und das
  // Ergebnis wird gecacht.
  const gitRoot = findGitRoot(cwd);
  if (gitRoot !== null) {
    return { raw: gitRoot, key: normalizeScopeKey(gitRoot), confidence: "git-root" };
  }

  for (let i = 0; i < parts.length - 1; i++) {
    if (PROJECT_ROOTS.has(parts[i].toLowerCase())) {
      const raw = parts[i + 1];
      return { raw, key: normalizeScopeKey(raw), confidence: "root-match" };
    }
  }
  // Fallback: last segment — good when cwd *is* the repo root, a guess
  // everywhere else.
  const last = parts[parts.length - 1];
  if (last === undefined) return { raw: "", key: "", confidence: "none" };
  return { raw: last, key: normalizeScopeKey(last), confidence: "fallback" };
}

/** Verzeichnisname des nächstgelegenen Vorfahren mit `.git` — oder null.
 *  `.git` ist in Worktrees und Submodulen eine DATEI, nicht nur ein Ordner,
 *  deshalb `existsSync` statt einer Verzeichnisprüfung. */
function findGitRoot(cwd: string): string | null {
  let dir = resolvePath(cwd);
  for (let depth = 0; depth < 64; depth++) {
    if (existsSync(joinPath(dir, ".git"))) {
      const name = basename(dir);
      return name === "" ? null : name;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Best-effort project name from cwd, e.g. /Users/x/Projekte/bastra-recall →
 * "bastra-recall". Thin wrapper over {@link detectProjectDetailed} — kept
 * because 4 daemon lanes (write/prompt/todo/session) plus eval's
 * candidate-union already call this exact signature and only ever want the
 * raw name (they pass it on as a display/query field or into
 * `isScopeCompatible`/`scopeEquals`, which fold casing themselves); switching
 * all of them to the detailed shape for this task would touch call sites
 * the bug report never named. New callers that need to distinguish a real
 * root-match from a last-segment guess should call `detectProjectDetailed`
 * directly.
 */
export function detectProject(cwd: string): string | null {
  const d = detectProjectDetailed(cwd);
  return d.confidence === "none" ? null : d.raw;
}

export function detectTopics(intent: ToolIntent): TopicResult {
  const topics = new Set<string>();
  const fp = intent.file_path ?? "";
  const ext = fp ? extname(fp).toLowerCase() : "";
  const filetype = ext.startsWith(".") ? ext.slice(1) : "";

  const extTopics = EXT_TOPICS[ext];
  if (extTopics) for (const t of extTopics) topics.add(t);

  for (const t of pathSegmentTopics(fp)) topics.add(t);

  const content = intent.content_excerpt ?? "";
  if (content) {
    for (const { re, topics: ts } of CONTENT_PATTERNS) {
      if (re.test(content)) for (const t of ts) topics.add(t);
    }
  }

  const topicList = [...topics];
  const fileLabel = filetype || (fp ? basename(fp) : "file");

  // Build a recall query. Default (#231): LANGUAGE-NEUTRAL — the file identifier
  // (extension or basename) plus the top topics, deduped, order stable. No
  // English filler verbs/connectors: recall's lexical arm is half the RRF vote,
  // and on a non-English vault template words ("editing", "involving") spend that
  // vote on tokens the user's memories can't contain — pulling English docs up
  // and starving non-English `recall_when`. The signal lives in the identifier +
  // topics (extensions, path segments, symbols — language-neutral by
  // construction), so dropping the filler loses nothing. We still never inject
  // the full file_path: project/monorepo names are high-frequency tokens that
  // drown out topic signal; path segments already feed `topics` above.
  //
  // Kill switch: BASTRA_HOOK_QUERY=english restores the old action-verb template.
  // Read per call so tests (and users) can flip it without a reload.
  let query: string;
  if ((process.env.BASTRA_HOOK_QUERY ?? "").toLowerCase() === "english") {
    const intentVerb = intent.tool_name === "Write" ? "writing" : "editing";
    const head = `${intentVerb} ${fileLabel}`;
    const tail = topicList.length ? ` involving ${topicList.slice(0, 6).join(", ")}` : "";
    query = head + tail;
  } else {
    const seen = new Set<string>();
    const terms: string[] = [];
    for (const term of [fileLabel, ...topicList.slice(0, 6)]) {
      if (term && !seen.has(term)) {
        seen.add(term);
        terms.push(term);
      }
    }
    query = terms.join(" ");
  }

  return { query, topics: topicList, filetype };
}

/**
 * Pull a representative content excerpt out of a Claude-Code or Codex
 * tool_input payload (#15). Caps at maxChars to keep the recall query bounded
 * — the goal is topic detection, not full-text similarity.
 */
export function extractContentExcerpt(
  toolName: string,
  toolInput: Record<string, unknown>,
  maxChars = 4000,
): string {
  const pieces: string[] = [];
  if (toolName === "Write" && typeof toolInput.content === "string") {
    pieces.push(toolInput.content);
  }
  if (toolName === "Edit") {
    if (typeof toolInput.new_string === "string") pieces.push(toolInput.new_string);
    if (typeof toolInput.old_string === "string") pieces.push(toolInput.old_string);
  }
  if (toolName === "MultiEdit" && Array.isArray(toolInput.edits)) {
    for (const e of toolInput.edits as { new_string?: unknown; old_string?: unknown }[]) {
      if (typeof e.new_string === "string") pieces.push(e.new_string);
      if (typeof e.old_string === "string") pieces.push(e.old_string);
    }
  }
  if (toolName === "NotebookEdit" && typeof toolInput.new_source === "string") {
    pieces.push(toolInput.new_source);
  }
  if (toolName === "apply_patch" && typeof toolInput.command === "string") {
    pieces.push(toolInput.command);
  }
  const joined = pieces.join("\n");
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}
