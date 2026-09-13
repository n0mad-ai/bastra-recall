/**
 * Das kumulative Kontextbudget je Sitzung — im SCHATTEN (#458, Stufe „shadow").
 *
 * #266 baute den Governor, aber jede Lane ruft ihn für sich: Prompt, Bash-pre
 * und Write kennen kein Token-Budget, SessionStart ein Zeitbudget, und keine
 * weiß, was die anderen in derselben Sitzung schon ausgegeben haben. „Globales
 * Kontextbudget" hieß bisher: eine wiederverwendbare Kürzfunktion, keine
 * Schranke auf das, was das Transkript wächst.
 *
 * Dieses Modul führt das Ledger, das fehlte: je Sitzung die Summe dessen, was
 * die sechs automatischen Lanes TATSÄCHLICH emittiert haben, und trifft bei
 * jeder Emission die Entscheidung, die der Governor mit einem Sitzungsbudget
 * treffen würde — passt dieser Block noch in den Rest, oder fiele er?
 *
 * WAS ES NICHT TUT: kürzen. Die Entscheidung wird als `budget_shadow`-Ereignis
 * protokolliert und im Telemetry-Tab gezeigt; die Lane emittiert unverändert.
 * Erst wenn die Shadow-Daten mit dem #457-Ledger übereinstimmen und die
 * Budgethöhe aus gemessenen Zahlen feststeht, wird daraus ein Live-Profil
 * (Issue #458, Abschnitt 4). Bis dahin ist jede Zahl hier eine Messung, kein
 * Eingriff.
 *
 * Granularität: je EMISSION, nicht je Eintrag. Die Lanes rufen mit der Summe
 * ihres fertigen Blocks — dieselbe Zahl, die als `hint_tokens_est` ins Log
 * geht, damit der Schatten mit dem #457-Ledger aufgeht. Der Live-Governor
 * entscheidet später je Eintrag; die Schattenrechnung ist deshalb die obere
 * Grenze dessen, was ein Budget berührt (dieselbe Einschränkung wie das
 * What-if in stats-governor.ts).
 *
 * Reset-Vertrag (#458 §1): `clear` beginnt einen neuen Kontext und setzt das
 * Ledger zurück. `compact` und `resume` NICHT — der bisher injizierte Kontext
 * steht kompaktiert weiter im Transkript, und ein stilles Zurücksetzen würde
 * das Budget genau dann verdoppeln, wenn die Sitzung ohnehin lang ist.
 *
 * Das Ledger lebt im Speicher des Daemons, pseudonym (Session-ids, kein Text),
 * begrenzt auf die jüngsten Sitzungen. Ein Daemon-Neustart beginnt bei null —
 * das steht im Tab, weil eine Zahl ohne diese Grenze mehr wüsste, als sie kann.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fitsBudget } from "./context-governor.js";
import type { HookLaneKind } from "./context-ledger.js";
import { defaultLogDir } from "./telemetry.js";
import { envFirst } from "./env.js";

/**
 * Vorläufige Budgethöhe, aus dem #457-Ledger abgelesen (04.09.2026, dieser
 * Vault): Hook-Lane-Tokens je auswertbarer Sitzung (2+ Emissionen) lagen bei
 * p50 ≈ 3.800, p75 ≈ 7.200 (7 Tage) bzw. 7.500 (30 Tage), p90 ≈ 14.000. Das
 * p75 ist der Punkt, an dem ein Budget das teuerste Viertel der Sitzungen
 * berührt und die übrigen drei Viertel unangetastet lässt — eng genug, um im
 * Schatten etwas zu messen, weit genug, um nichts Gewöhnliches zu treffen.
 * Ein Vorschlag für die Messung, KEIN Default für den Live-Betrieb: Daniel
 * setzt den Wert ab ~10.09.2026 anhand der Shadow-Daten (#458 nennt 10.000 als
 * Canary-Kandidaten). Per Env überschreibbar, `0` = unbegrenzt (nur zählen).
 */
export const SESSION_BUDGET_SHADOW_TOKENS = 7500;

export function shadowBudgetTokens(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BASTRA_SESSION_BUDGET_SHADOW;
  if (raw === undefined || raw === "") return SESSION_BUDGET_SHADOW_TOKENS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : SESSION_BUDGET_SHADOW_TOKENS;
}

/** Höchstzahl gleichzeitig geführter Sitzungen; die älteste fällt zuerst. */
export const SESSION_BUDGET_MAX_SESSIONS = 2000;

export type BudgetLane = HookLaneKind;

interface LedgerRow {
  spent: number;
  emissions: number;
  /** Emissionen, die im Schatten gefallen wären. */
  wouldDrop: number;
  lanes: Partial<Record<BudgetLane, { tokens: number; emissions: number }>>;
  touched: number;
}

