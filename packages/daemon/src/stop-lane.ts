/**
 * Stop lane, daemon-side (#369/#15 — the #343/#344 pattern, applied to the lane
 * that fires at the end of EVERY answer).
 *
 * The save-evaluation this file describes ran in the hook process until #369:
 * ~75ms of node interpreter start, 94-108x/day, at the one moment the user is
 * waiting for the turn to be over. The pipeline moved here verbatim behind
 * POST /hook/stop; `stop-hook.ts` is a thin client now.
 *
 * Looks at the recent transcript and surfaces save-suggestions when one of
 * three heuristics fires. Never calls save_memory itself — only suggests
 * (the agent decides in the next turn whether to act).
 *
 * Heuristics:
 *   1. Frustration-Density   — >=4 cues AND >=2 explicit frustration words
 *      (`wieder/schon wieder/wie oft/fuck/verdammt/scheisse`) in the last 10
 *      user turns. CAPS words count as cues only when they are >=5 chars or
 *      repeated in a turn AND not a technical acronym (SKILL/JSON/…); CAPS
 *      alone never triggers.
 *   2. Feature-Completion    — `git commit` mentioned in a USER turn + >=5
 *      distinct repo-relative source-file tokens, at least one of which exists
 *      under the session cwd.
 *   3. Architecture-Decision — `ok dann | lass uns | entschieden | final |
 *      gehen wir mit` in the last 5 user turns.
 *
 * Output: ALWAYS `{}` (#48 — suggestions go to the pending file, which the
 * next SessionStart injects silently). The lane still returns that document
 * rather than nothing, so the client keeps writing the daemon's answer
 * verbatim like every other lane.
 *
 * Discipline:
 *   - Budget 1000 ms. Any failure path returns `{}`.
 *   - Never blocks the workflow.
 *   - Telemetry best-effort.
 *
 * The transcript is read HERE now, from the path the payload names — same
 * untrusted-input handling as before (extension check, size cap, fstat on the
 * open handle), just in the daemon process. Nothing else about the read
 * changed: the daemon runs as the same user as the hook did.
 */
import { appendFile, mkdir, open } from "node:fs/promises";
import { request } from "node:http";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
// #305: the scrub leaf, never the core barrel — the barrel costs +40ms of
// process start for a function that lives in a dependency-free module.
import { scrubInjectedBlocks } from "@bastra-recall/core/scrub";
import { envFirst } from "./env.js";
import { defaultLogDir } from "./telemetry.js";
import { writePendingSuggestion } from "./pending-suggestions.js";
import { getDocsMode, type DocsMode } from "./settings.js";

// 0.1.0 = unchanged event contract; the lane moved, the shape did not (#369).
const HOOK_VERSION = "0.1.0";
const FRUSTRATION_WINDOW_TURNS = 10;
const FRUSTRATION_CUE_THRESHOLD = 4;
const FRUSTRATION_FRUSTWORD_MIN = 2;
const DECISION_WINDOW_TURNS = 5;
const FEATURE_FILE_TOKEN_MIN = 5;

export interface ClaudeStopPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  transcript_path?: string;
  transcript?: unknown;
  stop_hook_active?: boolean;
}

interface TranscriptTurn {
  role: "user" | "assistant" | "system" | string;
  content: string;
}

type Heuristic = "frustration-density" | "feature-completion" | "architecture-decision";

interface SaveSuggestion {
  heuristic: Heuristic;
  title: string;
  type: "lesson" | "project-fact" | "decision";
  body: string;
}

/**
 * Run the save-evaluation and return the exact JSON string the thin client
 * writes to stdout — always `{}` (#48). Never throws; every failure path
 * degrades to `{}`, matching the CLI's fail-open contract.
 */
