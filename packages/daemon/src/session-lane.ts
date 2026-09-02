/**
 * SessionStart lane, daemon-side (#369/#15 — the #343/#344 pattern, applied to the
 * lane that greets every new session).
 *
 * Preloads the most relevant memorys for a fresh Claude Code session as
 * `additionalContext` so the model knows who the user is, what project they're
 * in, and what cross-project rules apply, before the first user prompt
 * arrives. The pipeline moved here verbatim from `session-hook.ts`, which is a
 * thin client now — stdin -> POST /hook/session -> stdout.
 *
 * Pipeline:
 *   payload (Claude-Code SessionStart)
 *     → detectProject(cwd)
 *     → 3 scope-filtered self-calls to /hook/recall
 *         · scope=user-preference  k=3   query="session-start preferences"
 *         · scope=<project>        k=3   query="<project> active context"
 *         · scope=all-projects     k=2   query="cross-project working rules"
 *     → merge by score, drop dups, format as <session-context>…</session-context>
 *     → /hook/floors (#141/#142): floored memories as a <pinned-memories>
 *       block BEFORE the score-gated hints — push-by-state, never relevance-
 *       gated, never dropped by any dedup
 *     → returns: {"hookSpecificOutput": { hookEventName, additionalContext }}
 *
 * Why the move pays twice here: the client stopped paying ~78ms of node start
 * (#305/#369), and the up-to-seven sequential loopback round trips below now
 * run from inside the server that answers them. They stay HTTP self-calls on
 * purpose — same reason as prompt-lane.ts: collapsing them into direct calls
 * would change what the existing telemetry series measures mid-migration.
 *
 * Discipline unchanged: hard wall-clock budget, fail-silent on every error
 * path, telemetry best-effort.
 */
// #305: subpath leafs, never the core barrel — measured +40ms of process
// start against +0.8ms for the three leafs, on a fresh spawn per event.
import { detectProject } from "@bastra-recall/core/topics";
import { RRF_K, RRF_SCALE } from "@bastra-recall/core/rrf";
import { bandHits, requiredHeadline, unfusedHeadline } from "./band-wording.js";
import { isUnfused } from "./hook-recall-response.js";
import { HINT_FRAME_NOTE, stripFenceMarkers } from "@bastra-recall/core/scrub";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { envFirst, envInt } from "./env.js";
import { effectiveUpdateMode, getDocsLanguage, getDocsMode, getPrimaryLanguage } from "./settings.js";
import { formatDokuBlock } from "./doku-block.js";
import { defaultLogDir } from "./telemetry.js";
import { spawnStagedUpdate, stagedToday, markStagedToday } from "./update-check.js";
import { formatBlockedUpdate, readBlockedUpdate } from "./update-blocked.js";
import { pendingPatchNotice } from "./patch-registry.js";
import { consumePendingSuggestions } from "./pending-suggestions.js";
import { clearShown } from "./session-state.js";
import { formatPinnedBlock, dropPinnedFromRanked, type PinnedFloorLean } from "./pinned-block.js";
import { reportHinted } from "./hook-hinted.js";
import { hookClient } from "./hook-surface.js";
import {
  postSessionContext, probeHealth,
  type ConventionLean, type RecallHit, type RecallResponse, type SessionContextResponse,
} from "./session-hook-http.js";

const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", 500, "NEXUS_HOOK_TIMEOUT_MS");
const HOOK_VERSION = "0.3.0";
const SCORE_FLOOR = 30;
const MUST_LOAD_SCORE = 100;
const TOTAL_HINTS_CAP = 7;

export interface SessionPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: "startup" | "resume" | "clear" | "compact";
}

/**
 * Run the SessionStart pipeline and return the exact JSON string the thin
 * client writes to stdout. Never throws; every failure degrades to `{}` plus
 * telemetry, matching the CLI's fail-open contract.
 */
