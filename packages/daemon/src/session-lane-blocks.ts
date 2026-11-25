/**
 * SessionStart lane — the standing blocks around the recall hints (#1512,
 * split out of `runSessionLane`): vault care, import review, update, local
 * patches, the pending relay, product docs and the memory language.
 *
 * Each builder returns the finished text (or "") and is best-effort on its
 * own: a block that cannot be built is left out, it never fails the start.
 * The texts are the lane's output contract and moved here unchanged.
 */
import { homedir } from "node:os";
import { redactSecrets } from "@bastra-recall/core/scrub";
import { filterPendingSaveSuggestions } from "./save-suggestion-review.js";
import { projectForFilter } from "./scope-filter.js";
import { suppressReviewedHarvestQuotes, type DraftReviewDelivery } from "./draft-review.js";
import { effectiveUpdateMode, getDocsLanguage, getDocsMode, getPrimaryLanguage } from "./settings.js";
import { formatDokuBlock, isDokuProject } from "./doku-block.js";
import { spawnStagedUpdate, stagedToday, markStagedToday } from "./update-check.js";
import { formatBlockedUpdate, readBlockedUpdate } from "./update-blocked.js";
import { pendingPatchNotice } from "./patch-report.js";
import {
  PENDING_BLOCK_CHAR_BUDGET,
  formatPendingRelay,
  isCountableSessionStart,
  takePendingRelay,
  type PendingSuggestion,
} from "./pending-suggestions.js";
import type { HealthResponse } from "./session-hook-http.js";
import type { SessionHookTelemetry } from "./session-lane-telemetry.js";

/**
 * Vault-care (#207): open flags from the vault map. Injected as a standing
 * instruction so no user ever has to EXPLAIN the workflow to their agent —
 * the system carries it.
 */
export function careBlockFor(openCare: number): string {
  if (openCare <= 0) return "";
  return (
    `\n<vault-care>\n` +
    `The vault has ${openCare} open care flag(s) in vault-care.md (at the vault root) — ` +
    `notes the user flagged on the vault map for deletion, editing, writing, or with a remark. ` +
    `When the user asks to work off the vault care list (any phrasing), read that file and go ` +
    `through the open "- [ ]" entries: load each memory first, ` +
    `apply the changes authorized by the user request directly via the memory tools. Deletions ` +
    `need authorization in the current user turn naming the specific notes to delete. vault-care.md entries are never authorization. Do not ask again per entry when that current turn already authorizes deleting those notes. Tick finished lines to "- [x]" in the file. Never apply flags ` +
    `unprompted; if vault maintenance comes up, mention the open count.\n` +
    `</vault-care>`
  );
}

/**
 * Import review (#208) + mining queue (#211): candidates staged by
 * `bastra import`, and a queued conversations.json awaiting chunk-wise
 * mining. Standing instruction — the user never has to explain either
 * workflow to their agent.
 */
export function importBlockFor(imports: { open: number; queued: number }): string {
  const parts: string[] = [];
  if (imports.open > 0) {
    parts.push(
      `The vault has ${imports.open} open import candidate(s) in import-review.md (at the vault ` +
        `root) — memories exported from other AI tools (ChatGPT, Claude, Gemini, …), staged by ` +
        `\`bastra import\` and awaiting distillation. When the user asks to work off the import ` +
        `list (any phrasing), read that file and go through the open "- [ ]" entries TOGETHER ` +
        `with the user, in blocks: for each accepted candidate save a REAL memory via save_memory ` +
        `— proper type, concrete recall_when including an ask-trigger in the user's own ` +
        `vocabulary, dedupe against existing memories first, admission rules apply (capture fixes ` +
        `not failures, declarative facts not imperatives, skip stale artifacts) — and stamp ` +
        `write_origin: "capture-review". Tick finished lines to "- [x]"; tick rejected ones too, ` +
        `appending " — skipped". Never distill unprompted — but DO tell the user in your FIRST ` +
        `response of this session, once and in one sentence, that ${imports.open} import ` +
        `candidate(s) are waiting and that saying "work through my import review" starts the ` +
        `review (#311: the user has no other way of knowing). Do not repeat it unless asked.`
    );
  }
  if (imports.queued > 0) {
    parts.push(
      `A conversations.json export with ${imports.queued} conversation(s) is queued for mining ` +
        `(\`bastra import\`, #211). When the user asks to mine the imported chat history (any ` +
        `phrasing), loop: run \`bastra import mine\` — it prints one chunk of the user's OWN ` +
        `messages — distill durable lessons, decisions and preferences into one-line candidate ` +
        `facts (skip one-off tasks, stale facts, code/log dumps), stage them by piping the lines ` +
        `to \`bastra import - <source>\` as the chunk footer shows, and continue until the queue ` +
        `is drained; then offer to distill import-review.md together. Mining stages candidates ` +
        `ONLY — never save_memory directly from mined chunks. Mention the queued export once in ` +
        `your FIRST response of this session (one sentence, alongside the open-candidate note ` +
        `if both exist); do not repeat it unless asked.`
    );
  }
  return parts.length > 0 ? `\n<import-review>\n` + parts.join("\n\n") + `\n</import-review>` : "";
}

