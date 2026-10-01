/**
 * The context readouts of the stats script (split out of stats.ts, #680):
 * the full context ledger (#457), the historical net-context ROI and the
 * session-budget what-if (#354).
 */
import { buildContextLedger, HOOK_LANE_KINDS, TOOL_PAYLOAD_KINDS } from "../src/context-ledger.js";
import { governorWhatIf } from "../src/stats-governor.js";
import { dimensionValue, type AnyEvent } from "./stats-shared.js";

/**
 * #457: die VOLLSTÄNDIGE Kontextrechnung — alle sechs Hook-Lanes plus die
 * Tool-Payloads (`recall`, `load_memory`, `read_document`). Der historische
 * `Net-context-ROI`-Block darunter zählt bewusst nur drei Lanes; er bleibt als
 * Vergleichsgröße stehen, beschreibt aber nicht „den Kontext".
 */
export function summarizeContextTax(events: AnyEvent[]): void {
  const ledger = buildContextLedger(events);
  const t = ledger.total;
  const emissions = [...Object.values(t.lanes), ...Object.values(t.tools)].reduce((s, p) => s + p.emissions, 0);
  if (emissions === 0) return;
  console.log(`\n## Context tax — complete  (ledger v${ledger.version}, estimator ${ledger.estimator})`);
  console.log(`  total (known parts):          ${t.totalTokens} tokens across ${emissions} emissions`);
  if (t.totalUnknown > 0) {
    console.log(
      `  unknown residual:             ${t.totalUnknown} emissions carry no size field (pre-#457/#72 rows) — the total is a lower bound`,
    );
  }
  const row = (label: string, p: { emissions: number; tokens: number; unknown: number }): void => {
    if (p.emissions === 0) return;
    console.log(
      `    ${label.padEnd(22)} ${p.tokens.toString().padStart(8)}  ${p.emissions.toString().padStart(5)} emissions` +
        (p.unknown > 0 ? `  (${p.unknown} unknown)` : ""),
    );
  };
  console.log(`  by lane:`);
  for (const k of HOOK_LANE_KINDS) row(k, t.lanes[k]);
  console.log(`  by tool payload:`);
  for (const k of TOOL_PAYLOAD_KINDS) row(k, t.tools[k]);
  if (t.loadByPresentation.lean.emissions + t.loadByPresentation.full.emissions > 0) {
    console.log(`  load_memory by presentation:`);
    row("lean", t.loadByPresentation.lean);
    row("full", t.loadByPresentation.full);
  }
  const laneSum = Object.values(t.lanes).reduce((s, p) => s + p.tokens, 0);
  const toolSum = Object.values(t.tools).reduce((s, p) => s + p.tokens, 0);
  console.log(`  parts: lanes ${laneSum} + tool payloads ${toolSum} = ${laneSum + toolSum}`);
  // #507: dieselbe Rechnung, gruppiert nach Oberfläche statt nach Session —
  // je Ausprägung ein eigener Ledger über dieselbe (gefilterte) Eventmenge,
  // damit `fold()` nicht zweimal geschrieben wird.
  for (const field of ["client", "hook_source"] as const) {
    const buckets = new Map<string, AnyEvent[]>();
    for (const e of events) {
      const key = dimensionValue(e, field);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(e);
      else buckets.set(key, [e]);
    }
    const rows = [...buckets.entries()]
      .map(([key, evs]) => [key, buildContextLedger(evs).total] as const)
      .filter(([, t2]) => [...Object.values(t2.lanes), ...Object.values(t2.tools)].some((p) => p.emissions > 0));
    if (rows.length === 0) continue;
    console.log(`  by ${field}:`);
    for (const [key, t2] of rows.sort((a, b) => b[1].totalTokens - a[1].totalTokens)) {
      const em = [...Object.values(t2.lanes), ...Object.values(t2.tools)].reduce((s, p) => s + p.emissions, 0);
      console.log(`    ${key.padEnd(22)} ${t2.totalTokens.toString().padStart(8)}  ${em.toString().padStart(5)} emissions`);
    }
  }
  const top = [...ledger.sessions.values()]
    .filter((s) => s.session !== "(none)")
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 5);
  if (top.length > 0) {
    console.log(`  top sessions by total context:`);
    for (const s of top) console.log(`    ${s.totalTokens.toString().padStart(7)}  ${s.session.slice(0, 8)}…`);
  }
  console.log(
    `  (tool payloads are attributed to the caller session where the forwarder sent one; hook lanes to their own session_id)`,
  );
}