export interface BudgetShadowDecision {
  session_id: string;
  lane: BudgetLane;
  /** Was die Lane emittiert hat — geschätzte Token des fertigen Blocks. */
  tokens: number;
  budget: number;
  spent_before: number;
  /** Nach dieser Emission — sie wird IMMER angerechnet, weil sie stattfand. */
  spent_after: number;
  /** Rest vor dieser Emission; negativ, wenn das Budget schon überzogen war. */
  remaining_before: number;
  /** Der Governor-Entscheid: dieser Block hätte nicht mehr gepasst. */
  would_drop: boolean;
  /** Erste Emission dieser Sitzung, die nicht mehr passte. */
  first_over: boolean;
  /** Wievielte Emission der Sitzung. */
  emission_index: number;
  source?: string | null;
}

export class SessionBudgetLedger {
  private readonly rows = new Map<string, LedgerRow>();
  constructor(private readonly maxSessions = SESSION_BUDGET_MAX_SESSIONS) {}

  /**
   * Eine Emission anrechnen und den Schattenentscheid liefern. `tokens` ist
   * die Summe des fertigen Blocks; 0 heißt „nichts injiziert" und erzeugt
   * keine Entscheidung — es gab nichts zu entscheiden.
   */
  charge(sessionId: string, lane: BudgetLane, tokens: number, budget: number, source?: string | null): BudgetShadowDecision | null {
    if (!Number.isFinite(tokens) || tokens <= 0) return null;
    const row = this.row(sessionId);
    const before = row.spent;
    const fits = fitsBudget(before, tokens, budget);
    row.spent += tokens;
    row.emissions++;
    if (!fits) row.wouldDrop++;
    const l = (row.lanes[lane] ??= { tokens: 0, emissions: 0 });
    l.tokens += tokens;
    l.emissions++;
    return {
      session_id: sessionId,
      lane,
      tokens,
      budget,
      spent_before: before,
      spent_after: row.spent,
      remaining_before: budget > 0 ? budget - before : Number.POSITIVE_INFINITY,
      would_drop: !fits,
      first_over: !fits && row.wouldDrop === 1,
      emission_index: row.emissions,
      source: source ?? null,
    };
  }

  /** `clear`: ein neuer Kontext, das Ledger dieser Sitzung beginnt bei null. */
  reset(sessionId: string): void {
    this.rows.delete(sessionId);
  }

  spent(sessionId: string): number {
    return this.rows.get(sessionId)?.spent ?? 0;
  }

  size(): number {
    return this.rows.size;
  }

  private row(sessionId: string): LedgerRow {
    let row = this.rows.get(sessionId);
    if (!row) {
      if (this.rows.size >= this.maxSessions) {
        // Map iteriert in Einfügereihenfolge; die älteste Sitzung fällt.
        const oldest = this.rows.keys().next().value;
        if (oldest !== undefined) this.rows.delete(oldest);
      }
      row = { spent: 0, emissions: 0, wouldDrop: 0, lanes: {}, touched: 0 };
      this.rows.set(sessionId, row);
    }
    row.touched = Date.now();
    return row;
  }
}

/** Das eine Ledger des laufenden Daemons. */
export const sessionBudget = new SessionBudgetLedger();

/**
 * Was jede Lane an der Stelle ruft, an der sie `hint_tokens_est` protokolliert:
 * anrechnen, entscheiden, loggen — nie eingreifen, nie werfen. Ohne Session-id
 * gibt es kein Ledger (die Bash-Lane stempelt pro Aufruf eine synthetische id;
 * die als Sitzung zu führen hieße, tausende Einzelaufrufe als Sitzungen zu
 * zählen — dieselbe Ausnahme wie im What-if).
 */
export function recordBudgetShadow(
  sessionId: string | null | undefined,
  lane: BudgetLane,
  tokens: number,
  opts: { source?: string | null; ledger?: SessionBudgetLedger; budget?: number } = {},
): BudgetShadowDecision | null {
  if (typeof sessionId !== "string" || sessionId === "") return null;
  const ledger = opts.ledger ?? sessionBudget;
  const decision = ledger.charge(sessionId, lane, tokens, opts.budget ?? shadowBudgetTokens(), opts.source);
  if (decision) void writeBudgetShadow(decision);
  return decision;
}

/** `clear` beginnt einen neuen Kontext (#458 §1); compact/resume lassen das Ledger stehen. */
export function resetBudgetOnSource(sessionId: string | null | undefined, source: string | null | undefined, ledger = sessionBudget): void {
  if (source === "clear" && typeof sessionId === "string" && sessionId !== "") ledger.reset(sessionId);
}

async function writeBudgetShadow(decision: BudgetShadowDecision): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    const { remaining_before, ...rest } = decision;
    const event = {
      kind: "budget_shadow",
      ts,
      ...rest,
      // JSON kennt kein Infinity: unbegrenzt = null.
      remaining_before: Number.isFinite(remaining_before) ? remaining_before : null,
    };
    await appendFile(join(logDir, `events-${ts.slice(0, 10)}.jsonl`), JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Telemetrie darf die Lane nie brechen.
  }
}
