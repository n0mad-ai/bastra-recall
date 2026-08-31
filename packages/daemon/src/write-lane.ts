/**
 * PreToolUse Write/Edit/apply_patch lane, daemon-side (#343/#15 — stage A of #305 direction 2,
 * second half; the UserPromptSubmit lane moved in the first).
 *
 * The pipeline that lived in `hook.ts` behind the skip gate: file-size note,
 * topic/project detection, recall self-call, score/scope filters (#107/#110/
 * #148), per-session dedup (#32), empty-streak backoff (#161), formatting,
 * telemetry, usage ping. Moved verbatim behind POST /hook/write; the hook file
 * is a thin client now.
 *
 * The SKIP GATE stayed client-side on purpose. It is pure stdlib (#20/#28) and
 * it fires on the MAJORITY of tool calls — a skipped call should cost a
 * process start and nothing else: no HTTP round trip, no daemon dependency.
 * Everything that survives the gate lands here.
 *
 * Same two non-changes as prompt-lane.ts, same reasons: recall stays a
 * loopback self-call (the hook_call telemetry series keeps measuring the same
 * thing mid-migration), session state stays on the file bus.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { detectTopics, detectProject, extractContentExcerpt } from "@bastra-recall/core";
import { RRF_K, RRF_SCALE } from "@bastra-recall/core/rrf";
import { HINT_FRAME_NOTE, stripFenceMarkers } from "@bastra-recall/core/scrub";
import { requiredHeadline, unfusedHeadline } from "./band-wording.js";
import { envFirst, envInt } from "./env.js";
import { defaultLogDir } from "./telemetry.js";
import { applyLaneScopeFilter, projectConfidence, projectForFilter } from "./scope-filter.js";
import { fileSizeNote } from "./file-size-check.js";
import { memoryLocationNote } from "./memory-location.js";
import { reportHinted } from "./hook-hinted.js";
import { hookClient } from "./hook-surface.js";
import {
  bumpShown,
  cleanupOldStates,
  decideBackoff,
  getLoadedMarkerMtime,
  loadSessionState,
  recordSourceEmit,
  recordSourceSuppressed,
  saveSessionState,
  shouldDropHit,
  wasEmitConsumed,
  type SessionState,
} from "./session-state.js";

// 600ms — measured rationale in the original hook header (12,966 calls,
// median 60ms, p90 225ms, 6.2% timeouts at the old 250ms budget).
const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", 600, "NEXUS_HOOK_TIMEOUT_MS");
const HOOK_VERSION = "0.4.0"; // 0.4.0 = daemon-side lane (#343)
const SCORE_FLOOR = envInt("BASTRA_RECALL_FLOOR", 30); // mirror SKILL.md: <30 is noise
// Hits at/above this are non-negotiable loads. #9 Stage C: env-tunable so we
// can lift the REQUIRED band from telemetry without a rebuild.
const MUST_LOAD_SCORE = envInt("BASTRA_MUST_LOAD_SCORE", 100);
// #161: backoff source key — write-edit hints back off independently of the
// other hook sources (bash-tripwire, bash-fail, prompt-lookup, todo-plan).
const BACKOFF_SOURCE = "write-edit";

export interface WriteHookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

interface RecallHit {
  id: string;
  title: string;
  type: string;
  scope: string;
  summary: string;
  score: number;
  /** #148: matchte der Hit auf seinem hand-geschriebenen `recall_when`?
   *  Lässt starke, absichtliche Cross-Scope-Hits durch den #110-Filter. */
  matched_recall_when?: boolean;
  /** P0: Tragfähigkeit dieses Ankers — der Cross-Scope-Bypass verlangt
   *  `"strong"` (zwei exakte Trigger-Terme oder einen seltenen). */
  anchor_strength?: "strong" | "weak";
}

interface RecallResponse {
  hits: RecallHit[];
  vault_size: number;
  latency_ms: number;
  recall_id: string;
  /** #249: no returned hit lexically anchors. Absent means "not weak". */
  weak_result?: boolean;
  /** #230: stricter subset of weak_result — the fact has no home in this vault. */
  no_home?: boolean;
  /** #302: no vector arm, so no RRF ran and the score is raw BM25 — an
   *  unbounded scale with no ceiling. The band cuts describe nothing there. */
  unfused?: boolean;
  /** Codex-Gegenreview: Kennt der VAULT den mitgeschickten Projektnamen als
   *  Scope (oder Familienmitglied)? Nur der Daemon kann das beantworten — die
   *  Lane sieht den Vault nicht. `false` heißt: nicht filtern. */
  project_known?: boolean;
}