export function summarizeContextROI(events: AnyEvent[]): void {
  // #72 net-context-ROI: Tokens, die die Reflex-Layer-Hooks injiziert haben,
  // vs. acted-on-Loads, die sie verursacht haben. hint_tokens_est gibt es
  // erst ab dem #72-Build — Alt-Events zählen 0, die Quote wächst ehrlich
  // mit frischen Daten.
  const hookKinds = new Set(["hook_call", "session_hook_call", "bash_hook_call"]);
  const hookEvents = events.filter((e) => hookKinds.has(String(e.kind)));
  const withTokens = hookEvents.filter((e) => typeof e.hint_tokens_est === "number");
  if (withTokens.length === 0) return;

  const totalTokens = withTokens.reduce((sum, e) => sum + Number(e.hint_tokens_est), 0);
  const episodes = events.filter((e) => e.kind === "recall_episode");
  const isSurfaced = (e: AnyEvent): boolean =>
    typeof e.surfaced === "boolean" ? Boolean(e.surfaced) : e.surfaced_score != null;
  const actedSurfaced = episodes.filter((e) => isSurfaced(e) && e.acted_on === true);
  const hookRecalls = events.filter((e) => e.kind === "hook_recall");
  const byRecallId = new Map<string, AnyEvent>();
  for (const r of hookRecalls) byRecallId.set(String(r.recall_id), r);

  // `totalTokens` only sums the 3 lanes in `hookKinds` (pre-tool,
  // session, bash-pre) — but `actedSurfaced` above counts acted-on episodes
  // from EVERY lane, including mcp/prompt/bash-fail/todo, whose tokens never
  // entered totalTokens. Dividing the two mixes tokens spent by one
  // population with loads caused by another. The ratio below uses only the
  // acted-on loads whose surfacing lane is one of the 3 in the numerator.
  // Event kind -> hook_source on the lane's hook_recall: hook_call -> "pre-tool",
  // bash_hook_call -> "bash-pre", session_hook_call -> "session-context" (the shared
  // assembler's stamp; "session" is only the lane's own hook_call dimension).
  const numeratorHookSources = new Set(["pre-tool", "session", "session-context", "bash-pre"]);
  const sourceForRatio = (e: AnyEvent): string | null => {
    const dimensions = byRecallId.get(String(e.recall_id))?.dimensions;
    if (!dimensions || typeof dimensions !== "object") return null;
    const source = (dimensions as Record<string, unknown>).hook_source;
    return typeof source === "string" && source !== "unknown" ? source : null;
  };
  const ratioSources = actedSurfaced.map(sourceForRatio);
  const actedFromNumeratorLanes = ratioSources.filter(
    (source) => source !== null && numeratorHookSources.has(source),
  ).length;
  const unattributed = ratioSources.filter((source) => source === null).length;

  // #161: Backoff-Ersparnis — Events, deren Injektion der Empty-Streak-
  // Backoff unterdrückt hat, tragen suppressed_tokens_est als Sparseite.
  const allHookKinds = new Set([
    ...hookKinds,
    "bash_fail_hook_call",
    "prompt_hook_call",
    "todo_hook_call",
  ]);
  const suppressedEvents = events.filter(
    (e) => allHookKinds.has(String(e.kind)) && e.suppressed === true,
  );
  const savedTokens = suppressedEvents.reduce(
    (sum, e) => sum + (typeof e.suppressed_tokens_est === "number" ? Number(e.suppressed_tokens_est) : 0),
    0,
  );

  console.log(`\n## Net-context-ROI  (hint tokens spent vs. acted-on loads they caused)`);
  console.log(`  injected hint tokens (est.):  ${totalTokens}  across ${withTokens.length} hook emissions`);
  if (suppressedEvents.length > 0) {
    console.log(
      `  backoff-suppressed (#161):    ${suppressedEvents.length} emissions skipped, ~${savedTokens} hint tokens saved`,
    );
  }
  console.log(`  acted-on surfaced loads:      ${actedSurfaced.length}`);

  // #263/§17.4: the dimension split here attributes the yield side. Hook
  // emissions carry dimensions since #507, but this historical ROI section
  // does not calculate a per-dimension token sum. Older recall rows without
  // dimensions remain unattributed rather than being guessed from tool_name.
  for (const field of ["client", "hook_source", "arm"] as const) {
    const actedBy = new Map<string, number>();
    for (const e of actedSurfaced) {
      const key = dimensionValue(byRecallId.get(String(e.recall_id)), field);
      actedBy.set(key, (actedBy.get(key) ?? 0) + 1);
    }
    if (actedBy.size === 0) continue;
    console.log(`  acted-on loads by ${field}:`);
    for (const [key, n] of [...actedBy.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${key.padEnd(14)} ${n.toString().padStart(4)}`);
    }
  }
  console.log(
    `  (token side is limited to pre-tool/session/bash-pre event kinds; the dimension split above covers acted-on loads)`,
  );
  const coverage =
    `(${actedFromNumeratorLanes} of ${actedSurfaced.length} acted-on from counted lanes; ` +
    `${unattributed} unattributed without a usable hook source)`;
  console.log(
    actedFromNumeratorLanes > 0
      ? `  tokens per acted-on load:     ~${Math.round(totalTokens / actedFromNumeratorLanes)}  ${coverage}`
      : unattributed > 0
        ? `  tokens per acted-on load:     n/a ${coverage} — an unassigned load may belong to the counted lanes`
        : `  tokens per acted-on load:     ∞ ${coverage} — no attributable load from the counted lanes`,
  );

  // Per-session injected tokens (top 5 by cost).
  const perSession = new Map<string, number>();
  for (const e of withTokens) {
    const sid = String(e.session_id ?? "(none)");
    perSession.set(sid, (perSession.get(sid) ?? 0) + Number(e.hint_tokens_est));
  }
  const topSessions = [...perSession.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log(`  top sessions by injected tokens:`);
  for (const [sid, n] of topSessions) {
    console.log(`    ${n.toString().padStart(6)}  ${sid.slice(0, 8)}…`);
  }

  // Context-Tax: Memories, die oft emittiert werden, aber nie eine acted-on-
  // Episode verursachen.
  //
  // #354 — WARUM DIESE LISTE ZWEIGETEILT IST, und warum die eine Hälfte KEINE
  // Archiv-Kandidaten sind: `acted_on` misst, ob ein geladener Hint den
  // nächsten Tool-Input verändert hat. Für eine Direktive („niemals X ohne
  // Auftrag", „erst fragen, dann löschen") kann dieses Signal per Konstruktion
  // nicht entstehen — sie wirkt, indem NICHTS passiert. In der ungeteilten
  // Liste standen genau solche Regeln ganz oben und sahen aus wie der größte
  // Ballast im Vault. Nach `acted_on = 0` auszumisten hätte zielsicher die
  // wirksamen Regeln gelöscht und die geschwätzigen behalten.
  //
  // Die Zuordnung ist eine Heuristik über den Memory-Typ, keine Messung: Typen,
  // die Verhalten vorschreiben, gegen Typen, die etwas behaupten. `lesson` zählt
  // bewusst zu den bewertbaren — eine Lesson trägt meist einen Fix, den man
  // anwendet, und schlägt sich dann in `acted_on` nieder.
  const DIRECTIVE_TYPES = new Set(["preference", "user-preference", "meta-working", "workflow"]);
  const emitted = new Map<string, number>();
  const typeById = new Map<string, string>();
  for (const e of hookEvents) {
    if (!Array.isArray(e.hinted_ids)) continue;
    const ids = e.hinted_ids as string[];
    const types = Array.isArray(e.hinted_types) ? (e.hinted_types as string[]) : [];
    ids.forEach((id, i) => {
      emitted.set(id, (emitted.get(id) ?? 0) + 1);
      // Gleiche Reihenfolge und Länge per Lane-Vertrag; ältere Events tragen
      // das Feld nicht, die bleiben "unknown" statt geraten zu werden.
      if (types[i]) typeById.set(id, types[i]);
    });
  }
  const actedByMemory = new Map<string, number>();
  for (const e of actedSurfaced) {
    const id = String(e.memory_id);
    actedByMemory.set(id, (actedByMemory.get(id) ?? 0) + 1);
  }
  const unused = [...emitted.entries()]
    .map(([id, n]) => ({ id, emitted: n, type: typeById.get(id) ?? "unknown" }))
    .filter((t) => (actedByMemory.get(t.id) ?? 0) === 0 && t.emitted >= 3)
    .sort((a, b) => b.emitted - a.emitted);
  const archival = unused.filter((t) => !DIRECTIVE_TYPES.has(t.type));
  const directives = unused.filter((t) => DIRECTIVE_TYPES.has(t.type));
  if (archival.length > 0) {
    console.log(`  top context-tax memories (emitted ≥3×, acted_on 0 — archival candidates):`);
    for (const t of archival.slice(0, 10)) {
      console.log(`    ${t.emitted.toString().padStart(4)}×  [${t.type}] ${t.id}`);
    }
  }
  if (directives.length > 0) {
    console.log(
      `  directive-type memories with acted_on 0 (${directives.length}) — NOT archival candidates:`,
    );
    console.log(`    a rule that works produces no acted_on signal; this list is not evidence of waste`);
    for (const t of directives.slice(0, 10)) {
      console.log(`    ${t.emitted.toString().padStart(4)}×  [${t.type}] ${t.id}`);
    }
  }
  const unknownTyped = unused.filter((t) => t.type === "unknown").length;
  if (unknownTyped > 0) {
    console.log(
      `  (${unknownTyped} of them from events before hinted_types existed — counted as archival, unverified)`,
    );
  }
}

/**
 * Was ein Sitzungsbudget gekostet hätte (#354).
 *
 * Die Frage, die #354 stellt, ist nicht „wieviel Kontext kostet uns das" — das
 * beantwortet der ROI-Abschnitt oben. Sie lautet: Was hätte ein Budget
 * abgeschnitten? Ohne diese Gegenfrage ist jede Budgetzahl geraten.
 *
 * Die Rechnung steht in `stats-governor.ts`; hier wird nur gedruckt. Ihre
 * Grenze steht in der Ausgabe, weil eine Zahl ohne ihre Grenze schlechter ist
 * als keine.
 */
export function summarizeContextGovernor(events: AnyEvent[]): void {
  // Drei Stufen um den beobachteten Median: knapp darunter, darüber, weit
  // darüber. Über `--budgets` überschreibbar, damit eine andere Maschine ihre
  // eigenen Größenordnungen durchrechnen kann.
  const arg = process.argv.indexOf("--budgets");
  const budgets =
    arg >= 0 && process.argv[arg + 1]
      ? process.argv[arg + 1]
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n > 0)
      : [2000, 5000, 10000];

  const wi = governorWhatIf(events, budgets);
  if (wi.sessionsMultiEmission === 0) return;

  console.log(`\n## Context governor  (#354 — what a session budget would have trimmed)`);
  console.log(
    `  today: no budget is set — \`governContext\` defaults to 0 (unlimited) on all three wired lanes`,
  );
  console.log(
    `  sessions with injections:     ${wi.sessionsWithInjection}  (of those, ${wi.sessionsMultiEmission} with 2+ — only these are readable as a session)`,
  );
  console.log(
    `  hint tokens per session:      p50 ${wi.tokensPerSession.p50}  p75 ${wi.tokensPerSession.p75}  p90 ${wi.tokensPerSession.p90}  max ${wi.tokensPerSession.max}`,
  );
  console.log(
    `  injections per session:       p50 ${wi.emissionsPerSession.p50}  p90 ${wi.emissionsPerSession.p90}  max ${wi.emissionsPerSession.max}`,
  );
  console.log(`  budget      sessions hit   injections trimmed   tokens trimmed`);
  for (const r of wi.rows) {
    console.log(
      `  ${String(r.budget).padStart(6)}   ${String(r.sessionsAffected).padStart(13)}   ${String(r.emissionsTrimmed).padStart(18)}   ${String(r.tokensTrimmed).padStart(14)}`,
    );
  }
  console.log(
    `  (per-injection granularity: the events carry one token sum per injection, while the governor`,
  );
  console.log(
    `   decides per ENTRY by priority — so this is coarser than the governor and reads as an upper bound`,
  );
  console.log(
    `   on what a budget touches. Single-injection sessions are excluded: the bash lane stamps a fresh`,
  );
  console.log(`   synthetic session id per call.)`);
}