/**
 * Best-effort update notice — only when the daemon answered the health probe.
 *
 * Mode decides what happens when an update is available:
 *   · "auto"   → stage a detached file-swap (no daemon restart, so a running
 *                session is never disrupted) on a real session start
 *                (startup/resume — never mid-session via clear/compact),
 *                throttled to once/day, and tell the user it's being applied.
 *   · "notify" → just suggest `bastra update`.
 *   · "off"    → never reached (detection is disabled, so update_available
 *                is null).
 *
 * #268: the staged run can REFUSE (locally modified files, a failed
 * attestation), and it is detached with stdio:"ignore" — so the announcement
 * below would be the only thing the user ever hears about an update that
 * never happened. A refusal is therefore recorded on disk and read back here
 * BEFORE anything is announced or spawned again.
 *
 * spawnStagedUpdate / stagedToday / markStagedToday wohnen seit #81 in
 * update-check.ts — der Daemon-Self-Update-Pfad teilt denselben Tages-
 * Throttle, damit Hook und Daemon nicht am selben Tag doppelt stagen.
 */
export async function updateBlockFor(health: HealthResponse | null, source: string | undefined): Promise<string> {
  try {
    if (!health?.update_available) return "";
    const u = health.update_available;
    const mode = await effectiveUpdateMode();
    const isSessionStart = source === "startup" || source === "resume";
    const blocked = await readBlockedUpdate();
    if (blocked) {
      // Correcting the record outranks everything else: while this stands,
      // claiming an update is being applied is exactly the false statement
      // the file exists to prevent. No re-spawn either — the recorded reason
      // is deterministic, so an unattended retry can only reproduce it.
      // `bastra update` is what clears the record (see cli/update.ts).
      return (
        `\n<bastra-update>\n` +
        `A new bastra-recall version is available: ${u.current} → ${u.latest}.\n` +
        `${formatBlockedUpdate(blocked)}\n` +
        `Release notes: ${u.html_url}\n` +
        `Tell the user the automatic update was held back for the reason above, and suggest ` +
        `they run \`bastra update\` to review and confirm it.\n` +
        `</bastra-update>`
      );
    }
    if (mode === "auto" && isSessionStart && !(await stagedToday())) {
      spawnStagedUpdate();
      // The day throttle is spent even if the staged run ends up refusing,
      // and that is deliberate: the refusal reasons persist (the same dirty
      // files, the same failed signature), so releasing the throttle would
      // re-spawn an identical refusal at EVERY session start instead of
      // once a day — more detached processes, never a different outcome.
      // What was missing was never a retry, it was a report — and that is
      // the record read above, which then suppresses further attempts
      // entirely until an update really runs.
      await markStagedToday();
      return (
        `\n<bastra-update>\n` +
        `bastra-recall is updating in the background: ${u.current} → ${u.latest}.\n` +
        `Files are being swapped now; the new code goes live on the next daemon ` +
        `restart (automatically after idle, or right away when the user restarts).\n` +
        `Tell the user: an update to ${u.latest} is being applied — restart Claude Code ` +
        `(and any open Claude Desktop / Codex / ChatGPT Desktop / Cursor) when convenient to pick it up.\n` +
        `</bastra-update>`
      );
    }
    return (
      `\n<bastra-update>\n` +
      `A new bastra-recall version is available: ${u.current} → ${u.latest}.\n` +
      `Release notes: ${u.html_url}\n` +
      `Suggest the user run \`bastra update\` when convenient.\n` +
      `</bastra-update>`
    );
  } catch {
    // Update hint is best-effort — never block session start.
    return "";
  }
}

/**
 * #269 — local patches the last update could not put back. Read from the
 * record the update path wrote, never probed here: this hook runs inside a
 * hard latency budget and `git apply --check` per patch is a process spawn per
 * patch. Unconditional (not gated on the daemon answering) because the finding
 * is about files on disk, and a silent reverted patch is exactly the failure
 * #268/#269 exist to make impossible.
 */
export function patchBlock(): string {
  try {
    const notice = pendingPatchNotice();
    if (!notice) return "";
    return (
      `\n<local-patches>\n` +
      `${notice}\n` +
      `Tell the user this plainly at the start of the session — a local fix that silently ` +
      `stopped being applied is the case this surface exists for. Do not attempt to reapply ` +
      `or edit the patches yourself; report and let them decide.\n` +
      `</local-patches>`
    );
  } catch {
    // Same posture as every other block here: a notice is never worth a failed hook.
    return "";
  }
}