export async function runStopLane(
  payload: ClaudeStopPayload,
  selfBaseUrl: string,
): Promise<string> {
  const startedAt = Date.now();

  if (payload.hook_event_name !== "Stop") return "{}";
  if (payload.stop_hook_active === true) return "{}";

  const turns = await loadTranscript(payload);
  if (turns.length === 0) return "{}";

  const last30 = turns.slice(-30);
  const suggestions = evaluateHeuristics(last30, { cwd: payload.cwd });

  // Produkt-Doku (docs.mode): feature-completion ist auch der Trigger für
  // die Doku-Pflege — Hinweis an die Suggestion hängen, wenn eingeschaltet.
  // Settings-Read ist lokal; Fehler → kein Hint, Hook läuft weiter.
  try {
    appendProductDocHint(suggestions, await getDocsMode());
  } catch {
    /* best-effort */
  }

  // Drift-Detektor (#67): unabhängig vom Transcript — der Daemon prüft, ob
  // jüngste Memories ein wiederkehrendes Cluster ohne Taxonomie-Konvention
  // bilden. Best-effort mit hartem Budget; Daemon weg → still.
  const drift = await fetchDrift(selfBaseUrl, 250);

  if (suggestions.length > 0 || drift.length > 0) {
    // #48 Redesign: Stop-Hooks haben keinen stillen Output-Kanal — das
    // einzige sichtbare Feld (systemMessage) rendert Claude Code 1:1 in den
    // Chat (die „Zeichenflut", die den Hook deaktiviert hat). Stattdessen:
    // Vorschläge in die Pending-Datei schreiben; der SessionStart-Hook der
    // nächsten Session injiziert sie still als additionalContext. stdout
    // bleibt IMMER leer.
    const blocks = [
      ...suggestions.map(formatSuggestion),
      ...(drift.length > 0 ? [formatDriftBlock(drift)] : []),
    ].join("\n");
    await writePendingSuggestion(blocks);
  }

  const totalMs = Date.now() - startedAt;
  await writeTelemetry({
    session_id: payload.session_id ?? null,
    heuristic: suggestions.map((s) => s.heuristic).join(",") || null,
    suggested_count: suggestions.length,
    drift_clusters: drift.length,
    turn_count: turns.length,
    latency_ms_total: totalMs,
  });
  return "{}";
}

// ─── Taxonomie-Drift (#67) ───────────────────────────────────────

interface DriftCluster {
  key: string;
  kind: "tag" | "topic";
  count: number;
  examples: string[];
}

/**
 * Drift-Hinweis für den Agent. Suggestion-only — der Agent entscheidet im
 * nächsten Turn, ob er eine Konvention etabliert; geschrieben wird hier nie.
 */
function formatDriftBlock(clusters: DriftCluster[]): string {
  const lines = clusters.map(
    (c) =>
      `- ${c.count} recent memories share the ${c.kind} '${c.key}' with no ` +
      `taxonomy convention covering it (e.g. ${c.examples.join(", ")}).`,
  );
  return (
    `<taxonomy-drift>\n` +
    `The vault is forming ad-hoc clusters without a home:\n` +
    lines.join("\n") +
    `\nIf a cluster is here to stay, establish a convention next turn: ` +
    `save_memory with scope='taxonomy', tag 'convention', body = the rule ` +
    `(folder, topic_path shape, tags, body shape, one example) — then re-file ` +
    `the members (overwrite=true + the convention's folder). ` +
    `Suggestion only: weigh it, ask the user if unsure, never bulk-move silently.\n` +
    `</taxonomy-drift>`
  );
}

/** Loopback self-call to this same server (~1-3ms), like every other lane's
 *  daemon call — the base URL is passed in by the route, not read from the
 *  environment. */
function fetchDrift(baseUrl: string, timeoutMs: number): Promise<DriftCluster[]> {
  return new Promise((resolve_) => {
    let url: URL;
    try {
      url = new URL("/hook/drift", baseUrl);
    } catch {
      resolve_([]);
      return;
    }
    const req = request(
      {
        method: "GET",
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              clusters?: DriftCluster[];
            };
            if ((res.statusCode ?? 500) === 200 && Array.isArray(data.clusters)) {
              resolve_(data.clusters);
              return;
            }
          } catch { /* fallthrough */ }
          resolve_([]);
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve_([]);
    });
    req.on("error", () => resolve_([]));
    req.end();
  });
}