export async function runSessionLane(
  payload: SessionPayload,
  selfBaseUrl: string,
): Promise<string> {
  const startedAt = Date.now();
  const client = hookClient(payload);

  if (payload.hook_event_name !== "SessionStart") return "{}";

  // #354: compact/clear/resume keep the session id but rebuild the transcript,
  // so every hint the per-session dedup was holding back is gone from the
  // context. Verified over all Aug/Sep session starts: ids like 01a05b6f carry
  // `startup,compact,compact`. Releasing the counters here is what lets the 4h
  // window go — it was the only thing covering this case, and it paid for that
  // coverage with a re-injection into every session that merely ran long.
  // "startup" is a fresh id and needs nothing; best-effort, never blocking.
  if (payload.source === "compact" || payload.source === "clear" || payload.source === "resume") {
    try {
      await clearShown(payload.session_id ?? "");
    } catch {
      /* dedup is best-effort by construction — a stale counter costs tokens, not correctness */
    }
  }

  const project = detectProject(payload.cwd ?? process.cwd());
  // The self-call target is passed in by the route (this server's own
  // address), not read from the environment: the lane IS the daemon.
  const url = selfBaseUrl;

  const queries: Array<{ scope: string; query: string; k: number }> = [
    { scope: "user-preference", query: "session-start preferences active context", k: 3 },
    { scope: "all-projects", query: "cross-project working rules", k: 2 },
  ];
  if (project) {
    queries.push({ scope: project, query: `${project} active context project-facts decisions`, k: 3 });
  }

  let status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error" = "ok";
  let errMsg: string | null = null;
  const responses: Array<{ scope: string; resp: RecallResponse | null }> = [];
  const recallByScope = new Map<string, RecallResponse | null>();

  // #265/§26.1: EIN Aufruf gegen den projektbewussten Assembler statt sechs
  // einzelner Loopback-Requests. Der Assembler erhebt Recalls, Floors,
  // Taxonomie, Care, Import und Onboarding serverseitig und nebenläufig — und
  // fährt dabei DIESELBE Recall-Pipeline wie `/hook/recall` (Scope-Filter
  // #110/#148, Reflex-Hits, Router-Schatten #362), weshalb die Trefferauswahl
  // dieselbe bleibt.
  //
  // Was der Assembler nicht abdeckt, bleibt hier: der Health-Probe für den
  // Update-Block, Doku, Pending, Patch — und das gesamte Rendern. Die Lane
  // bandet und formuliert selbst; sie holt Daten, keine fertigen Zeilen.
  let sideData: SessionContextResponse["data"] = undefined;
  // Der Health-Probe gehört zum Update-Block, den der Assembler nicht abdeckt —
  // er hängt aber an keiner seiner Ausgaben. Also läuft er NEBEN dem
  // Assembler-Aufruf und nicht danach; sonst hätte der Umbau die Nebenläufigkeit
  // aus Teilpaket 1 gegen einen zweiten Round Trip eingetauscht.
  const probeBudget = Math.min(200, Math.max(80, HOOK_TIMEOUT_MS - (Date.now() - startedAt)));
  const healthPromise = probeHealth(url, probeBudget).catch(() => null);
  {
    const remainingMs = Math.max(60, HOOK_TIMEOUT_MS - (Date.now() - startedAt));
    try {
      const resp = await postSessionContext(
        url,
        {
          project,
          source: payload.source ?? null,
          session_id: payload.session_id ?? null,
          client,
          // Nur die Lane fragt die Cross-Project-Regeln.
          cross_project: true,
          // Die Mengen dieses Dokuments, ausdrücklich gesetzt: Der Endpunkt hat
          // eigene Vorgaben (4 Konventionen, 5 Floors), und ein Umzug ohne
          // diese Zeilen wäre eine stille Produktänderung. `0` = ungekappt.
          caps: { conventions: 6, pinned: 0 },
          budget: { time_ms: remainingMs },
        },
        remainingMs,
      );
      sideData = resp.data;
      for (const r of resp.data?.recalls ?? []) {
        recallByScope.set(r.scope, r.resp ?? null);
      }
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
  }
  // Die Reihenfolge ist Priorität für `mergeSessionHits` — sie kommt aus
  // `queries` und nicht aus der Antwort, deren Reihenfolge den Assembler
  // beschreibt, nicht diese Lane.
  for (const q of queries) responses.push({ scope: q.scope, resp: recallByScope.get(q.scope) ?? null });

  // P0: Der Score-Modus gilt für den GANZEN Block, und zwar fail-closed —
  // sobald EINE der (bis zu drei) Antworten unfusioniert ist, sind die Zahlen
  // untereinander nicht mehr vergleichbar. Nachgestellt: bei einem rohen
  // BM25-Score von 405585 behauptete diese Lane „Both search paths agreed …
  // score ≥100", obwohl genau ein Pfad lief.
  const unfused = responses.some((r) => r.resp !== null && isUnfused(r.resp));
  const merged = mergeSessionHits(responses, unfused, SCORE_FLOOR);

  // #265: Die sechs Seitenabrufe hängen an keiner Recall-AUSGABE — nur daran,
  // DASS der Daemon antwortet. Sequenziell summierten sich ihre Budgets auf bis
  // zu 150+150+150+150+150+200 ms; nebeneinander zählt der langsamste.
  //
  // Jeder Abruf bekommt seinen eigenen Fallback statt eines gemeinsamen
  // try/catch: Ein fehlgeschlagener Taxonomie-Abruf darf den Floors-Block nicht
  // mitreißen. Dieselbe fail-open-Disziplin wie vorher, nur pro Teil statt pro
  // Kette.
  // #265: Floors, Taxonomie, Care, Import und Onboarding kamen mit derselben
  // Antwort — kein eigener Abruf mehr. Der Health-Probe bleibt: Er gehört zum
  // Update-Block, den der Assembler nicht abdeckt.
  const reachable = responses.some((r) => r.resp !== null);
  const floorsFetched = sideData?.floors ?? [];
  const conventionsFetched = sideData?.conventions ?? [];
  const careCounts = sideData?.care ?? { open: 0, queued: 0 };
  const importCounts = sideData?.imports ?? { open: 0, queued: 0 };
  const onboardingNeeded = sideData?.onboarding ?? false;
  const health = reachable ? await healthPromise : null;

  // Floor-Registry (#141/#142): gepinnte Memories — push-by-state, bewusst
  // NICHT score-gated (gleiches Muster wie der Taxonomie-Block: dedizierter
  // Listen-Endpoint statt Recall-Suche; ein Constraint darf nicht am Floor
  // sterben, dessen Job es ist, präsent zu sein, wenn der Turn ihn nicht für
  // relevant hält). Dedup-Verifikation: der Session-Hook wendet KEINEN
  // session-state-Dedup an (shouldDropHit lebt ausschließlich im PreToolUse-
  // Hook, hook.ts) — gepinnte Einträge können hier also nie weggededupt
  // werden. Der einzige Dedup läuft in die GEGENrichtung: dropPinnedFromRanked
  // entfernt ranked-Duplikate, damit die Hint-Liste kein Budget doppelt auf
  // bereits garantierte Einträge ausgibt.
  let pinned: PinnedFloorLean[] = floorsFetched;
  // Ohne erkanntes Projekt injizieren nur globale (unscoped) Floors —
  // fremd-gescopte Einträge wären in einer projektlosen Session Rauschen.
  if (!project) pinned = pinned.filter((e) => !e.scope);
  const pinnedBlock = formatPinnedBlock(pinned);
  const top = dropPinnedFromRanked(merged, pinned).slice(0, TOTAL_HINTS_CAP);

  // Taxonomie-Konventionen (#66): bindende, selbst-gelernte Struktur-Regeln
  // des Vaults. Dedizierter Listen-Endpoint statt Recall-Suche — Konventionen
  // konkurrieren nicht über Scores und dürfen nicht am Floor sterben.
  const conventions: ConventionLean[] = conventionsFetched;
  const taxonomyBlock = formatTaxonomyBlock(conventions);

  // Vault-care (#207): open flags from the vault map. Injected as a standing
  // instruction so no user ever has to EXPLAIN the workflow to their agent —
  // the system carries it.
  let careBlock = "";
  {
    const openCare = careCounts.open;
    if (openCare > 0) {
      careBlock =
        `\n<vault-care>\n` +
        `The vault has ${openCare} open care flag(s) in vault-care.md (at the vault root) — ` +
        `notes the user flagged on the vault map for deletion, editing, writing, or with a remark. ` +
        `When the user asks to work off the vault care list (any phrasing), read that file and go ` +
        `through the open "- [ ]" entries TOGETHER with the user: load and show each memory first, ` +
        `propose the change, apply it via the memory tools only after their go — deletions always ` +
        `need explicit confirmation. Tick finished lines to "- [x]" in the file. Never apply flags ` +
        `unprompted; if vault maintenance comes up, mention the open count.\n` +
        `</vault-care>`;
    }
  }

  // Import review (#208) + mining queue (#211): candidates staged by
  // `bastra import`, and a queued conversations.json awaiting chunk-wise
  // mining. Standing instruction — the user never has to explain either
  // workflow to their agent.
  let importBlock = "";
  {
    const imports = importCounts;
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
          `review (#311: the user has no other way of knowing). Do not repeat it unless asked.`,
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
          `if both exist); do not repeat it unless asked.`,
      );
    }
    if (parts.length > 0) {
      importBlock = `\n<import-review>\n` + parts.join("\n\n") + `\n</import-review>`;
    }
  }

  // Onboarding interview: a fresh vault (few memories, no marker) gets a
  // standing offer to seed itself — the session model interviews adaptively,
  // which no form can. Offered, never pushed.
  let onboardingBlock = "";
  {
    if (onboardingNeeded) {
      onboardingBlock =
        `\n<vault-onboarding>\n` +
        `This vault is fresh and the onboarding interview hasn't run. Offer it ONCE at a natural ` +
        `moment (e.g. after the first task, or right away if the user seems to be exploring): a ` +
        `~5-minute interview that seeds the vault with who the user is. If they agree, interview ` +
        `adaptively — one question at a time, follow up where an answer is thin, let them skip ` +
        `anything: (1) what the memory will mainly hold — code & projects / company & decisions / ` +
        `personal life & knowledge / a mix; (2) how to address them — name, language, tone; ` +
        `(3) hard always/never rules; (4-6) persona follow-ups (developer: stack, active projects, ` +
        `workflow, coding conventions — file-size guide value in lines + which folder holds what · ` +
        `business: company & role, key people, what to prepare or watch · personal: ` +
        `day-to-day world, never-forget items, current goals · mixed: stack, role, world); ` +
        `(7) anything else, freeform. Save each answer immediately via save_memory — the user ` +
        `answered in person, so write_origin: "user-directed", concrete recall_when triggers ` +
        `including an ask-trigger in the user's own words. If they name a file-size guide value, ` +
        `ALSO run \`bastra config set size.guide <N>\` — the PreToolUse hook then enforces it ` +
        `deterministically. If you can tell the user's primary language (from how they answer, or ` +
        `an explicit "in <language>"), ALSO run \`bastra config set language.primary <code>\` ` +
        `(2-letter ISO code) so future memories get authored in it. When finished run \`bastra onboard done\`; ` +
        `if the user declines run \`bastra onboard skip\` and never bring it up again. Also mention ` +
        `\`bastra import\` if they have memories in other AI tools.\n` +
        `</vault-onboarding>`;
    }
  }

  // Best-effort update probe — only when we already have a daemon reachable.
  // Strict budget: 200 ms; if nothing back, we just skip the block.
  //
  // Mode decides what happens when an update is available:
  //   · "auto"   → stage a detached file-swap (no daemon restart, so a running
  //                session is never disrupted) on a real session start
  //                (startup/resume — never mid-session via clear/compact),
  //                throttled to once/day, and tell the user it's being applied.
  //   · "notify" → just suggest `bastra update`.
  //   · "off"    → never reached (detection is disabled, so update_available
  //                is null).
  //
  // #268: the staged run can REFUSE (locally modified files, a failed
  // attestation), and it is detached with stdio:"ignore" — so the announcement
  // below would be the only thing the user ever hears about an update that
  // never happened. A refusal is therefore recorded on disk and read back here
  // BEFORE anything is announced or spawned again.
  let updateBlock = "";
  {
    try {
      if (health?.update_available) {
        const u = health.update_available;
        const mode = await effectiveUpdateMode();
        const isSessionStart = payload.source === "startup" || payload.source === "resume";
        const blocked = await readBlockedUpdate();
        if (blocked) {
          // Correcting the record outranks everything else: while this stands,
          // claiming an update is being applied is exactly the false statement
          // the file exists to prevent. No re-spawn either — the recorded reason
          // is deterministic, so an unattended retry can only reproduce it.
          // `bastra update` is what clears the record (see cli/update.ts).
          updateBlock =
            `\n<bastra-update>\n` +
            `A new bastra-recall version is available: ${u.current} → ${u.latest}.\n` +
            `${formatBlockedUpdate(blocked)}\n` +
            `Release notes: ${u.html_url}\n` +
            `Tell the user the automatic update was held back for the reason above, and suggest ` +
            `they run \`bastra update\` to review and confirm it.\n` +
            `</bastra-update>`;
        } else if (mode === "auto" && isSessionStart && !(await stagedToday())) {
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
          updateBlock =
            `\n<bastra-update>\n` +
            `bastra-recall is updating in the background: ${u.current} → ${u.latest}.\n` +
            `Files are being swapped now; the new code goes live on the next daemon ` +
            `restart (automatically after idle, or right away when the user restarts).\n` +
            `Tell the user: an update to ${u.latest} is being applied — restart Claude Code ` +
            `(and any open Claude Desktop / Codex / ChatGPT Desktop / Cursor) when convenient to pick it up.\n` +
            `</bastra-update>`;
        } else {
          updateBlock =
            `\n<bastra-update>\n` +
            `A new bastra-recall version is available: ${u.current} → ${u.latest}.\n` +
            `Release notes: ${u.html_url}\n` +
            `Suggest the user run \`bastra update\` when convenient.\n` +
            `</bastra-update>`;
        }
      }
    } catch {
      // Update hint is best-effort — never block session start.
    }
  }

  // #269 — local patches the last update could not put back. Read from the
  // record the update path wrote, never probed here: this hook runs inside a
  // hard latency budget and `git apply --check` per patch is a process spawn per
  // patch. Unconditional (not gated on the daemon answering) because the finding
  // is about files on disk, and a silent reverted patch is exactly the failure
  // #268/#269 exist to make impossible.
  let patchBlock = "";
  try {
    const notice = pendingPatchNotice();
    if (notice) {
      patchBlock =
        `\n<local-patches>\n` +
        `${notice}\n` +
        `Tell the user this plainly at the start of the session — a local fix that silently ` +
        `stopped being applied is the case this surface exists for. Do not attempt to reapply ` +
        `or edit the patches yourself; report and let them decide.\n` +
        `</local-patches>`;
    }
  } catch {
    // Same posture as every other block here: a notice is never worth a failed hook.
  }

  // #48 Redesign: still abgelegte Stop-Hook-Vorschläge der LETZTEN Session
  // einsammeln (consume-once, max 7 Tage alt) — der Agent sieht sie als
  // additionalContext, der Chat bleibt sauber.
  let pendingBlock = "";
  try {
    const pending = await consumePendingSuggestions();
    if (pending.length > 0) {
      pendingBlock =
        `\n<pending-save-suggestions source="stop-hook">\n` +
        `From earlier session(s) — evaluate silently, save via bastra-recall:save_memory only what genuinely qualifies:\n` +
        pending.map((p) => p.blocks).join("\n") +
        `\n</pending-save-suggestions>`;
    }
  } catch {
    /* relay is best-effort */
  }

  // Produkt-Doku (docs.mode): Anweisung nur injizieren, wenn das Feature
  // eingeschaltet ist UND ein Projekt erkannt wurde (Doku ist per-project).
  // Settings-Read ist ein lokaler File-Read — kein Daemon-Roundtrip nötig.
  let dokuBlock = "";
  if (project) {
    try {
      const docsMode = await getDocsMode();
      if (docsMode !== "off") {
        dokuBlock = formatDokuBlock(docsMode, await getDocsLanguage(), project);
      }
    } catch {
      // Docs hint is best-effort — never block session start.
    }
  }

  // Language-first recall (#231): if the user set a primary language at
  // onboarding, memories must be AUTHORED in it, not the hook's English default.
  // Local settings-read, no daemon roundtrip — same discipline as dokuBlock.
  let languageBlock = "";
  try {
    const lang = await getPrimaryLanguage();
    if (lang) {
      languageBlock =
        `\n<memory-language>\n` +
        `The user's primary language is "${lang}". Author memories — titles, summaries and ` +
        `recall_when triggers — in that language, keeping only genuinely-English technical terms ` +
        `(daemon, deploy, hook, …) as anchors. This keeps recall's lexical arm matching the ` +
        `user's own wording instead of an English template.\n` +
        `</memory-language>`;
    }
  } catch {
    // Language hint is best-effort — never block session start.
  }

  const extras = taxonomyBlock + languageBlock + careBlock + importBlock + onboardingBlock + updateBlock + patchBlock + pendingBlock + dokuBlock;
  // #141/#142: der Pinned-Block steht VOR den score-gated Hints — die
  // garantierten Einträge zuerst, die relevanz-gerankte Liste dahinter.
  const pinnedHead = pinnedBlock === "" ? "" : pinnedBlock + "\n";
  // hint_tokens_est (#72): Token-Schätzung des injizierten Kontexts.
  let injected = "";
  let out = "{}";
  if (top.length === 0 && pinnedBlock === "" && extras === "") {
    if (status === "ok") status = "no-hits";
    // stays "{}"
  } else if (top.length === 0) {
    // Only pinned entries, conventions and/or an update banner, no recall hits.
    injected = (pinnedBlock + extras).trimStart();
    out = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: injected,
      },
    });
  } else {
    // #249: three scope-filtered recalls feed this block. Weak only when EVERY
    // answered one is weak — a single lexically anchored scope means there is
    // real signal here, and framing the whole block as noise would hide it.
    const answered = responses.filter((r) => r.resp !== null);
    const allWeak = answered.length > 0 && answered.every((r) => r.resp!.weak_result === true);
    injected = pinnedHead + formatBlock(top, project, payload.source ?? null, allWeak, unfused, client) + extras;
    out = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: injected,
      },
    });
  }

  await writeTelemetry({
    session_id: payload.session_id ?? null,
    source: payload.source ?? null,
    project,
    queries: queries.length,
    daemon_url: url,
    daemon_reachable: responses.some((r) => r.resp !== null),
    hint_count: top.length,
    convention_count: conventions.length,
    pinned_count: pinned.length,
    top_score: top[0]?.score ?? null,
    latency_ms_total: Date.now() - startedAt,
    hint_tokens_est: Math.ceil(injected.length / 4),
    hinted_ids: top.map((h) => h.id),
    hinted_types: top.map((h) => h.type),
    status,
    error: errMsg,
  });
  // Usage sidecar (#154): only what was ACTUALLY injected counts as surfaced.
  await reportHinted(url, top.map((h) => h.id));
  return out;
}