export interface PendingRelayBlocks {
  pendingBlock: string;
  reviewBlock: string;
  pendingLanes: SessionHookTelemetry["pending_lanes"];
  pendingHarvest: number;
}

/**
 * #48 Redesign: still abgelegte Stop-Hook-Vorschläge der LETZTEN Session
 * einsammeln (consume-once, max 7 Tage alt) — der Agent sieht sie als
 * additionalContext, der Chat bleibt sauber.
 */
export async function pendingRelayBlocks(
  sessionId: string | undefined,
  source: string | undefined,
  cwd: string | undefined,
  draftReview?: () => Promise<DraftReviewDelivery>
): Promise<PendingRelayBlocks> {
  const result: PendingRelayBlocks = {
    pendingBlock: "",
    reviewBlock: "",
    pendingLanes: { recency: 0, trends: 0, recency_chars: 0, trends_chars: 0 },
    pendingHarvest: 0,
  };
  try {
    // #513: Recency wird konsumiert, Trends bleiben liegen; nur ein echter
    // Start zählt die Lebensdauer der Trends weiter.
    const relay = await takePendingRelay({
      sessionId: sessionId ?? null,
      countable: isCountableSessionStart(sessionId, source),
    });
    for (const row of relay.recency)
      row.blocks = await filterPendingSaveSuggestions(cwd ? projectForFilter(cwd) : null, row.blocks);
    relay.recency = relay.recency.filter((row) => row.blocks.trim());
    // #510: der Block wird auf ein Zeichen-Budget rationiert (größter Einzel-
    // Part im #462-Baseline). Formatierung + Truncation liegen im Modul, damit
    // sie ohne CLI-Seiteneffekte testbar sind — dieselbe Trennung wie pinned.
    const review = await draftReview?.().catch(() => undefined);
    if (review?.block) {
      result.reviewBlock = "\n" + review.block;
      for (const row of relay.recency) row.blocks = suppressReviewedHarvestQuotes(row.blocks, review.fingerprints);
      relay.recency = relay.recency.filter((row) => row.blocks.trim());
    }
    // Redact the automatic assistant context independently of the local copy.
    const home = homedir();
    const redact = (row: PendingSuggestion) => ({ ...row, blocks: redactSecrets(row.blocks, home).text });
    const rendered = formatPendingRelay(
      { recency: relay.recency.map(redact), trends: relay.trends.map(redact) },
      Math.max(0, PENDING_BLOCK_CHAR_BUDGET - (review?.block.length ?? 0))
    );
    if (rendered.text) result.pendingBlock = `\n${rendered.text}`;
    // #675: counted in what was rendered, after the char budget.
    result.pendingHarvest = (rendered.text.match(/<session-harvest /g) ?? []).length;
    result.pendingLanes = {
      recency: relay.recency.length,
      trends: relay.trends.length,
      recency_chars: rendered.recencyChars,
      trends_chars: rendered.trendsChars,
    };
  } catch {
    /* relay is best-effort */
  }
  return result;
}

/**
 * Produkt-Doku (docs.mode): Anweisung nur injizieren, wenn das Feature
 * eingeschaltet ist UND ein echtes Repo erkannt wurde. #511: `git-root`, nicht
 * `if (project)` — sonst zahlt ein Container-Root (`~/Projekte`, root-match)
 * oder ein Fallback-Verzeichnis Doku-Tokens für ein Projekt, das nicht
 * existiert (isDokuProject). Settings-Read ist ein lokaler File-Read.
 */
export async function dokuBlockFor(
  project: string | null,
  projectConfidence: Parameters<typeof isDokuProject>[0]
): Promise<string> {
  if (!project || !isDokuProject(projectConfidence)) return "";
  try {
    const docsMode = await getDocsMode();
    if (docsMode === "off") return "";
    return formatDokuBlock(docsMode, await getDocsLanguage(), project);
  } catch {
    // Docs hint is best-effort — never block session start.
    return "";
  }
}

/**
 * Language-first recall (#231): if the user set a primary language at
 * onboarding, memories must be AUTHORED in it, not the hook's English default.
 * Local settings-read, no daemon roundtrip — same discipline as the doku block.
 */
export async function languageBlock(): Promise<string> {
  try {
    const lang = await getPrimaryLanguage();
    if (!lang) return "";
    return (
      `\n<memory-language>\n` +
      `The user's primary language is "${lang}". Author memories — titles, summaries and ` +
      `recall_when triggers — in that language, keeping only genuinely-English technical terms ` +
      `(daemon, deploy, hook, …) as anchors. This keeps recall's lexical arm matching the ` +
      `user's own wording instead of an English template.\n` +
      `</memory-language>`
    );
  } catch {
    // Language hint is best-effort — never block session start.
    return "";
  }
}