async function loadTranscript(payload: ClaudeStopPayload): Promise<TranscriptTurn[]> {
  if (Array.isArray(payload.transcript)) {
    return normalizeTurns(payload.transcript as unknown[]);
  }
  if (typeof payload.transcript_path === "string") {
    try {
      // transcript_path kommt aus dem Hook-Payload (untrusted): nur echte
      // Transcript-Dateien lesen (.jsonl/.json) und eine Größenschranke
      // ziehen — sonst wird der Hook zum Arbitrary-File-Read / Memory-DoS.
      // Einmal öffnen und fstat auf dem Handle: kein TOCTOU-Fenster zwischen
      // Check und Read.
      if (!/\.jsonl?$/.test(payload.transcript_path)) return [];
      const fh = await open(payload.transcript_path, "r");
      try {
        const st = await fh.stat();
        if (!st.isFile() || st.size > MAX_TRANSCRIPT_BYTES) return [];
        const content = await fh.readFile({ encoding: "utf8" });
        return parseTranscriptFile(content);
      } finally {
        await fh.close();
      }
    } catch {
      return [];
    }
  }
  return [];
}

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024; // 64 MiB — weit über realen Transcripts

function parseTranscriptFile(raw: string): TranscriptTurn[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as unknown[];
      return normalizeTurns(arr);
    } catch {
      return [];
    }
  }
  const out: unknown[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // skip
    }
  }
  return normalizeTurns(out);
}

// In Claude-Code transcripts a tool result is stored as a `role: "user"`
// message whose content is an array of `tool_result` blocks (bash/tool output).
// That is NOT human prose — the frustration / decision heuristics must not scan
// it. We reclassify such turns to role "tool" so only genuine typed user
// messages keep role "user". Feature-completion still scans every turn's text.
function isToolResultContent(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "tool_result",
    )
  );
}

/**
 * System-injizierte Turns, die im Transcript als role "user" auftauchen, aber
 * keine getippte Prosa sind. Der Skill-Body (Prefix "Base directory for this
 * skill:") dokumentiert die Frust-Trigger SELBST — ohne diesen Ausschluss
 * triggert jede Session, die den bastra-Skill lädt, die frustration-Heuristik
 * auf der eigenen Doku (der zweite strukturelle Defekt hinter #48).
 */
function isInjectedSystemContent(text: string): boolean {
  const head = text.trimStart();
  return (
    head.startsWith("Base directory for this skill:") ||
    head.startsWith("<system-reminder>") ||
    head.startsWith("<command-name>") ||
    head.startsWith("<local-command-caveat>")
  );
}

function effectiveRole(role: string, content: unknown): string {
  if (role === "user" && isToolResultContent(content)) return "tool";
  if (role === "user" && isInjectedSystemContent(stringifyContent(content))) return "system-injected";
  return role;
}

function normalizeTurns(items: unknown[]): TranscriptTurn[] {
  const out: TranscriptTurn[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    // Codex rollout JSONL wraps conversation messages as
    // `{type:"response_item", payload:{type:"message", role, content}}`.
    // Upstream documents this file format as unstable, so this parser remains
    // additive and the older Claude/direct shapes below stay intact (#15).
    const payload = obj.payload;
    if (obj.type === "response_item" && payload && typeof payload === "object") {
      const p = payload as Record<string, unknown>;
      if (p.type === "message" && typeof p.role === "string") {
        out.push({
          role: effectiveRole(p.role, p.content),
          content: scrubTurnContent(stringifyContent(p.content)),
        });
        continue;
      }
    }
    const directRole = obj.role;
    const directContent = obj.content;
    if (typeof directRole === "string") {
      out.push({ role: effectiveRole(directRole, directContent), content: scrubTurnContent(stringifyContent(directContent)) });
      continue;
    }
    const msg = obj.message;
    if (msg && typeof msg === "object") {
      const m = msg as Record<string, unknown>;
      const role = typeof m.role === "string" ? m.role : "unknown";
      out.push({ role: effectiveRole(role, m.content), content: scrubTurnContent(stringifyContent(m.content)) });
      continue;
    }
    if (typeof obj.text === "string") {
      out.push({ role: "unknown", content: scrubTurnContent(obj.text) });
    }
  }
  return out;
}

