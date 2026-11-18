/**
 * #206 — audit coverage for the paths the agent actually writes through.
 *
 * The append-only audit log already exists (`packages/core/src/audit-log.ts`,
 * `<vault>/.bastra/audit-log.ndjson`) and `auditedSave`/`auditedSoftDelete`
 * wrap it. But they were wired into exactly one caller: the Mac-app bridge.
 * Every write that arrives over MCP or REST — which is how the assistant
 * writes — went past it, so the one surface that is supposed to run
 * autonomously was the one with no trail.
 *
 * Telemetry is not a substitute: it can be switched off (`telemetry.ts`) and
 * it is pruned after 90 days (`log-retention.ts`). The audit log is neither.
 *
 * ## Why this records directly instead of converting callers to `auditedSave`
 *
 * `auditedSave` does more than record: it re-derives the id, snapshots
 * `diff_before`, and throws when an `assistant` mutation carries no `reason`.
 * The MCP save path has re-file and trash handling wrapped around its write,
 * and the tool schema has no `reason` field — routing it through `auditedSave`
 * would either break every agent save or force a fabricated reason into the
 * log. A missing reason is honest; an invented one is worse than none.
 *
 * So this module is deliberately thin: it records what happened, next to the
 * write, and never changes whether the write succeeds. Converting the call
 * sites properly (and giving `save_memory` a real `reason`) is a separate step.
 *
 * ## Failure policy
 *
 * An audit failure must never cost the user their write. Recording is
 * best-effort and reports to stderr; the write has already landed by then.
 * That is a deliberate trade: this log is for reconstructing what happened,
 * not a transaction gate.
 */
import {
  AuditLog,
  assertBodyTail,
  saveMemory,
  newOperationId,
  reportMutationIncident,
  type AuditActor,
  type AuditOperation,
  type SaveMemoryCommitOptions,
  type SaveMemoryInput,
  type SaveMemoryResult,
  type WriteOriginEvidence,
} from "@bastra-recall/core";
import { writeCallerStore } from "./caller-session.js";
import { redactSaveInput, withRedactionReceipt, WriteRedaction, type RedactionReceipt } from "./save-redaction.js";

/** One AuditLog per vault — it caches reads, and re-creating it per write
 *  would throw that cache away on every save. */
const logs = new Map<string, AuditLog>();

function logFor(vaultRoot: string): AuditLog {
  let log = logs.get(vaultRoot);
  if (!log) {
    log = new AuditLog(vaultRoot);
    logs.set(vaultRoot, log);
  }
  return log;
}

/** #1469: transport, client and client session of the tool call this write
 *  runs in — set at the transport boundary (see caller-session.ts). */
export function writerFields(): { transport?: string; client?: string | null; caller_session?: string | null } {
  const caller = writeCallerStore.getStore();
  return caller ? { transport: caller.transport, client: caller.client, caller_session: caller.session } : {};
}

/**
 * #1496: the evidence a `write_origin: user-directed` save carries in its
 * frontmatter — the same transport facts as the audit entry, plus the time.
 * Outside a tool call (web UI, CLI, background jobs) there is no transport to
 * read, and the save carries none rather than a guess.
 */
export function writeOriginEvidence(now: Date = new Date()): WriteOriginEvidence | undefined {
  const caller = writeCallerStore.getStore();
  return caller
    ? { transport: caller.transport, client: caller.client, session: caller.session, at: now.toISOString() }
    : undefined;
}

/** Who a shared write handler records as author: MCP/REST callers by default,
 *  the user for the web UI's own writes (#1446, `webui-memory-edit.ts`). */
export type AuditOrigin = Pick<AuditTrailInput, "actor" | "actorDetail">;
export function auditOrigin(origin: AuditOrigin | undefined, mcpDetail: string): AuditOrigin {
  return origin ?? { actor: "assistant", actorDetail: mcpDetail };
}