/**
 * Dedup + Reihenfolge über die (bis zu drei) scope-gefilterten Antworten.
 *
 * P0: `unfused` entscheidet, ob überhaupt gerechnet werden darf. Fusioniert
 * bleibt alles wie bisher — gemeinsame Skala, Floor, absteigend sortiert.
 * Unfusioniert stammen die Zahlen aus einer offenen Skala und aus getrennten
 * Aufrufen: 405585 schlägt 160 immer, ohne besser zu sein. Dann wird REIHUM
 * genommen, jede Query behält ihren eigenen Rang, und der Floor entfällt, weil
 * 30 auf dieser Skala keinen Punkt markiert.
 */
export function mergeSessionHits(
  responses: Array<{ scope: string; resp: { hits: RecallHit[] } | null }>,
  unfused: boolean,
  floor: number,
): RecallHit[] {
  const seen = new Set<string>();
  const lists = responses.filter((r) => r.resp !== null).map((r) => r.resp!.hits);

  if (unfused) {
    const merged: RecallHit[] = [];
    const depth = Math.max(0, ...lists.map((l) => l.length));
    for (let i = 0; i < depth; i++) {
      for (const list of lists) {
        const h = list[i];
        if (!h || seen.has(h.id)) continue;
        seen.add(h.id);
        merged.push(h);
      }
    }
    return merged;
  }

  const merged: RecallHit[] = [];
  for (const list of lists) {
    for (const h of list) {
      if (h.score < floor) continue;
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      merged.push(h);
    }
  }
  merged.sort((a, b) => b.score - a.score);
  return merged;
}

