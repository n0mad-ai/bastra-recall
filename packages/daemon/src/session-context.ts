/**
 * Session-context block for clients WITHOUT a session hook (Claude Desktop,
 * Cursor, …). Claude Code gets this context injected by the SessionStart
 * hook; hookless clients get it from the MCP forwarder, appended to the
 * FIRST tool result of the session (the forwarder process lives exactly one
 * client session, so "first call of this process" ≈ session start).
 *
 * Seit #265 ist das nur noch die PROJEKTION „projektlos, ohne Budget" auf den
 * geteilten Assembler in `session-assembler.ts` — dieselben Erheber, dieselbe
 * Reihenfolge, derselbe Text. Der GET-Vertrag bleibt damit unverändert
 * (`session-context-contract.test.ts` vergleicht beide Wege), und die
 * projektbewusste Fassung mit Budgets hängt am POST desselben Pfades.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Vault } from "@bastra-recall/core";
import type { ToolDeps } from "./tool-handlers.js";
import { sendJsonPlain } from "./webui.js";
import { detectProject } from "@bastra-recall/core/topics";
import { MAX_BODY_BYTES, readJsonBody } from "./http-util.js";
import {
  assembleSessionSections,
  renderSessionContext,
  estimateTokens,
  type SessionContextDeps,
} from "./session-assembler.js";

export type { SessionContextDeps };

/** One compact context block, every section best-effort. Projektlos — genau
 *  wie bisher: eine hooklose Oberfläche hat kein cwd und damit kein Projekt. */
export async function buildSessionContext(
  toolDeps: ToolDeps,
  vault: Vault,
  deps: SessionContextDeps = {},
): Promise<string> {
  // `expand_hops: 0` steht hier ausdrücklich: Der Forwarder-Vertrag kennt keine
  // Hops (mcp-forwarder.ts fragt sie ebenfalls nicht an), und der Default des
  // Assemblers ist die HOOK-Baseline `1`. Ohne diese Zeile bekäme eine hooklose
  // Oberfläche plötzlich mehr, weil anderswo ein Default umgezogen ist.
  const assembled = await assembleSessionSections(
    toolDeps,
    vault,
    { project: null, expand_hops: 0 },
    deps,
  );
  return renderSessionContext(assembled.sections, vault.size());
}

/** GET /hook/session-context — loopback-only, no auth (same trust level as
 *  the other /hook/* endpoints). Serves the forwarder's first-call inject. */
export async function handleSessionContext(
  _req: IncomingMessage,
  res: ServerResponse,
  toolDeps: ToolDeps,
  vault: Vault,
): Promise<void> {
  const context = await buildSessionContext(toolDeps, vault);
  sendJsonPlain(res, 200, { context, vault_size: vault.size() });
}

/**
 * POST /hook/session-context — der projektbewusste Weg (#265).
 *
 * Nimmt `cwd`/`project`/`source`/`budget` und liefert neben dem Block die
 * Auskunft, WIE er zustande kam: welche Blöcke drin sind und warum die anderen
 * fehlen, der §9.4-Marker des Retrievalpfads, die Budgetbilanz. Der GET-Vertrag
 * bleibt daneben unangetastet.
 *
 * `context` heißt weiterhin `context` und `vault_size` weiterhin `vault_size` —
 * ein Client, der nur diese beiden liest, funktioniert an beiden Verben.
 */
export async function handleSessionContextPost(
  req: IncomingMessage,
  res: ServerResponse,
  toolDeps: ToolDeps,
  vault: Vault,
): Promise<void> {
  const body = await readJsonBody(req, MAX_BODY_BYTES).catch(() => ({}) as Record<string, unknown>);
  const b = (body ?? {}) as Record<string, unknown>;
  // Das Projekt kommt entweder fertig oder wird aus dem cwd erkannt — dieselbe
  // Auflösung wie in der SessionStart-Lane, damit beide Wege dasselbe Projekt
  // sehen.
  const project =
    typeof b.project === "string" && b.project.length > 0
      ? b.project
      : typeof b.cwd === "string"
        ? detectProject(b.cwd)
        : null;
  const budget = (b.budget ?? {}) as Record<string, unknown>;
  const caps = (b.caps ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const assembled = await assembleSessionSections(toolDeps, vault, {
    project,
    source: typeof b.source === "string" ? b.source : null,
    session_id: typeof b.session_id === "string" ? b.session_id : null,
    client: b.client,
    // #265: Nur der POST-Weg fährt die Hook-Pipeline (Scope-Filter,
    // Reflex-Hits, Router-Schatten). GET bleibt auf `recallHandler` — der
    // Wechsel wäre eine stille Produktänderung für hooklose Clients und ist
    // eine eigene Entscheidung.
    hookRecall: {
      vault,
      search: toolDeps.search,
      telemetry: toolDeps.telemetry,
      learnedBridges: toolDeps.learnedBridges,
      sharedRecallLang: toolDeps.sharedRecallLang,
      embeddingDegraded: toolDeps.embeddingDegraded,
      evidenceGateEnabled: toolDeps.evidenceGateEnabled,
    },
    cross_project: b.cross_project === true,
    caps: {
      ...(num(caps.pinned) !== undefined ? { pinned: num(caps.pinned) } : {}),
      ...(num(caps.hints) !== undefined ? { hints: num(caps.hints) } : {}),
      ...(num(caps.conventions) !== undefined ? { conventions: num(caps.conventions) } : {}),
      ...(num(caps.project) !== undefined ? { project: num(caps.project) } : {}),
    },
    budget: {
      ...(typeof budget.time_ms === "number" ? { time_ms: budget.time_ms } : {}),
      ...(typeof budget.tokens === "number" ? { tokens: budget.tokens } : {}),
    },
  });
  const context = renderSessionContext(assembled.sections, vault.size());
  sendJsonPlain(res, 200, {
    context,
    vault_size: vault.size(),
    project,
    blocks: assembled.reports,
    // §9.4: ein unvollständiger Hybridpfad darf sich nicht als vollständig
    // ausgeben. `null` heißt „kein Recall gelaufen", nicht „vollständig".
    retrieval: assembled.marker,
    budget: {
      time_ms: assembled.elapsed_ms,
      tokens: estimateTokens(context),
    },
    // Deadline-Abbruch ist eine Teilabdeckung und wird als solche berichtet —
    // niemals als `no_answer` (C-052, C-061).
    aborted: assembled.aborted,
    // #265: das Rohmaterial für Aufrufer, die selbst rendern (die
    // SessionStart-Lane mit ihrem Banding). Additiv — wer nur `context` und
    // `vault_size` liest, merkt nichts davon.
    data: assembled.data,
  });
}