export interface AuditTrailInput {
  vaultRoot: string;
  memoryId: string;
  operation: AuditOperation;
  /** Who caused it. MCP/REST writes are `assistant`; the CLI onboarding flow
   *  is `user`, because a human answered the questions. */
  actor: AuditActor;
  /** Which surface — `mcp:save_memory`, `http:save_document`, … . This is what
   *  makes the log answer "through which run did this change?". */
  actorDetail: string;
  diffBefore: Record<string, unknown> | null;
  diffAfter: Record<string, unknown> | null;
  filePath?: string;
  /** Absent on the MCP path: the tool schema has no reason field, and a
   *  generated one would be noise dressed as provenance. */
  reason?: string;
  sessionId?: string;
}

/**
 * Append one entry. Never throws — a broken audit log must not turn a
 * successful save into a failed tool call.
 *
 * #380: Gibt im Fehlerfall den Satz zurück, den der AUFRUFER sehen soll.
 * `auditedSave` in core kennt ihn seit `dfb044e` als `audit_warning`, aber nur
 * der Bridge-Pfad reichte ihn durch — über MCP und REST sah ein Aufrufer eine
 * gewöhnliche Erfolgsantwort, obwohl kein Beleg geschrieben wurde. `undefined`
 * heißt: alles protokolliert.
 *
 * Der Satz sagt ausdrücklich NICHT WIEDERHOLEN: Die Mutation steht bereits,
 * ein zweiter Versuch wäre ein zweiter Schreibvorgang auf einen schon
 * geschriebenen Zustand.
 */