export function formatBlock(
  hits: RecallHit[],
  project: string | null,
  source: string | null,
  weak = false,
  unfused = false,
  surface = "claude-code",
): string {
  const projAttr = project ? ` project="${escapeAttr(project)}"` : "";
  const srcAttr = source ? ` source="${escapeAttr(source)}"` : "";
  const head = `<session-context surface="${escapeAttr(surface)}"${projAttr}${srcAttr}>`;
  const tail = `</session-context>`;

  // P0: zentrale Bandzuweisung. Ohne Fusion vergibt sie kein Band — die Cuts
  // 30/100 sind Punkte auf der Rang-Summen-Skala und selektieren auf rohen
  // BM25-Werten nichts.
  const { required, optional, unbanded } = bandHits(hits, MUST_LOAD_SCORE, unfused);
  const sections: string[] = [];

  if (unbanded.length > 0) {
    sections.push(
      `${unfusedHeadline(`the ${project ?? "current"} session`)} ` +
        `load_memory(id) the ones relevant to what the user actually asks for. ` +
        `These are hints, not obligations.`,
    );
    for (const h of unbanded) sections.push(formatHintLine(h, true));
  }

  if (required.length > 0) {
    // #249: see hook.ts — the honesty flag decides how this block is framed.
    sections.push(
      weak
        ? `Ranked matches, but NONE anchors lexically (no trigger phrase, no title term matched) — on the hybrid path a high score is rank-1-of-nothing. Treat these as probably-not-relevant unless one obviously fits; do not load them just because they are listed.`
        : `${requiredHeadline(`the ${project ?? "current"} session`, MUST_LOAD_SCORE, { k: RRF_K, scale: RRF_SCALE })} ` +
          `load_memory(id) the ones relevant to what the user actually asks for. ` +
          `These are hints, not obligations: load only what fits, don't batch-load the list, ` +
          `and if the user requested a specific number or scope, honor that over this list.`,
    );
    for (const h of required) sections.push(formatHintLine(h));
  }

  if (optional.length > 0) {
    if (required.length > 0) sections.push("");
    sections.push(
      `OPTIONAL (score ${SCORE_FLOOR}–${MUST_LOAD_SCORE - 1}) — load only when the user prompt directly touches the topic:`,
    );
    for (const h of optional) sections.push(formatHintLine(h));
  }

  return [head, HINT_FRAME_NOTE, stripFenceMarkers(sections.join("\n")), tail].join("\n");
}

