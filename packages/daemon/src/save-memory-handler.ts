/**
 * save_memory handler — the write path of the memory tools (#150/#205/#477/#544).
 * Split out of tool-handlers.ts (#680, file-size convention); tool-handlers
 * re-exports everything, so the existing import paths keep working.
 */
import {
  saveMemory,
  mutateMemoryFile,
  resolveMemoryTarget,
  SaveMemoryInput,
  assertBodyTail,
  BodySentinelError,
} from "@bastra-recall/core";
import { fireAndForget } from "./telemetry.js";
import type { SaveHoldEvent } from "./telemetry-events.js";
import { recordAudit } from "./audit-trail.js";
import { markConflict } from "./conflict-marking.js";
import { claimGateResult, unansweredClaims, GENERATED_TRIGGER_TYPES, type ClaimGateResult } from "./claim-gate.js";

import type { ToolDeps } from "./tool-deps.js";
import { hiddenFromCaller, hiddenOnDisk, type PrivateAccess } from "./private-access.js";
import { vaultLocator } from "./vault-locator.js";
import { scoreSaveQuality, type SaveQualityResult } from "./save-quality.js";
import { MEMORY_TOOL_DEFS } from "./tool-defs-memory.js";
import {
  callCorruptionMessage,
  detectCallCorruption,
  repairCallCorruption,
  requiredFieldsOf,
} from "./call-corruption.js";

// ─── Save Memory ─────────────────────────────────────────────────

export interface SaveMemoryResult {
  id: string;
  file_path: string;
  created: boolean;
  /** Advisory save-time quality signal for the agent; not persisted.
   *  Absent on a #205 conflict diversion — nothing was saved to score. */
  save_quality?: SaveQualityResult;
  /** #205: set when the save was diverted into a conflict mark on the
   *  existing memory (`id` then names THAT memory, nothing was created). */
  conflict_marked?: true;
  /** Present only when saveMemory auto-truncated an over-long summary. */
  summary_note?: string;
  /** Present only when a re-file left the old file behind under the same id. */
  warning?: string;
  /** #150: terminal success marker — tells the model not to re-issue the save. */
  note?: string;
}


// ─── #150: anti-thrash — consecutive-failure cap on save_memory ─────────
// A repeatedly failing save (schema retry loop, path issue) must never eat
// the turn: after SAVE_FAILURE_CAP consecutive failures the error turns
// terminal ("STOP retrying") until a save succeeds or the window expires.
// Deliberately daemon-global rather than per-session: this is a local
// single-user daemon, the CC session id does not reach this handler, and the
// time window bounds any cross-session bleed.
export const SAVE_FAILURE_CAP = 3;
export const SAVE_FAILURE_WINDOW_MS = 10 * 60_000;
let saveFailureCount = 0;
let saveFailureLastAt = 0;

export function noteSaveFailure(now: number = Date.now()): number {
  if (now - saveFailureLastAt > SAVE_FAILURE_WINDOW_MS) saveFailureCount = 0;
  saveFailureLastAt = now;
  saveFailureCount += 1;
  return saveFailureCount;
}

export function resetSaveFailures(): void {
  saveFailureCount = 0;
  saveFailureLastAt = 0;
}