export async function recordAudit(input: AuditTrailInput): Promise<string | undefined> {
  try {
    await logFor(input.vaultRoot).record({
      memory_id: input.memoryId,
      actor: input.actor,
      actor_detail: input.actorDetail,
      operation: input.operation,
      diff_before: input.diffBefore,
      diff_after: input.diffAfter,
      ...(input.filePath ? { file_path: input.filePath } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...writerFields(),
    });
  } catch (err) {
    console.error(
      `[bastra-recall] audit: could not record ${input.operation} of ${input.memoryId}: ${(err as Error).message}`
    );
    // #377: stderr ist im Moment des Fehlers da und zwei Wochen später nicht.
    // Genau dieser Pfad trägt JEDEN Agentenschreibvorgang über MCP und REST —
    // ein stiller Ausfall hier heißt, dass die Änderung steht und ihr Beleg
    // fehlt, und niemand kann es hinterher feststellen.
    //
    // `audit_failed` und nicht `partial`: Der Schreibvorgang ist vollständig
    // durchgelaufen, nur sein Beleg fehlt. Wer das Ereignis liest, darf die
    // Operation deshalb NICHT wiederholen — das wäre ein zweiter Schreibvorgang
    // auf einen bereits geschriebenen Zustand.
    //
    // Ohne Fehlertext: `err.message` trägt hier regelmäßig den Pfad des
    // Audit-Logs, und Pfade gehören nicht in dieses Ereignis. Die Meldung mit
    // Pfad steht eine Zeile höher auf stderr, wo sie hingehört.
    reportMutationIncident({
      operation_id: newOperationId(),
      op: `audit_${input.operation}`,
      status: "audit_failed",
      phase: "audit",
      memory_id: input.memoryId,
      detail: "append failed",
    });
    // #380: Wortgleich mit `recordOrWarn` in core — ein Aufrufer soll denselben
    // Satz lesen, egal über welchen Transport er schreibt.
    return (
      `the ${input.operation} was committed, but the audit entry could not be written ` +
      `(${(err as Error).message}) — do NOT retry the operation; it already happened.`
    );
  }
  return undefined;
}

/** Sanitize only the NEW audit append, retaining the authoritative result and
 * identity/provenance fields verbatim. Update snapshots are evidence, not a
 * rollback payload (restore reads delete entries and the actual trash file).
 * Existing ledger bytes and the preimage used for CAS are never rewritten.
 */
function auditContentSnapshot(
  snapshot: Record<string, unknown> | null,
  prefix: string,
  redaction: WriteRedaction
): Record<string, unknown> | null {
  if (snapshot === null) return null;
  const copy = { ...snapshot };
  for (const field of ["title", "summary", "applies_when", "verify_cmd"]) {
    if (typeof copy[field] === "string") copy[field] = redaction.text(`${prefix}.${field}`, copy[field]);
  }
  if (Array.isArray(copy.recall_when)) {
    copy.recall_when = copy.recall_when.map((value: unknown) =>
      typeof value === "string" ? redaction.text(`${prefix}.recall_when`, value) : value
    );
  }
  return copy;
}

export interface SaveMemoryWithAuditTrailInput {
  vaultRoot: string;
  input: SaveMemoryInput;
  actor: AuditActor;
  actorDetail: string;
  sessionId: string;
  /** #285: compare-and-swap precondition, forwarded to the commit unchanged.
   *  Auditing a write must not weaken the guarantee the caller asked for. */
  commit?: SaveMemoryCommitOptions;
}

/**
 * Audit a direct daemon `saveMemory` caller without requiring a live Vault
 * instance. Imports and onboarding both write before the watcher/index exists;
 * this wrapper takes the pre- and postimage FROM the mutation, then delegates
 * to the same best-effort `recordAudit` seam as MCP writes.
 *
 * Failure boundary for auditors:
 * - `saveMemory` is the mutation path; its errors propagate to the caller;
 * - the pre-/postimage travels with the result, so there is no separate read
 *   that could describe a different file than the one that was written;
 * - `recordAudit` runs after the committed write and never throws, so an audit
 *   append failure cannot roll back or misreport a successful save.
 *
 * `sessionId` is caller-owned deliberately: batch callers allocate it once per
 * invocation and reuse it across every memory in that run.
 */
export async function saveMemoryWithAuditTrail(
  args: SaveMemoryWithAuditTrailInput
): Promise<SaveMemoryResult & RedactionReceipt["fields"] & { warning?: string }> {
  // Verify the caller's original tail before redaction removes the sentinel.
  // Only redact content: importer-owned IDs, sources and CAS stay unchanged.
  assertBodyTail(args.input.body, args.input.body_ends_with);
  const input = { ...args.input };
  const redacted = redactSaveInput(input);
  // Codex-Gegenreview (P1): Das Vorbild wurde hier aus dem aufgelösten
  // ZIELPFAD gelesen. Bei einem Re-File existiert dieses Ziel aber noch gar
  // nicht — die Vorlage ist die Quelldatei. Nachgestellt: ein gewöhnliches
  // Re-File protokollierte `operation: update` mit `diff_before: null`, also
  // eine Änderung ohne Vorzustand. Vor- und Nachbild kommen deshalb aus der
  // Mutation selbst, die beide unter ihrem Claim gelesen bzw. geschrieben hat.
  const result = withRedactionReceipt(await saveMemory(args.vaultRoot, input, args.commit), redacted);
  // #530: Ein Save, der nichts geschrieben hat, hat auch nichts zu belegen.
  // Ein wiederholter Import hängte sonst je unveränderter Datei ein
  // `update`-Ereignis mit identischem `diff_before`/`diff_after` an das
  // append-only Log — ein Beleg für eine Änderung, die es nicht gab.
  if (result.unchanged) return result;
  const auditRedaction = new WriteRedaction();
  const diffBefore = auditContentSnapshot(result.audit_before, "audit_before", auditRedaction);
  const diffAfter = auditContentSnapshot(result.audit_after, "audit_after", auditRedaction);
  await recordAudit({
    vaultRoot: args.vaultRoot,
    memoryId: result.id,
    operation: result.created ? "create" : "update",
    actor: args.actor,
    actorDetail: args.actorDetail,
    diffBefore,
    diffAfter,
    filePath: result.file_path,
    sessionId: args.sessionId,
  });
  const auditReceipt = auditRedaction.receipt();
  auditReceipt.fields.secrets_redacted = { ...result.secrets_redacted, ...auditReceipt.fields.secrets_redacted };
  return withRedactionReceipt(result, auditReceipt);
}

/** Test seam — the module-level cache would otherwise leak between vaults. */
export function resetAuditLogCache(): void {
  logs.clear();
}