type HookStatus =
  | "ok"
  | "no-hits"
  | "skipped"
  | "suppressed"
  | "daemon-unreachable"
  | "timeout"
  | "error";

const SUPPORTED_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);

/**
 * Run the Write/Edit pipeline and return the exact JSON string the thin
 * client writes to stdout. Never throws; every failure degrades to `{}` plus
 * telemetry, matching the CLI's fail-open contract.
 */
export async function runWriteLane(
  payload: WriteHookPayload,
  selfBaseUrl: string,
  vaultRoot: string | null = null,
): Promise<string> {
  const startedAt = Date.now();
  const client = hookClient(payload);

  if (payload.hook_event_name !== "PreToolUse") return "{}";
  const toolName = payload.tool_name ?? "";
  if (!SUPPORTED_TOOLS.has(toolName)) return "{}";

  const toolInput = (payload.tool_input ?? {}) as Record<string, unknown>;
  const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : null;
  if (!filePath) return "{}";

  // Deterministischer Dateigrößen-Check (Daniel 19.07.2026): die
  // Größen-Konvention darf nicht am Memory-Abruf hängen — der Hook hält
  // dem Agenten die Zeilenzahl bei jedem Write/Edit hin. Läuft VOR dem
  // Recall-Call und wird in JEDEM Emit-Pfad mitgesendet. Same-machine
  // assumption is safe: daemon and hook share the filesystem by definition
  // of a loopback-only endpoint.
  const sizeNote = await fileSizeNote(filePath, undefined, payload.cwd).catch(() => null);

  // #297: memory-shaped .md outside the vault root — same discipline as the
  // size note: deterministic, rides through suppression, fail-open. The two
  // combine into one deterministic block for every emit path.
  const locationNote = await memoryLocationNote(filePath, toolInput, vaultRoot).catch(() => null);
  const detNote = [sizeNote, locationNote].filter((n): n is string => n !== null).join("\n") || null;

  const intent = {
    tool_name: toolName,
    file_path: filePath,
    content_excerpt: extractContentExcerpt(toolName, toolInput),
  };
  const topics = detectTopics(intent);
  const cwd = payload.cwd ?? process.cwd();
  const project = detectProject(cwd);
  // §20.5: Der Name, den der Filter benutzen darf, ist NICHT immer der Name,
  // den Query und Anzeige benutzen. `projectForFilter` liefert null, sobald
  // die Erkennung nur geraten war — dann filtert diese Lane nicht, statt auf
  // einem Fallback-Namen eigene Treffer wegzuwerfen.
  const filterProject = projectForFilter(cwd);
  const remainingMs = Math.max(50, HOOK_TIMEOUT_MS - (Date.now() - startedAt));

  // Recall — loopback self-call, any failure → silent degrade.
  let resp: RecallResponse | null = null;
  let status: HookStatus = "ok";
  let errMsg: string | null = null;
  try {
    resp = await postRecall(selfBaseUrl, {
      query: topics.query,
      topics: topics.topics,
      project,
      tool_name: toolName,
      session_id: payload.session_id ?? null,
      tool_input_excerpt: intent.content_excerpt,
      k: 3,
      // #445: die Lane weist sich aus. `pre-tool` ist ihr Allowlist-Wert —
      // sie ist die PreToolUse-Lane für Write/Edit.
      client,
      hook_source: "pre-tool",
    }, remainingMs);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ECONNREFUSED" || e.code === "ENOTFOUND" || e.code === "EHOSTUNREACH") {
      status = "daemon-unreachable";
    } else if (e.message === "timeout") {
      status = "timeout";
    } else {
      status = "error";
      errMsg = e.message ?? String(err);
    }
  }

  // Score-floor filter + Scope-Hard-Filter (#107, #110, #148): Hints aus
  // fremden Projekt-Scopes fliegen raus — seit #110 auch im REQUIRED-Band.
  // #148: nur ein Hit, der auf seinem HAND-geschriebenen recall_when matchte
  // UND im REQUIRED-Band sitzt, passiert cross-scope (passesScopeFilter).
  const aboveFloor: RecallHit[] = [];
  if (resp && Array.isArray(resp.hits)) {
    for (const h of resp.hits) {
      if (h.score < SCORE_FLOOR) continue;
      aboveFloor.push(h);
    }
  }
  // Diese Lane filtert seit #110 hart und tut es weiter — sie läuft deshalb
  // fest im enforce-Modus. Der gemeinsame Pfad bringt ihr zwei Dinge, die sie
  // vorher nicht hatte: die Reflex-Ausnahme und den Beleg-Schutz (ein Filter,
  // der seinen eigenen Projektnamen im Ergebnis nicht wiederfindet, wirft
  // nichts weg). Die Anker-Ausnahme aus #148 bleibt unverändert.
  const scopeFilter = applyLaneScopeFilter(
    aboveFloor,
    filterProject,
    {
      allowAnchoredCrossScope: true,
      mustLoadScore: MUST_LOAD_SCORE,
      unfused: resp?.unfused === true,
      exemptReflex: true,
      projectKnown: resp?.project_known,
    },
    "enforce",
  );
  const filteredHits = scopeFilter.hits;
  const droppedScopeCount = scopeFilter.droppedCount;

  // Per-session dedup (#32). Best-effort throughout — no error in this
  // section ever blocks the response.
  const sessionId = payload.session_id ?? "";
  let sessionState: SessionState = { shown: {} };
  let dedupActive = false;
  if (sessionId) {
    sessionState = await loadSessionState(sessionId);
    dedupActive = true;
  }

  const survivingHits: RecallHit[] = [];
  let droppedDedupCount = 0;
  for (const h of filteredHits) {
    if (!dedupActive) {
      survivingHits.push(h);
      continue;
    }
    const entry = sessionState.shown[h.id];
    const loadedMtime = await getLoadedMarkerMtime(h.id);
    if (shouldDropHit(entry, loadedMtime)) {
      droppedDedupCount++;
      continue;
    }
    survivingHits.push(h);
  }

  // Codex-Gegenreview: Diese Lane teilte rohe BM25-Werte weiter bei 100 in
  // REQUIRED/OPTIONAL — die dritte Stelle derselben P0-Sache, nachdem Prompt-
  // und Todo-Lane sie schon behandeln. Ohne Fusion gibt es keine Bänder: Alle
  // Treffer stehen dann in EINER Liste unter der ehrlichen Überschrift, statt
  // an einer Schwelle geteilt zu werden, die auf dieser Skala nichts bedeutet.
  const unfused = resp?.unfused === true;
  const requiredHits: RecallHit[] = [];
  const optionalHits: RecallHit[] = [];
  for (const h of survivingHits) {
    if (unfused) requiredHits.push(h);
    else if (h.score >= MUST_LOAD_SCORE) requiredHits.push(h);
    else optionalHits.push(h);
  }

  const totalHints = requiredHits.length + optionalHits.length;
  if (resp && totalHints === 0) status = "no-hits";

  const topScore = resp?.hits?.[0]?.score ?? null;

  // Empty-streak backoff (#161): unconsumed injection streaks widen the
  // cadence. REQUIRED-band hits bypass suppression — see decideBackoff.
  let backoffStreak = 0;
  let suppressed = false;
  let suppressedTokensEst = 0;
  let backoffConsumed = false;
  if (dedupActive && totalHints > 0) {
    const entry = sessionState.sources?.[BACKOFF_SOURCE];
    backoffConsumed = await wasEmitConsumed(entry);
    // Der Backoff-Bypass hängt am REQUIRED-Band — das es ohne Fusion nicht
    // gibt. Sonst hörte er genau dann auf zu greifen, wenn der Recall am
    // wenigsten weiß (wortgleich zu prompt-lane.ts).
    const decision = decideBackoff(entry, backoffConsumed, !unfused && requiredHits.length > 0);
    backoffStreak = decision.streak;
    suppressed = decision.suppress;
    if (suppressed) status = "suppressed";
  }

  // Build the stdout document. hint_tokens_est (#72): ~4 chars/token of the
  // actually injected block — the cost side of net-context ROI.
  let hintTokensEst = 0;
  let hintedIds: string[] = [];
  const envelope = (context: string): string =>
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: context,
      },
    });
  let stdout: string;
  if (totalHints === 0) {
    // no recall hints — the deterministic notes (size, #297 location) still go out
    if (detNote) {
      stdout = envelope(detNote);
      hintTokensEst = Math.ceil(detNote.length / 4);
    } else {
      stdout = "{}";
    }
  } else if (suppressed) {
    // Suppression is a recall-noise valve — the deterministic notes are
    // convention enforcement and ride through it.
    if (detNote) {
      stdout = envelope(detNote);
      hintTokensEst = Math.ceil(detNote.length / 4);
    } else {
      stdout = "{}";
    }
    const block = formatHintBlock(requiredHits, optionalHits, project, resp?.weak_result === true, resp?.no_home === true, resp?.unfused === true, client);
    suppressedTokensEst = Math.ceil(block.length / 4);
    recordSourceSuppressed(sessionState, BACKOFF_SOURCE);
  } else {
    const hintsBlock = formatHintBlock(requiredHits, optionalHits, project, resp?.weak_result === true, resp?.no_home === true, resp?.unfused === true, client);
    const block = detNote ? `${detNote}\n${hintsBlock}` : hintsBlock;
    hintTokensEst = Math.ceil(block.length / 4);
    hintedIds = [...requiredHits, ...optionalHits].map((h) => h.id);
    stdout = envelope(block);
    recordSourceEmit(sessionState, BACKOFF_SOURCE, hintedIds, backoffConsumed);
  }

  // Bump shown-counts for everything we surfaced, then persist. When
  // suppressed nothing was shown — only the backoff counter changed.
  if (dedupActive && survivingHits.length > 0) {
    if (!suppressed) {
      const now = Date.now();
      for (const h of survivingHits) bumpShown(sessionState, h.id, now);
    }
    await saveSessionState(sessionId, sessionState);
  }

  // Opportunistic cleanup of stale session files — fire-and-forget.
  if (dedupActive) {
    void cleanupOldStates().catch(() => {});
  }

  await writeTelemetry({
    session_id: sessionId || null,
    tool_name: toolName,
    file_path: filePath,
    topics: topics.topics,
    query_chars: topics.query.length,
    daemon_url: selfBaseUrl,
    daemon_reachable: resp !== null,
    hint_count: suppressed ? 0 : totalHints,
    required_count: suppressed ? 0 : requiredHits.length,
    top_score: topScore,
    latency_ms_total: Date.now() - startedAt,
    dropped_dedup_count: droppedDedupCount,
    dropped_scope_count: droppedScopeCount,
    project_confidence: projectConfidence(cwd),
    filter_project: scopeFilter.filterProject,
    ...(scopeFilter.skipped ? { scope_filter_skipped: scopeFilter.skipped } : {}),
    ...(scopeFilter.droppedScopes.length > 0 ? { dropped_scopes: scopeFilter.droppedScopes } : {}),
    hint_tokens_est: hintTokensEst,
    hinted_ids: hintedIds,
    backoff_streak: backoffStreak,
    suppressed,
    suppressed_tokens_est: suppressedTokensEst,
    status,
    error: errMsg,
  });
  // Usage sidecar (#154): only what was ACTUALLY injected counts as surfaced.
  await reportHinted(selfBaseUrl, hintedIds);

  return stdout;
}