export async function saveMemoryHandler(
  deps: ToolDeps,
  rawArgs: unknown,
  /** #464: transportgebunden — siehe private-access.ts. */
  access?: PrivateAccess,
): Promise<SaveMemoryResult | ClaimGateResult> {
  // Claude/Opus can switch from native JSON arguments into legacy XML inside
  // the first multiline value. Retrying the generated call cannot help — it
  // reproduces the same framing — so this must never poison the ordinary
  // save-failure counter. 08.09.: where the swallowed content is still in the
  // container, the framing is undone and the save goes through.
  // #482: the shared detector, fed from save_memory's own schema rather than a
  // hand-kept constant. The boundary (dispatchApi / the stdio CallTool handler)
  // runs the same check for every tool; this one stays so a direct handler call
  // gets the same answer.
  const corruption = detectCallCorruption(
    rawArgs,
    requiredFieldsOf(MEMORY_TOOL_DEFS.find((def) => def.name === "save_memory")),
  );
  if (corruption) {
    // 08.09.: the framing is recoverable more often than not — see
    // `repairCallCorruption`. Only a body that did NOT survive is terminal.
    const repaired = repairCallCorruption(rawArgs, corruption);
    if (!repaired) throw new Error(callCorruptionMessage("save_memory", corruption));
    rawArgs = repaired;
  }
  let result: SaveMemoryResult | ClaimGateResult;
  try {
    result = await saveMemoryInner(deps, rawArgs, access);
  } catch (err) {
    // #544: a failed tail sentinel is not a failing save — it is the guard
    // doing its job on a body that lost its end in transit. Resending the
    // COMPLETE body is the correct next move, so it must not feed the
    // consecutive-failure cap below, whose message tells the model to stop
    // saving altogether.
    if (err instanceof BodySentinelError) throw err;
    const failures = noteSaveFailure();
    if (failures >= SAVE_FAILURE_CAP) {
      // No reset here: every further attempt stays terminal until a success
      // or the window expiry clears the streak.
      throw new Error(
        `save_memory failed ${failures} times in a row — STOP retrying this save. ` +
          `Continue with the user's actual task and report the failed save in your reply instead. ` +
          `(last error: ${(err as Error).message})`,
      );
    }
    throw err;
  }
  resetSaveFailures();
  // Terminal success marker: no state echo beyond the advisory — a re-issued
  // identical save is thrash, not diligence. A conflict diversion (#205)
  // carries its own terminal note and keeps it.
  return { ...result, note: result.note ?? "Save complete — do not repeat this save_memory call." };
}

/**
 * #477 — record a save that never became a write. Every exit above the write
 * goes through here, so "attempted" and "written" become comparable numbers
 * instead of the write alone being visible.
 */
function noteSaveHold(
  deps: ToolDeps,
  reason: SaveHoldEvent["reason"],
  id: string,
  data: { type: string; scope: string; overwrite?: boolean },
  claimedCount = 0,
): void {
  fireAndForget(
    deps.telemetry.logSaveHold({
      reason,
      id,
      type: data.type,
      scope: data.scope,
      claimed_count: claimedCount,
      overwrite: data.overwrite ?? false,
      follows_recall: deps.telemetry.recentRecallId(),
    }),
  );
}

