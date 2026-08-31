/**
 * #217 Phase 2 — Reflex-Lane (POST /hook/reflex).
 *
 * Memories mit `recall_mode: "reflex"` dürfen OHNE aktive Query injiziert
 * werden, wenn eine ihrer recall_when-Phrasen HART auf den Prompt-Kontext
 * matcht. Floors bleiben der manuelle Pin (push-by-state); Reflex ist das
 * regelbasierte, selbst-feuernde Geschwister — pro Memory vom User
 * verdrahtet (Promotion nur nach Bestätigung, siehe curator-run.ts).
 *
 * „Hart" heißt deterministisch, ohne Score: eine Phrase matcht, wenn alle
 * ihre Tokens (≥3 Zeichen, lowercase, tokenizeWithIdentifiers) im Kontext
 * vorkommen — mindestens 2 Tokens, oder genau 1 Identifier-Token exakt;
 * eine mehrwortige Phrase, von der nur ein Inhaltstoken übrig bleibt
 * („antwortentwurf bitte"), matcht wörtlich als Tokenfolge (20.08.);
 * „oder"/„or" teilt eine Phrase in Alternativen. Bewusst NICHT
 * matchedRecallWhen (MiniSearch: fuzzy/prefix). recall_when_expanded zählt
 * seit dem 19.08.-Vorfall MIT: deterministisch aus den autorisierten Phrasen
 * generiert, erweitert es die Formulierung, nicht die Autorisierung — ohne
 * das überlebt kein Token-AND die deutsche Flexion. Die semantische
 * Absicherung derselben Lücke liegt in prompt-lane.ts (mode-"none"-Filter).
 *
 * Budget: BASTRA_REFLEX_MAX_PER_TURN bzw. reflex.maxPerTurn (default 2,
 * clamp 1..5). Kill-Switch: BASTRA_REFLEX=off (env) bzw.
 * reflex.enabled=false (cli-settings.json; env gewinnt). Jede Feuerung
 * wird als hook_reflex-Event getraced; surfaced-Usage zählt erst der
 * Client-Report via /hook/hinted (Phantom-Demand-Regel, telemetry.ts).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { tokenizeWithIdentifiers, PHRASE_STOPWORDS, MIN_SIGNIFICANT_TOKEN_LEN } from "@bastra-recall/core";
import type { Vault, Memory } from "@bastra-recall/core";
import { envFirst, envInt } from "./env.js";
import { readSettings } from "./settings.js";
import { fireAndForget, type Telemetry } from "./telemetry.js";
import { truncateSummary } from "./tool-handlers.js";

// #360: nach core verschoben (PHRASE_STOPWORDS/MIN_SIGNIFICANT_TOKEN_LEN) —
// `anchorStrength` in search.ts braucht denselben Begriff von "Allerweltswort"
// für die Zweierregel. Ein Alias hier, damit der lokale Name unverändert bleibt.
const MIN_TOKEN_LEN = MIN_SIGNIFICANT_TOKEN_LEN;
const DEFAULT_MAX_PER_TURN = 2;

export interface ReflexHit {
  id: string;
  title: string;
  type: string;
  scope: string;
  summary: string;
  matched_phrase: string;
}

/** Ein EINZELNES Inhaltstoken zählt nur als Identifier (Glue-Zeichen oder
 *  Ziffer: `npm-shrinkwrap`, `es2022`, `#217`) — ein einzelnes Freitext-Wort
 *  („deployment", „css") wäre ein Streutrigger, der query-los auf jeden
 *  Prompt mit diesem Wort feuert. */