function formatHintLine(h: RecallHit, hideScore = false): string {
  const summary = h.summary.length > 220 ? h.summary.slice(0, 217) + "…" : h.summary;
  // P0: Auf der unfused Skala ist die Zahl weder mit den Bändern noch zwischen
  // zwei Aufrufen vergleichbar — gleiche Wahl wie in prompt-lane.ts.
  return hideScore
    ? `- ${h.id} (${h.type}/${h.scope}): ${summary}`
    : `- ${h.id} (${h.type}/${h.scope}, score ${Math.round(h.score)}): ${summary}`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Konventions-Block (#66). Kompakt: Titel + Summary pro Konvention, dazu die
 * Anweisung, sie beim Speichern zu BEFOLGEN (Details via load_memory). Cap 6 —
 * mehr Konventionen heißt das Vault braucht eher eine Meta-Aufräumrunde als
 * mehr Kontext.
 */
function formatTaxonomyBlock(conventions: ConventionLean[]): string {
  if (conventions.length === 0) return "";
  // #152: anti-spoof strip only — deliberately NO reference-only note here,
  // conventions are meant to be BINDING instructions.
  const lines = conventions
    .slice(0, 6)
    .map((c) => stripFenceMarkers(`- [${c.id}] ${c.title}: ${c.summary}`));
  return (
    `\n<vault-taxonomy>\n` +
    `Self-learned vault conventions — BINDING when saving memories in these clusters. ` +
    `Follow the convention's folder/topic_path/tags exactly (load_memory(id) for the full rule) ` +
    `instead of inventing variant tags that fragment recall:\n` +
    lines.join("\n") +
    // #232: the gate carries the read-hint for its own reference file. Applying
    // a listed convention needs nothing extra; establishing a new one does, and
    // this block is the only moment that distinction is visible.
    `\nSaving into a recurring cluster that NO convention above covers is the ` +
    `establish case — read the skill's taxonomy.md before inventing a home for it.` +
    `\n</vault-taxonomy>`
  );
}

// spawnStagedUpdate / stagedToday / markStagedToday wohnen seit #81 in
// update-check.ts — der Daemon-Self-Update-Pfad teilt denselben Tages-
// Throttle, damit Hook und Daemon nicht am selben Tag doppelt stagen.

interface SessionHookTelemetry {
  /** #356: the Claude Code session this call belongs to — the payload's
   *  session_id, so per-session aggregation is possible. A synthetic UUID is
   *  the fallback only when the payload carried none. */
  session_id?: string | null;
  source: string | null;
  project: string | null;
  queries: number;
  daemon_url: string;
  daemon_reachable: boolean;
  hint_count: number;
  convention_count: number;
  /** Gepinnte Floor-Einträge im <pinned-memories>-Block (#141/#142). */
  pinned_count: number;
  top_score: number | null;
  latency_ms_total: number;
  /** Geschätzte Tokens des injizierten Session-Kontexts (#72). */
  hint_tokens_est: number;
  hinted_ids: string[];
  /** #354: Memory-Typ je `hinted_ids`-Eintrag, gleiche Reihenfolge. */
  hinted_types: string[];
  status: "ok" | "no-hits" | "daemon-unreachable" | "timeout" | "error";
  error: string | null;
}

async function writeTelemetry(payload: SessionHookTelemetry): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    // The session_id from the Claude payload is real session state — fall
    // back to a synthetic UUID only if no payload session was given (#356).
    const { session_id: payloadSessionId, ...rest } = payload;
    const event = {
      kind: "session_hook_call",
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