async function saveMemoryInner(
  deps: ToolDeps,
  rawArgs: unknown,
  access?: PrivateAccess,
): Promise<SaveMemoryResult | ClaimGateResult> {
  const parsed = SaveMemoryInput.safeParse(rawArgs);
  if (!parsed.success) throw new Error(parsed.error.message);

  // #544: `saveMemory` carries the same check for every transport, but two
  // exits below return ABOVE it — the `conflict_with` diversion, which writes
  // a conflict block into an existing memory, and the claim gate. A truncated
  // claim is no better than a truncated body, so the sentinel is verified here
  // first, before anything at all is written or held. Same function, one
  // implementation. Deliberately AFTER `repairCallCorruption` (#482) ran in
  // the handler above: where the framing repair trims swallowed XML off the
  // end of the body, the repaired body ends exactly at the sentinel and the
  // sentinel confirms the repair; where the repair cut real content, it fails.
  assertBodyTail(parsed.data.body, parsed.data.body_ends_with);

  // Die effektive id muss VOR dem Quality-Scoring feststehen — sonst schließt
  // scoreSaveQuality das Memory nicht von seinen eigenen Duplikat- und
  // Kollisions-Checks aus (#239).
  // Codex-Gegenreview zu #360-D: hier stand eine EIGENE Kopie der
  // id-Ableitung. Seit die Faltung existiert, wich sie vom tatsächlich
  // geschriebenen Ziel ab — der Quality-Selbstausschluss (#239) hätte das
  // Memory dann als sein eigenes Duplikat gewertet. `resolveMemoryTarget`
  // ist die Stelle, die das Ziel bestimmt, inklusive Bestandsschutz (auch
  // für Memories, die in memorys/ oder einem folder-Regal liegen); sie fasst
  // nichts an und ist deshalb auch vor dem Schreiben die richtige Auskunft.
  const finalId = resolveMemoryTarget(deps.vaultPath, parsed.data, vaultLocator(deps.vault)).id;

  // #464: Das Ziel steht fest — und wenn dort ein Memory liegt, das dieser
  // Caller nicht LESEN darf, darf er es auch nicht ersetzen. Vor jeder
  // Quality-Prüfung, jedem Conflict-Umweg (der schreibt in den Bestand) und
  // jedem File-I/O; die Antwort ist wortgleich die des Lesepfads, damit ein
  // Overwrite-Versuch nicht zum Existenz-Orakel für geratene Ids wird. Der
  // Fall trifft beide Wege: explizite `id` UND die implizite Slug-Kollision,
  // weil `resolveMemoryTarget` bereits beide auf dieselbe Ziel-Id faltet.
  if (hiddenFromCaller(access, deps.vault.get(finalId)?.fm)) {
    noteSaveHold(deps, "private_refused", finalId, parsed.data);
    throw new Error(`memory not found: ${finalId}`);
  }

  // #205: a save declaring a contradiction is a conflict report, not a write —
  // diverted before any quality scoring or file I/O touches the vault.
  if (parsed.data.conflict_with) {
    noteSaveHold(deps, "conflict_redirect", finalId, parsed.data);
    return markConflict(deps, parsed.data, finalId);
  }

  const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

  // Die Versionskette, die dieser Save ablöst: der `replaces`-Vorgänger und
  // alles, was DIESER schon ersetzt hatte. `out` guards a hand-written cycle.
  const supersededChain = (start: string | undefined): Set<string> => {
    const out = new Set<string>();
    let cursor: string | undefined = start;
    while (cursor !== undefined && !out.has(cursor)) {
      out.add(cursor);
      const predecessor: unknown = deps.vault.get(cursor)?.fm.replaces;
      cursor = typeof predecessor === "string" ? predecessor : undefined;
    }
    return out;
  };

  // Beim Overwrite trägt der Payload die Supersession meist nicht erneut — sie
  // steht längst im Frontmatter des Memories, das hier neu geschrieben wird.
  // Ohne diesen Rückgriff meldete ausgerechnet die Aktualisierung eines
  // Nachfolgers wieder die Kollision mit dem Vorgänger, den sie abgelöst hat.
  const declaredReplaces = parsed.data.replaces
    ?? (parsed.data.overwrite ? asString(deps.vault.get(finalId)?.fm.replaces) : undefined);

  const saveQuality = scoreSaveQuality(deps, parsed.data, finalId, supersededChain(declaredReplaces));

  // #360: the claim gate. A save whose recall_when fully contains an existing
  // memory's trigger declares a situation that memory already owns — that is a
  // successor, a contradiction or a deliberate pair, and the daemon is the
  // layer that can see it but must not guess. Held here, before any file I/O,
  // and only for a CREATE: an `overwrite` names its target, which is itself an
  // answer, and re-saving a memory must never be blocked by its own triggers.
  //
  // Documents and bookmarks are out: their triggers come from the importer, not
  // from an author, so there is no declaration to reconcile — and a bulk import
  // must not stall on the first repeated phrase.
  if (!parsed.data.overwrite && !GENERATED_TRIGGER_TYPES.has(parsed.data.type)) {
    const claimed = unansweredClaims(
      parsed.data,
      saveQuality,
      (id) => {
        const m = deps.vault.get(id);
        return m ? { summary: m.fm.summary, body: m.body } : undefined;
      },
      supersededChain,
    );
    if (claimed.length > 0) {
      noteSaveHold(deps, "claim_gate", finalId, parsed.data, claimed.length);
      return claimGateResult(finalId, claimed, saveQuality);
    }
  }

  // #164: validate the supersession target BEFORE writing anything. A
  // `replaces` pointing at nothing is an authoring mistake, and failing early
  // lets the caller fix it instead of leaving a half-declared version edge.
  const supersedes = parsed.data.replaces;
  if (supersedes !== undefined) {
    if (supersedes === finalId) {
      noteSaveHold(deps, "unresolved_replaces", finalId, parsed.data);
      throw new Error(`replaces: a memory cannot supersede itself (${finalId}).`);
    }
    // #464: Ein privater Vorgänger ist für diesen Caller nicht vorhanden —
    // sonst stempelte der Save gleich unten `superseded_by` in ein Frontmatter,
    // das er nicht lesen darf, und der Unterschied zwischen „existiert nicht"
    // und „darfst du nicht sehen" wäre am Ausgang ablesbar.
    const predecessor = deps.vault.get(supersedes);
    if (!predecessor || hiddenFromCaller(access, predecessor.fm)) {
      noteSaveHold(deps, "unresolved_replaces", finalId, parsed.data);
      throw new Error(
        `replaces: unknown memory '${supersedes}' — it must exist in the vault. ` +
          `Note that an archived memory is no longer in the living vault and cannot be superseded.`,
      );
    }
  }

  // Re-Filing (#64): Wenn die id schon indexiert ist, aber der neue Save sie
  // woanders ablegt (geänderte folder/scope-Konvention), würde saveMemory nur
  // den NEUEN Pfad auf Kollision prüfen — die alte Datei bliebe als Duplikat
  // mit derselben id liegen. Deshalb: ohne overwrite ablehnen, mit overwrite
  // die alte Datei in den Trash verschieben (recoverbar, kein Hard-Delete).
  const previous = deps.vault.get(finalId);
  if (previous && !parsed.data.overwrite) {
    noteSaveHold(deps, "id_exists", finalId, parsed.data);
    throw new Error(
      `memory already exists: ${finalId} (at ${previous.filePath}). ` +
        `Pass overwrite=true to replace it — a changed folder/scope moves the file.`,
    );
  }

  // Codex-Gegenreview (P0): Hier stand eine Ordner-Injektion — ein Overwrite
  // ohne expliziten `folder` bekam den Ordner der INDEXIERTEN Datei mit, damit
  // das Default-Routing das Memory nicht bei jeder Bearbeitung verschiebt. Das
  // machte aus einer Index-Auskunft eine Anweisung: War die Datei extern
  // verschoben worden, schrieb der Save auf den veralteten Pfad, und die
  // autoritative Auskunft las die Abweichung als bewusstes Re-Filing — danach
  // zwei aktive Dateien mit einer id.
  //
  // Dasselbe leistet jetzt `saveMemory` selbst, und zwar richtig: Ohne
  // ausdrücklichen `folder` zeigt es unter dem Claim auf die Datei, die die
  // PLATTE nennt. Aus demselben Grund entfällt auch die Aliases-Injektion —
  // die Patch-Basis ist seither die Quelldatei, nicht der Index.
  const result = await saveMemory(deps.vaultPath, parsed.data, {
    locator: vaultLocator(deps.vault),
    // #464 (wiedereröffnet): Die Prüfung oben fragte den INDEX — und zwischen
    // Index und Schreibvorgang liegt ein Fenster, in dem die Datei auf der
    // Platte längst `sensitivity: private` tragen kann (Cloud-Sync, fremder
    // Editor, unzuverlässiger Watcher). Dieselbe Frage noch einmal, an die
    // BYTES, die dieser Save ersetzt, und unter demselben Claim, der ihn
    // schützt. Wortgleiche Antwort wie der Lesepfad.
    precondition: (prevFm) => {
      if (hiddenFromCaller(access, prevFm)) {
        noteSaveHold(deps, "private_refused", finalId, parsed.data);
        throw new Error(`memory not found: ${finalId}`);
      }
    },
  });
  // Das Trashen der alten Datei erledigt `saveMemory` unter der Transaktion;
  // hier bleibt nur der Index.
  if (result.refiled_from !== undefined) deps.vault.forgetFile(result.refiled_from);
  const refileWarning: string | undefined = undefined;
  // Don't trust the watcher on cloud-storage mounts — force-index now
  // so a follow-up recall() in the same session sees the new memory.
  await deps.vault.reindexFile(result.file_path);

  // #164: stamp the backward half of the version edge onto the predecessor.
  // It stays exactly where it is — living vault, indexed, resolvable by id.
  // This is the whole difference from archive_memory (C-059): historicity is a
  // version status, not a change of location. The edge is what V2's Historical
  // zone and the "broken node pointing at its successor" in the mindspace are
  // later computed FROM, so the data has to exist from now on even though
  // nothing reads it yet.
  let supersedeWarning: string | undefined;
  if (supersedes !== undefined) {
    const target = deps.vault.get(supersedes);
    if (target) {
      try {
        // Atomar, mit Identitätsprüfung und Vergleich vor dem Commit: Ein
        // direktes writeFile ließ die Datei kurzzeitig halb geschrieben, und
        // ein paralleler Save darauf wäre still rückgängig gemacht worden.
        const stamped = await mutateMemoryFile(
          target.filePath,
          supersedes,
          {
            // #464 (wiedereröffnet): Auch dieser Stempel mutiert ein fremdes
            // Frontmatter. Die Prüfung oben fragte den Index; war der Vorgänger
            // auf der Platte inzwischen privat, stempelte der Save in eine
            // Datei, die dieser Caller nicht lesen darf. Wortlaut ohne
            // „private": Der Caller hat den Vorgänger legitim als öffentlich
            // gesehen, und die Warnung soll nicht zum Sensitivitäts-Orakel
            // werden.
            precondition: (raw) => {
              if (hiddenOnDisk(access, raw)) {
                throw new Error(`'${supersedes}' is no longer the memory the index described`);
              }
            },
            frontmatter: (fm) => ({ ...fm, superseded_by: result.id }),
          },
          { vaultRoot: deps.vaultPath },
        );
        if (stamped.kind !== "written") {
          throw new Error(
            stamped.kind === "raced"
              ? `'${supersedes}' changed while the supersede edge was being stamped`
              : `${target.filePath} does not hold memory '${supersedes}'`,
          );
        }
        await deps.vault.reindexFile(target.filePath);
      } catch (err) {
        // The new memory is written and carries `replaces`, so the edge is
        // half-formed rather than lost — but half-formed silently is exactly
        // what this issue is about, so it surfaces.
        supersedeWarning =
          `supersede: '${result.id}' declares replaces='${supersedes}', but stamping superseded_by onto ` +
          `${target.filePath} failed (${(err as Error).message}). The version link is one-directional until ` +
          `that file is writable again.`;
      }
    }
  }
  fireAndForget(
    deps.telemetry.logSaveMemory({
      id: result.id,
      type: parsed.data.type,
      scope: parsed.data.scope,
      title: parsed.data.title,
      tag_count: parsed.data.tags.length,
      recall_when_count: parsed.data.recall_when.length,
      body_chars: parsed.data.body.length,
      overwrite: parsed.data.overwrite ?? false,
      created: result.created,
      follows_recall: deps.telemetry.recentRecallId(),
    }),
  );

  // #206: the audit trail existed but covered only the Mac-app bridge — the
  // MCP/REST path, which is how the assistant writes, left no record at all.
  // Recorded next to the write rather than through `auditedSave`: that wrapper
  // throws when an assistant mutation has no `reason`, and the tool schema has
  // no reason field, so routing through it would break every agent save or
  // force a fabricated reason into the log.
  const auditWarning = await recordAudit({
    vaultRoot: deps.vaultPath,
    memoryId: result.id,
    operation: result.created ? "create" : "update",
    actor: "assistant",
    actorDetail: "mcp:save_memory",
    // Codex-Gegenreview (P1): Hier standen der Vault-CACHE als Vorbild und ein
    // Index-Lookup als Nachbild. Beides beschreibt nicht zwingend die Datei,
    // die der Save angefasst hat — bei einem Re-File war das Vorbild die
    // indexierte Version am alten Pfad, gepatcht wurde aber die Quelldatei in
    // dem Stand, den der Claim gesehen hat. Der Save reicht beides jetzt
    // selbst heraus.
    diffBefore: result.audit_before,
    diffAfter: result.audit_after,
    filePath: result.file_path,
    sessionId: deps.telemetry.runId(),
  });

  // #380: Der fehlende Beleg gehört in dieselbe Zeile wie die anderen
  // Warnungen — er sagt dem Aufrufer das Wichtigste überhaupt, nämlich NICHT
  // zu wiederholen. Zuletzt, weil die anderen beiden von der Mutation selbst
  // handeln und diese von ihrer Protokollierung.
  const warning = [refileWarning, supersedeWarning, auditWarning].filter(Boolean).join(" ");
  // Vor- und Nachbild sind AUDIT-Material und gehören nicht in die
  // Tool-Antwort: Sie sind vollständige Frontmatter-Abbilder (inklusive
  // `sensitivity: private`) und würden über den Spread still an jeden Client
  // gehen, der `save_memory` ruft.
  const { audit_before: _b, audit_after: _a, ...payload } = result;
  return { ...payload, save_quality: saveQuality, ...(warning ? { warning } : {}) };
}