const IDENTIFIER_TOKEN_RE = /[-_./#+@:]|\d/;

/** Hartes Phrase-gegen-Kontext-Matching (deterministisch, kein Score):
 *  ALLE Inhaltstokens der Phrase (≥3 Zeichen, ohne Funktionswörter) müssen
 *  im Kontext vorkommen — mindestens 2 Tokens, oder genau 1 Identifier-Token
 *  exakt. Kein Prefix, kein Fuzzy. */
export function phraseMatchesContext(
  phrase: string,
  contextTokens: Set<string>,
  contextSequence?: string,
): boolean {
  // Ein „oder"/„or" in der Phrase ist eine Alternativen-Liste, kein
  // Token-Paket: „Nachricht oder Antwort entwerfen" verlangte sonst BEIDE
  // Substantive im Prompt und feuerte nie (19.08.-Vorfall: die
  // Nachrichtenkonvention — reflex, salience 0.9 — blieb beim Entwerfen
  // einer Nachricht stumm). Jede Alternative matcht für sich nach den
  // normalen Regeln.
  const alternatives = phrase.split(/\s+(?:oder|or)\s+/i);
  if (alternatives.length > 1) {
    return alternatives.some((alt) => phraseMatchesContext(alt, contextTokens, contextSequence));
  }
  const tokens = tokenizeWithIdentifiers(phrase.toLowerCase());
  const meaningful = [
    ...new Set(tokens.filter((t) => t.length >= MIN_TOKEN_LEN && !PHRASE_STOPWORDS.has(t))),
  ];
  if (meaningful.length === 0) return false;
  if (meaningful.length === 1 && !IDENTIFIER_TOKEN_RE.test(meaningful[0])) {
    // 20.08.-Vorfall: „antwortentwurf bitte" — vom User wörtlich als Trigger
    // eingetragen, „bitte" ist Funktionswort, übrig blieb EIN Inhaltstoken,
    // und die Regel gegen Streutrigger („css") verwarf die Phrase still. Die
    // Regel schützt vor einem losen Einzelwort, nicht vor einer Formulierung,
    // die der User so aufgeschrieben hat: eine mehrwortige Phrase matcht dann
    // wörtlich — als zusammenhängende Tokenfolge, Funktionswörter inklusive.
    // Ohne Sequenz (Alt-Aufrufer) bleibt es beim Verwerfen.
    if (tokens.length < 2 || contextSequence === undefined) return false;
    return contextSequence.includes(` ${tokens.join(" ")} `);
  }
  return meaningful.every((t) => contextTokens.has(t));
}

interface ReflexMatch {
  memory: Memory;
  phrase: string;
  matches: number;
}

/**
 * Der Reflex-Pool: jedes Memory, das der User auf `recall_mode: reflex`
 * promoviert hat und das ein Recall überhaupt servieren könnte.
 *
 * Exportiert, weil die Prompt-Lane denselben Pool braucht (#371): ihr
 * mode-"none"-Filter (prompt-lane.ts:420) lässt nichts anderes durch, also
 * entscheidet diese Liste, ob der Voll-Recall, den die Lane gleich bezahlt,
 * überhaupt etwas beitragen kann. EINE Definition, damit die beiden Seiten
 * nicht auseinanderlaufen — `collectReflexHits` benutzt sie mit.
 *
 * Die drei Bedingungen spiegeln, was der Hook-Recall-Pfad servieren kann:
 * `obsolete` maskiert `passesRecallFilters` (und der Vector-Arm über den
 * Vault-Filter), `sensitivity: private` fällt heraus, weil der Hook-Pfad
 * `allow_private` nie setzt. Was dieser Filter verwirft, kann also auch nicht
 * als Hit auftauchen — die Lane verliert durch das Vorziehen nichts.
 */
export function reflexPool(vault: Vault): Memory[] {
  return vault.list().filter(
    (m) =>
      m.fm.recall_mode === "reflex" &&
      m.fm.obsolete !== true &&
      m.fm.sensitivity !== "private",
  );
}

/** Nur die ids — was die Prompt-Lane für ihre Session-Dedup-Vorprüfung braucht. */
export function reflexPoolIds(vault: Vault): string[] {
  return reflexPool(vault).map((m) => m.fm.id);
}

const salienceOf = (m: Memory): number =>
  typeof m.fm.salience === "number" ? m.fm.salience : 0;

/**
 * Pure Match-Pipeline, exportiert für Tests: Reflex-Subset filtern, hart
 * matchen, nach (#Matches, salience, updated) sortieren, budgetieren.
 */
export function collectReflexHits(
  vault: Vault,
  context: string,
  budget: number,
): { pool: number; matched: ReflexMatch[]; served: ReflexMatch[] } {
  const contextTokenList = tokenizeWithIdentifiers(context.toLowerCase());
  const contextTokens = new Set(contextTokenList);
  // Tokenfolge für den wörtlichen Phrasen-Match (siehe phraseMatchesContext).
  const contextSequence = ` ${contextTokenList.join(" ")} `;
  const pool = reflexPool(vault);
  const matched: ReflexMatch[] = [];
  for (const m of pool) {
    // recall_when_expanded zählt mit: die Expansion ist deterministisch aus
    // den vom User autorisierten Phrasen generiert (recall_when_expanded_src
    // pinnt die Quelle) — sie erweitert die FORMULIERUNG, nicht die
    // Autorisierung. Nötig, weil Flexion und Frageform das exakte Token-AND
    // sonst leer laufen lassen („entwirfst" matcht „entwerfen" nie).
    const expanded = (m.fm as { recall_when_expanded?: unknown }).recall_when_expanded;
    const phrases = [
      ...(m.fm.recall_when ?? []),
      ...(Array.isArray(expanded) ? expanded : []),
    ].filter((p): p is string => typeof p === "string");
    const hit = phrases.filter((p) => phraseMatchesContext(p, contextTokens, contextSequence));
    if (hit.length > 0) matched.push({ memory: m, phrase: hit[0], matches: hit.length });
  }
  matched.sort(
    (a, b) =>
      b.matches - a.matches ||
      salienceOf(b.memory) - salienceOf(a.memory) ||
      String(b.memory.fm.updated ?? "").localeCompare(String(a.memory.fm.updated ?? "")),
  );
  return { pool: pool.length, matched, served: matched.slice(0, budget) };
}

/** Env gewinnt über cli-settings.json (gleiche Präzedenz wie überall). */
export async function reflexConfig(): Promise<{ enabled: boolean; maxPerTurn: number }> {
  const settings = await readSettings().catch(() => undefined);
  const envMode = envFirst("BASTRA_REFLEX");
  const enabled =
    envMode !== undefined
      ? envMode.toLowerCase() !== "off"
      : settings?.reflex?.enabled ?? true;
  const raw = envInt("BASTRA_REFLEX_MAX_PER_TURN", settings?.reflex?.maxPerTurn ?? DEFAULT_MAX_PER_TURN);
  const maxPerTurn = Math.min(Math.max(Math.trunc(raw), 1), 5);
  return { enabled, maxPerTurn };
}

const toReflexHit = (m: ReflexMatch): ReflexHit => ({
  id: m.memory.fm.id,
  title: m.memory.fm.title,
  type: m.memory.fm.type,
  scope: m.memory.fm.scope,
  summary: truncateSummary(m.memory.fm.summary),
  matched_phrase: m.phrase,
});

export function handleHookReflex(
  req: IncomingMessage,
  res: ServerResponse,
  t0: number,
  vault: Vault,
  telemetry: Telemetry,
): void {
  let raw = "";
  req.on("data", (c) => {
    raw += c;
    if (raw.length > 64 * 1024) req.destroy();
  });
  req.on("end", () => {
    void (async () => {
      let body: { context?: unknown; project?: unknown; session_id?: unknown } = {};
      try {
        body = raw.trim() ? (JSON.parse(raw) as typeof body) : {};
      } catch {
        /* defaults */
      }
      const context = typeof body.context === "string" ? body.context.trim() : "";
      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (!context) {
        send(400, { error: "context is required" });
        return;
      }
      const { enabled, maxPerTurn } = await reflexConfig();
      if (!enabled) {
        send(200, { hits: [], recall_id: null });
        return;
      }
      const { pool, matched, served } = collectReflexHits(vault, context, maxPerTurn);
      // recall_id nur minten, wenn wirklich etwas serviert wurde — sonst
      // überschriebe JEDER Prompt telemetry.lastRecall und der
      // follows_recall-Join (recall→save, ≤5min) würde zu Rauschen
      // (Review-Finding #217).
      const recallId = served.length > 0 ? telemetry.newRecallId() : null;
      if (recallId) {
        // Join-Anker für spätere load_memory-Episoden (score-los → null).
        telemetry.recordHookHints(recallId, served.map((m) => ({ id: m.memory.fm.id })));
      }
      const sessionId = typeof body.session_id === "string" ? body.session_id : undefined;
      fireAndForget(
        telemetry.logHookReflex({
          recall_id: recallId,
          context_chars: context.length,
          project: typeof body.project === "string" ? body.project : null,
          reflex_pool: pool,
          matched: matched.map((m) => ({ id: m.memory.fm.id, phrase: m.phrase })),
          served: served.map((m) => m.memory.fm.id),
          latency_ms: Date.now() - t0,
          ...(sessionId ? { session_id: sessionId } : {}),
        }),
      );
      send(200, { hits: served.map(toReflexHit), recall_id: recallId });
    })();
  });
}
