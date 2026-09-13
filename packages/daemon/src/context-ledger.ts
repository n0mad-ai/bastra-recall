/**
 * Kontext-Ledger (#457): EINE Rechnung für alles, was Recall in das Transkript
 * des Modells schreibt.
 *
 * Bisher gab es zwei Numeratoren für dieselbe Frage: `Net-context-ROI` zählte
 * drei Hook-Lanes (`hook_call`, `session_hook_call`, `bash_hook_call`), das
 * Governor-What-if kannte sechs. Und kein Weg zählte die Tool-Payloads —
 * `recall()`, `load_memory` und `read_document` liefern Text, der genauso im
 * Kontext landet wie eine Hook-Injektion, stand aber in keiner Summe.
 *
 * Der Ledger faltet alle Ereignisse in Posten mit klaren Regeln:
 *   - Hook-Lanes: `hint_tokens_est` der sechs Lane-Ereignisse.
 *   - Tool-Payloads: `payload_tokens_est` (recall) und `delivered_tokens_est`
 *     (load_memory, read_document), gemessen nach der lean/full-Projektion.
 *   - Alte Zeilen ohne Größenfeld zählen als UNBEKANNT, nie als 0: Die
 *     Summe ist dann eine Untergrenze, und `unknown` sagt, wie viele Posten
 *     fehlen. Eine erfundene Null wäre ein kostenloser Load, den es nie gab.
 *
 * Schätzer: chars/4 überall, auch für die Payloads — ein Tokenizer-exakter
 * Wert würde hier mit einem Schätzwert in derselben Spalte stehen. Wer die
 * Tokens genau braucht, misst sie nach dem Modell und ersetzt den Schätzer
 * an EINER Stelle: `CONTEXT_LEDGER_ESTIMATOR`.
 *
 * Reine Funktion über Ereignisse, keine Persistenz, kein Rohtext.
 */

export const CONTEXT_LEDGER_VERSION = 1;
export const CONTEXT_LEDGER_ESTIMATOR = "chars/4";

/** Alle Lane-Ereignisse, die Text ins Transkript schreiben. Die Liste ist
 *  die Vollständigkeitsgarantie des Ledgers — ein Test prüft, dass keine
 *  Lane aus dem Numerator fallen kann. */
export const HOOK_LANE_KINDS = [
  "session_hook_call",
  "prompt_hook_call",
  "hook_call",
  "bash_hook_call",
  "bash_fail_hook_call",
  "todo_hook_call",
] as const;
export type HookLaneKind = (typeof HOOK_LANE_KINDS)[number];

export const TOOL_PAYLOAD_KINDS = ["recall", "load_memory", "read_document"] as const;
export type ToolPayloadKind = (typeof TOOL_PAYLOAD_KINDS)[number];

export interface LedgerEvent {
  kind: string;
  ts?: string;
  session_id?: unknown;
  hint_tokens_est?: unknown;
  payload_tokens_est?: unknown;
  delivered_tokens_est?: unknown;
  presentation?: unknown;
  found?: unknown;
  caller_session?: unknown;
  dimensions?: { experiment_session?: unknown; client?: unknown; hook_source?: unknown } | unknown;
  [k: string]: unknown;
}

export interface LedgerPart {
  /** Posten mit bekannter Größe. */
  emissions: number;
  tokens: number;
  /** Posten OHNE Größenfeld (alte Zeilen) — nicht in `tokens` enthalten. */
  unknown: number;
}

export interface SessionLedger {
  session: string;
  lanes: Record<HookLaneKind, LedgerPart>;
  tools: Record<ToolPayloadKind, LedgerPart>;
  /** load_memory nach Präsentation — die Frage aus #163, ob lean genug ist. */
  loadByPresentation: Record<"lean" | "full", LedgerPart>;
  /** Summe aller bekannten Posten dieser Session. */
  totalTokens: number;
  /** Summe aller unbekannten Posten dieser Session. */
  totalUnknown: number;
}

export interface ContextLedger {
  version: number;
  estimator: string;
  sessions: Map<string, SessionLedger>;
  /** Über alle Sessions: dieselbe Struktur, dieselben Regeln. */
  total: Omit<SessionLedger, "session">;
}

const part = (): LedgerPart => ({ emissions: 0, tokens: 0, unknown: 0 });

function emptyLedger(session: string): SessionLedger {
  const lanes = Object.fromEntries(HOOK_LANE_KINDS.map((k) => [k, part()])) as Record<HookLaneKind, LedgerPart>;
  const tools = Object.fromEntries(TOOL_PAYLOAD_KINDS.map((k) => [k, part()])) as Record<ToolPayloadKind, LedgerPart>;
  return {
    session,
    lanes,
    tools,
    loadByPresentation: { lean: part(), full: part() },
    totalTokens: 0,
    totalUnknown: 0,
  };
}

function add(target: LedgerPart, tokens: number | null): void {
  target.emissions++;
  if (tokens === null) target.unknown++;
  else target.tokens += tokens;
}

const numberOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Der Schlüssel, unter dem ein Ereignis seiner Session zugerechnet wird.
 *  Hook-Lanes tragen die echte Client-Session in `session_id`; die
 *  Daemon-Ereignisse tragen dort die Boot-Id und die Client-Session (wenn
 *  bekannt) in `caller_session`. */
export function ledgerSessionKey(e: LedgerEvent): string {
  if (typeof e.caller_session === "string" && e.caller_session) return e.caller_session;
  if (typeof e.session_id === "string" && e.session_id) return e.session_id;
  return "(none)";
}

function fold(into: SessionLedger, e: LedgerEvent): void {
  const kind = e.kind;
  if ((HOOK_LANE_KINDS as readonly string[]).includes(kind)) {
    const t = numberOrNull(e.hint_tokens_est);
    add(into.lanes[kind as HookLaneKind], t);
  } else if (kind === "recall") {
    add(into.tools.recall, numberOrNull(e.payload_tokens_est));
  } else if (kind === "load_memory") {
    // Ein Load, der nichts fand, hat nichts geliefert — er ist kein Posten,
    // auch kein unbekannter.
    if (e.found === false) return;
    const t = numberOrNull(e.delivered_tokens_est);
    add(into.tools.load_memory, t);
    const pres = e.presentation === "full" ? "full" : e.presentation === "lean" ? "lean" : null;
    if (pres) add(into.loadByPresentation[pres], t);
  } else if (kind === "read_document") {
    if (e.found === false) return;
    add(into.tools.read_document, numberOrNull(e.delivered_tokens_est));
  } else {
    return;
  }
  into.totalTokens = sumTokens(into);
  into.totalUnknown = sumUnknown(into);
}

const sumTokens = (l: SessionLedger): number =>
  [...Object.values(l.lanes), ...Object.values(l.tools)].reduce((s, p) => s + p.tokens, 0);
const sumUnknown = (l: SessionLedger): number =>
  [...Object.values(l.lanes), ...Object.values(l.tools)].reduce((s, p) => s + p.unknown, 0);

export function buildContextLedger(events: Iterable<LedgerEvent>): ContextLedger {
  const sessions = new Map<string, SessionLedger>();
  const total = emptyLedger("(all)");
  for (const e of events) {
    const key = ledgerSessionKey(e);
    let l = sessions.get(key);
    if (!l) {
      l = emptyLedger(key);
      sessions.set(key, l);
    }
    fold(l, e);
    fold(total, e);
  }
  const { session: _ignored, ...rest } = total;
  void _ignored;
  return { version: CONTEXT_LEDGER_VERSION, estimator: CONTEXT_LEDGER_ESTIMATOR, sessions, total: rest };
}