// #149: our own hook injections (<recall-hints>, <session-context>, …) quote
// file paths and trigger vocabulary. Embedded mid-turn they survive the
// prefix-based role reclassification above, and detectFeatureCompletion scans
// EVERY role's text for file tokens — so recalled context could count toward
// its own re-capture. Scrub complete blocks AFTER role classification (the
// prefix match in effectiveRole needs the raw text) so every heuristic sees
// clean prose.
function scrubTurnContent(text: string): string {
  return scrubInjectedBlocks(text).text;
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (typeof c === "string") parts.push(c);
      else if (c && typeof c === "object") {
        const obj = c as Record<string, unknown>;
        if (typeof obj.text === "string") parts.push(obj.text);
        else if (typeof obj.content === "string") parts.push(obj.content);
      }
    }
    return parts.join("\n");
  }
  if (content && typeof content === "object") {
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }
  return "";
}

interface HeuristicDeps {
  cwd?: string;
  fileExists?: (absPath: string) => boolean;
}

function evaluateHeuristics(turns: TranscriptTurn[], deps: HeuristicDeps = {}): SaveSuggestion[] {
  const suggestions: SaveSuggestion[] = [];
  const fr = detectFrustration(turns);
  if (fr) suggestions.push(fr);
  const fc = detectFeatureCompletion(turns, deps);
  if (fc) suggestions.push(fc);
  const ad = detectArchitectureDecision(turns);
  if (ad) suggestions.push(ad);
  return suggestions;
}

// Explicit frustration words. "schon wieder" is matched before plain "wieder"
// so the same span is not double-counted; the global flag counts occurrences.
const FRUST_WORD_RE = /\b(?:schon\s+wieder|wieder|wie\s+oft|verdammt|fuck|schei(?:ss|ß)e)\b/gi;
// Letter runs incl. German Umlauts/ß. We intentionally do NOT use `\b` here:
// JS word boundaries treat Ä/Ö/Ü as non-word chars, so `\b[A-ZÄÖÜ]+\b` would
// mangle CAPS words that start with an Umlaut (ÄRGER → "RGER", ÜBER → no match).
const WORD_TOKEN_RE = /[A-Za-zÄÖÜäöüß]+/g;
const ALL_CAPS_RE = /^[A-ZÄÖÜ]{4,}$/;

// Technical all-caps acronyms that routinely appear in tool output, file paths
// and doc discussions — never a frustration signal on their own.
const CAPS_STOPLIST = new Set([
  "SKILL", "JSON", "CLAUDE", "BASTRA", "NEXUS", "API", "REST", "URL", "HTML",
  "CSS", "HTTP", "HTTPS", "YAML", "XML", "SQL", "PRS", "TUI", "TSX", "JSX",
  "SVG", "PNG", "PDF", "JPG", "TODO", "FIXME",
]);

function countFrustWords(content: string): number {
  const m = content.match(FRUST_WORD_RE);
  return m ? m.length : 0;
}

/**
 * Count qualifying CAPS cues in one turn. A CAPS token only counts when it is
 * not a technical acronym AND it is either >=5 chars or repeated within the
 * turn. A single short token like "SKILL" or "JSON" never qualifies.
 */