// ─── formatting ─────────────────────────────────────────────────────────────

function formatHintLine(h: RecallHit, hideScore = false): string {
  // Truncate summary to keep total payload small.
  const summary = h.summary.length > 220 ? h.summary.slice(0, 217) + "…" : h.summary;
  // Auf der unfused Skala ist die Zahl weder mit den Bändern noch zwischen
  // zwei Aufrufen vergleichbar — dieselbe Regel wie in den anderen Lanes.
  return hideScore
    ? `- ${h.id} (${h.type}): ${summary}`
    : `- ${h.id} (${h.type}, score ${Math.round(h.score)}): ${summary}`;
}

export function formatHintBlock(
  required: RecallHit[],
  optional: RecallHit[],
  project: string | null,
  weak = false,
  noHome = false,
  unfused = false,
  surface = "claude-code",
): string {
  const projAttr = project ? ` project="${escapeAttr(project)}"` : "";
  const head = `<recall-hints surface="${escapeAttr(surface)}"${projAttr}>`;
  const tail = `</recall-hints>`;
  const sections: string[] = [];

  if (required.length > 0) {
    // #249: on the hybrid path a top score is high BY CONSTRUCTION — a list
    // always has a first element. Calling that "strong" when nothing lexically
    // anchored is the defect this issue is about: the daemon knows, and used to
    // keep it to itself. Annotated rather than omitted, so the agent still sees
    // that a lookup happened and came up empty instead of silently getting less.
    sections.push(
      noHome
        ? `A lookup ran for what you're about to do and this vault has NO memory of ` +
          `it — nothing anchored lexically, and the ranking found no near neighbour ` +
          `either. The lines below are the least-bad rows of an empty result. Treat ` +
          `this as "not written down yet", not as weak evidence, and do not load them.`
        : weak
        ? `Ranked matches for what you're about to do — but NONE of them anchors ` +
          `lexically (no trigger phrase, no title term matched). On the hybrid path a ` +
          `high score is rank-1-of-nothing, so treat these as "probably not relevant" ` +
          `unless one obviously fits. Do not load them just because they are listed.`
        : unfused
        ? `${unfusedHeadline("what you're about to do")} ` +
          `load_memory(id) the ones that bear on this edit.`
        : `${requiredHeadline("what you're about to do", MUST_LOAD_SCORE, { k: RRF_K, scale: RRF_SCALE })} ` +
          `load_memory(id) the ones that bear on this edit. ` +
          `Hints, not obligations: load only what fits, don't batch-load the list.`,
    );
    for (const h of required) sections.push(formatHintLine(h, unfused));
  }

  if (optional.length > 0) {
    if (required.length > 0) sections.push("");
    sections.push(
      unfused
        ? `FURTHER DOWN the same lexical ranking — load only if the title/summary directly relates to the pending change:`
        : // #302: the honest reading of this band. Either one path only — such
          // a hit can never clear MUST_LOAD however well it ranks, since it
          // scores half of a two-armed hit at the same rank — or both paths,
          // but further down than the REQUIRED band demands.
          `OPTIONAL — found by ONE search path only, or by both but ranked lower. ` +
          `Load only if the title/summary directly relates to the pending change:`,
    );
    for (const h of optional) sections.push(formatHintLine(h, unfused));
  }

  // #152: reference-only frame + anti-spoof — vault-derived text (titles,
  // summaries) must not carry marker fragments that break out of the block.
  return [head, HINT_FRAME_NOTE, stripFenceMarkers(sections.join("\n")), tail].join("\n");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── loopback self-call ─────────────────────────────────────────────────────

interface RecallRequestBody {
  query: string;
  topics: string[];
  project: string | null;
  tool_name: string;
  session_id: string | null;
  tool_input_excerpt: string;
  k: number;
  scope?: string;
  /** #445: die Identitätsfelder aus #263 — siehe todo-lane.ts. */
  client: string;
  hook_source: string;
}

function postRecall(
  baseUrl: string,
  body: RecallRequestBody,
  timeoutMs: number,
): Promise<RecallResponse> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL("/hook/recall", baseUrl);
    } catch (err) {
      reject(err);
      return;
    }
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": payload.byteLength.toString(),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(raw) as RecallResponse);
          } catch {
            reject(new Error("invalid JSON response from daemon"));
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ─── telemetry ──────────────────────────────────────────────────────────────

interface HookCallTelemetry {
  session_id: string | null;
  tool_name: string;
  file_path: string | null;
  topics: string[];
  query_chars: number;
  daemon_url: string;
  daemon_reachable: boolean;
  hint_count: number;
  required_count: number;
  top_score: number | null;
  latency_ms_total: number;
  dropped_dedup_count: number;
  dropped_scope_count: number;
  /** §20.5: "root-match" = echtes Repo-Wurzelsegment getroffen, "fallback" =
   *  letztes Pfadsegment geraten (dann filtert die Lane nicht), "none" = kein
   *  Pfad. Ohne dieses Feld ist `dropped_scope_count` nicht interpretierbar. */
  project_confidence?: "git-root" | "root-match" | "fallback" | "none";
  /** Der Name, gegen den verglichen wurde — null heißt: nicht gefiltert.
   *  `project_confidence: "root-match"` allein zeigt nicht, dass irrtümlich
   *  gegen "packages" verglichen wurde; dieses Feld zeigt es. */
  filter_project?: string | null;
  scope_filter_skipped?: "no-project" | "no-scope-evidence";
  dropped_scopes?: string[];
  /** Geschätzte Tokens des injizierten <recall-hints>-Blocks (#72). */
  hint_tokens_est: number;
  /** IDs, die tatsächlich emittiert wurden (#72 context-tax per memory). */
  hinted_ids: string[];
  /** #161: aufgelöster Streak der Backoff-Entscheidung dieses Events. */
  backoff_streak: number;
  /** #161: true, wenn der Backoff die Injektion unterdrückt hat. */
  suppressed: boolean;
  /** #161: Tokens des NICHT injizierten Blocks — die Sparseite der ROI. */
  suppressed_tokens_est: number;
  status: HookStatus;
  error: string | null;
}

async function writeTelemetry(payload: HookCallTelemetry): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    // The session_id from the Claude payload is real session state — fall
    // back to a synthetic UUID only if no payload session was given.
    const { session_id: payloadSessionId, ...rest } = payload;
    const event = {
      kind: "hook_call",
      ts,
      session_id: payloadSessionId ?? randomUUID(),
      hook_version: HOOK_VERSION,
      ...rest,
    };
    const file = join(logDir, `events-${ts.slice(0, 10)}.jsonl`);
    await appendFile(file, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Telemetry must never break the lane.
  }
}