function countQualifyingCaps(content: string): number {
  const words = content.match(WORD_TOKEN_RE);
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

function detectFrustration(turns: TranscriptTurn[]): SaveSuggestion | null {
  const userTurns = turns.filter((t) => t.role === "user").slice(-FRUSTRATION_WINDOW_TURNS);
  let frustWordCount = 0;
  let capsCueCount = 0;
  const exemplars: string[] = [];
  for (const t of userTurns) {
    const fw = countFrustWords(t.content);
    if (fw > 0) {
      frustWordCount += fw;
      if (exemplars.length < 3) exemplars.push(t.content.slice(0, 120));
    }
    capsCueCount += countQualifyingCaps(t.content);
  }
  const totalCues = frustWordCount + capsCueCount;
  // CAPS alone must never trigger: require both enough total cues AND a
  // minimum of genuine frustration words.
  if (totalCues < FRUSTRATION_CUE_THRESHOLD) return null;
  if (frustWordCount < FRUSTRATION_FRUSTWORD_MIN) return null;
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

function detectFeatureCompletion(turns: TranscriptTurn[], deps: HeuristicDeps = {}): SaveSuggestion | null {
  // "git commit" must come from a USER turn — not assistant text, tool output,
  // shell output or quoted code. A user confirming the commit is the signal.
  const userText = turns.filter((t) => t.role === "user").map((t) => t.content).join("\n");
  if (!/\bgit\s+commit\b/i.test(userText)) return null;

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

const DECISION_PATTERNS: RegExp[] = [
  /\bok dann\b/i,
  /\blass uns\b/i,
  /\bentschieden\b/i,
  /\bfinal\b/i,
  /\bgehen wir mit\b/i,
];

function detectArchitectureDecision(turns: TranscriptTurn[]): SaveSuggestion | null {
  const userTurns = turns.filter((t) => t.role === "user").slice(-DECISION_WINDOW_TURNS);
  const exemplars: string[] = [];
  for (const t of userTurns) {
    for (const p of DECISION_PATTERNS) {
      if (p.test(t.content)) {
        if (exemplars.length < 2) exemplars.push(t.content.slice(0, 160));
        break;
      }
    }
  }
  if (exemplars.length === 0) return null;
  return {
    heuristic: "architecture-decision",
    title: "decision finalized — save the chosen path and the why",
    type: "decision",
    body: `Decision-language in the last ${userTurns.length} user turns: ${exemplars.join(" | ")}. ` +
      `If an architectural choice was committed (X over Y, the trade-off), save a 'decision' memory ` +
      `with the why + how-to-apply.`,
  };
}

/**
 * Hängt bei eingeschalteter Produkt-Doku (docs.mode != "off") den Doku-
 * Pflege-Hinweis an die feature-completion-Suggestion. Mutiert in place;
 * pure bzgl. I/O — der Settings-Read passiert beim Caller.
 */
function appendProductDocHint(suggestions: SaveSuggestion[], mode: DocsMode): void {
  if (mode === "off") return;
  const fc = suggestions.find((s) => s.heuristic === "feature-completion");
  if (!fc) return;
  fc.body +=
    ` Product docs are enabled (docs.mode=${mode}): if this completed a USER-FACING feature area, ` +
    `also create/update its product doc via save_product_doc (one doc per area, send the complete ` +
    `updated markdown${mode === "suggest" ? "; propose to the user first" : ""}).`;
}

function formatSuggestion(s: SaveSuggestion): string {
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

interface StopHookTelemetry {
  /** #356: the Claude Code session this Stop belongs to — the payload's
   *  session_id, so per-session aggregation is possible. A synthetic UUID
   *  is the fallback only when the payload carried none. */
  session_id?: string | null;
  heuristic: string | null;
  suggested_count: number;
  drift_clusters: number;
  turn_count: number;
  latency_ms_total: number;
}

async function writeTelemetry(payload: StopHookTelemetry): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    // #356: the payload's session_id is real session state — synthetic UUID
    // only when the payload carried none.
    const { session_id: payloadSessionId, ...rest } = payload;
    const event = {
      kind: "save_eval_call",
      ts,
      session_id: payloadSessionId ?? randomUUID(),
      hook_version: HOOK_VERSION,
      ...rest,
    };
    const file = join(logDir, `events-${ts.slice(0, 10)}.jsonl`);
    await appendFile(file, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Telemetry must never break the hook.
  }
}

export {
  evaluateHeuristics,
  detectFrustration,
  detectFeatureCompletion,
  detectArchitectureDecision,
  appendProductDocHint,
  formatSuggestion,
  parseTranscriptFile,
  normalizeTurns,
};
export type { TranscriptTurn, SaveSuggestion };
