/**
 * Read ~/.bastra/logs/events-*.jsonl (mit Legacy-Fallback auf
 * ~/.nexus-recall/logs/) and print a summary.
 *
 * Usage:
 *   npx tsx packages/daemon/scripts/stats.ts            # all-time
 *   npx tsx packages/daemon/scripts/stats.ts --days 7   # last 7 days
 */
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readUsage, type UsageAggregate } from "../src/usage-sidecar.js";
import { governorWhatIf } from "../src/stats-governor.js";
import { summarizeEvidenceGate } from "./stats-evidence.js";
import { buildContextLedger, HOOK_LANE_KINDS, TOOL_PAYLOAD_KINDS } from "../src/context-ledger.js";

function defaultLogDir(): string {
  const next = join(homedir(), ".bastra", "logs");
  const legacy = join(homedir(), ".nexus-recall", "logs");
  if (existsSync(next)) return next;
  if (existsSync(legacy)) return legacy;
  return next;
}

const LOG_DIR =
  process.env.BASTRA_LOG_PATH ?? process.env.NEXUS_LOG_PATH ?? defaultLogDir();

// Band-Schwellen müssen mit telemetry.ts (bandForScore) übereinstimmen — sonst
// werden surfaced-Bänder (hier aus hits[].score) und loaded/acted-Bänder
// (episode.band, daemon-seitig env-getrieben) auf verschiedenen Cut-Points
// berechnet und die USE-rate-Tabelle vergleicht still falsche Bänder.
const MUST_LOAD_SCORE = Number(process.env.BASTRA_MUST_LOAD_SCORE ?? 100);
const SCORE_FLOOR = Number(process.env.BASTRA_RECALL_FLOOR ?? 30);

const daysArg = process.argv.indexOf("--days");
const DAYS: number | null =
  daysArg >= 0 && process.argv[daysArg + 1] ? parseInt(process.argv[daysArg + 1], 10) : null;

interface AnyEvent {
  kind: string;
  ts: string;
  [k: string]: unknown;
}

function pct(n: number, total: number): string {
  if (total === 0) return "—";
  return `${((n / total) * 100).toFixed(1)}%`;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function p95(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

async function loadEvents(): Promise<AnyEvent[]> {
  let files: string[];
  try {
    files = (await readdir(LOG_DIR)).filter((f) => f.startsWith("events-") && f.endsWith(".jsonl"));
  } catch {
    console.error(`no logs found at ${LOG_DIR}`);
    process.exit(1);
  }
  files.sort();

  const cutoff = DAYS !== null ? Date.now() - DAYS * 24 * 60 * 60 * 1000 : 0;
  const out: AnyEvent[] = [];
  for (const f of files) {
    const raw = await readFile(join(LOG_DIR, f), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as AnyEvent;
        if (cutoff && new Date(e.ts).getTime() < cutoff) continue;
        out.push(e);
      } catch {
        // skip malformed
      }
    }
  }
  return out;
}

function summarizeHook(events: AnyEvent[]): void {
  const calls = events.filter((e) => e.kind === "hook_call");
  const recalls = events.filter((e) => e.kind === "hook_recall");

  if (calls.length === 0) {
    console.log("no hook_call events.");
    return;
  }

  const statuses = new Map<string, number>();
  const reachable = calls.filter((e) => e.daemon_reachable === true).length;
  for (const c of calls) {
    const s = String(c.status ?? "unknown");
    statuses.set(s, (statuses.get(s) ?? 0) + 1);
  }

  const totalLatencies = calls.map((c) => Number(c.latency_ms_total ?? 0));
  const recallLatencies = recalls.map((r) => Number(r.latency_ms_recall ?? 0));
  const httpLatencies = recalls.map((r) => Number(r.latency_ms_total ?? 0));

  const hintCounts = calls.map((c) => Number(c.hint_count ?? 0));
  const withHints = hintCounts.filter((n) => n > 0).length;

  const topScores = calls
    .map((c) => (c.top_score === null ? null : Number(c.top_score)))
    .filter((s): s is number => s !== null);
  const above100 = topScores.filter((s) => s >= 100).length;
  const above50 = topScores.filter((s) => s >= 50 && s < 100).length;
  const above30 = topScores.filter((s) => s >= 30 && s < 50).length;
  const below30 = topScores.filter((s) => s < 30).length;

  console.log(`\n## PreToolUse hook  (${calls.length} invocations)`);
  console.log(`  daemon reachable: ${reachable}  (${pct(reachable, calls.length)})`);
  console.log(`  with hints:       ${withHints}  (${pct(withHints, calls.length)})`);
  console.log(`  status breakdown:`);
  for (const [s, n] of [...statuses.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${n.toString().padStart(4)}  ${s}`);
  }
  console.log(`  hook latency_ms_total:   median ${median(totalLatencies).toFixed(0).padStart(4)}   p95 ${p95(totalLatencies).toFixed(0).padStart(4)}`);
  console.log(`  daemon latency_ms_recall: median ${median(recallLatencies).toFixed(0).padStart(4)}   p95 ${p95(recallLatencies).toFixed(0).padStart(4)}`);
  console.log(`  daemon latency_ms_total: median ${median(httpLatencies).toFixed(0).padStart(4)}   p95 ${p95(httpLatencies).toFixed(0).padStart(4)}`);
  console.log(`  top-score distribution (top candidate per reachable call, pre-dedup — a high score with 0 hints = deduped/scope-filtered):`);
  console.log(`     ≥ 100:  ${above100.toString().padStart(4)}  (${pct(above100, topScores.length)})`);
  console.log(`     50-99:  ${above50.toString().padStart(4)}  (${pct(above50, topScores.length)})`);
  console.log(`     30-49:  ${above30.toString().padStart(4)}  (${pct(above30, topScores.length)})`);
  console.log(`     <  30:  ${below30.toString().padStart(4)}  (${pct(below30, topScores.length)})`);
}

function summarizeSessionHook(events: AnyEvent[]): void {
  const calls = events.filter((e) => e.kind === "session_hook_call");
  if (calls.length === 0) return;

  const reachable = calls.filter((e) => e.daemon_reachable === true).length;
  const withHints = calls.filter((c) => Number(c.hint_count ?? 0) > 0).length;
  const lats = calls.map((c) => Number(c.latency_ms_total ?? 0));
  const sources = new Map<string, number>();
  for (const c of calls) {
    const s = String(c.source ?? "unknown");
    sources.set(s, (sources.get(s) ?? 0) + 1);
  }

  console.log(`\n## SessionStart hook  (${calls.length} invocations)`);
  console.log(`  daemon reachable: ${reachable}  (${pct(reachable, calls.length)})`);
  console.log(`  with hints:       ${withHints}  (${pct(withHints, calls.length)})`);
  console.log(`  latency_ms_total: median ${median(lats).toFixed(0)}   p95 ${p95(lats).toFixed(0)}`);
  console.log(`  by source:`);
  for (const [s, n] of [...sources.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${n.toString().padStart(4)}  ${s}`);
  }

  // #462: welcher der zehn Teile gibt die Tokens aus? Nur Zeilen mit dem
  // Feld (ab #462); ältere Starts tragen eine Summe und keine Teile.
  const withParts = calls.filter((c) => c.hint_tokens_by_part && typeof c.hint_tokens_by_part === "object");
  if (withParts.length === 0) return;
  const partTotals = new Map<string, number>();
  const partHits = new Map<string, number>();
  let allParts = 0;
  for (const c of withParts) {
    for (const [part, v] of Object.entries(c.hint_tokens_by_part as Record<string, unknown>)) {
      const n = typeof v === "number" ? v : 0;
      partTotals.set(part, (partTotals.get(part) ?? 0) + n);
      if (n > 0) partHits.set(part, (partHits.get(part) ?? 0) + 1);
      allParts += n;
    }
  }
  console.log(`  tokens by part (${withParts.length} starts with per-part data, ${allParts} tokens):`);
  console.log(`     part          total   share   avg/start  present-in`);
  for (const [part, total] of [...partTotals.entries()].sort((a, b) => b[1] - a[1])) {
    if (total === 0 && (partHits.get(part) ?? 0) === 0) continue;
    console.log(
      `     ${part.padEnd(12)} ${total.toString().padStart(6)}  ${pct(total, allParts).padStart(6)}  ${(total / withParts.length).toFixed(0).padStart(9)}  ${(partHits.get(part) ?? 0).toString().padStart(4)}/${withParts.length}`,
    );
  }
  // Derselbe Schnitt nach Startquelle — `clear` war der teuerste Start.
  const bySource = new Map<string, { n: number; parts: Map<string, number> }>();
  for (const c of withParts) {
    const s = String(c.source ?? "unknown");
    const row = bySource.get(s) ?? { n: 0, parts: new Map<string, number>() };
    row.n++;
    for (const [part, v] of Object.entries(c.hint_tokens_by_part as Record<string, unknown>)) {
      row.parts.set(part, (row.parts.get(part) ?? 0) + (typeof v === "number" ? v : 0));
    }
    bySource.set(s, row);
  }
  console.log(`  avg tokens per part by source:`);
  for (const [s, row] of [...bySource.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const top = [...row.parts.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([p, v]) => `${p} ${(v / row.n).toFixed(0)}`).join(", ");
    console.log(`     ${s.padEnd(8)} n=${row.n.toString().padStart(3)}  ${top}`);
  }
}

function summarizeMcp(events: AnyEvent[]): void {
  const recalls = events.filter((e) => e.kind === "recall");
  const loads = events.filter((e) => e.kind === "load_memory");
  const saves = events.filter((e) => e.kind === "save_memory");

  console.log(`\n## MCP tools`);
  console.log(`  recall:       ${recalls.length}`);
  console.log(`  load_memory:  ${loads.length}`);
  console.log(`  save_memory:  ${saves.length}`);

  if (recalls.length) {
    const lats = recalls.map((r) => Number(r.latency_ms ?? 0));
    console.log(`  recall latency_ms: median ${median(lats).toFixed(0)}   p95 ${p95(lats).toFixed(0)}`);
  }

  // Save → was there a preceding recall?
  if (saves.length) {
    const followsRecall = saves.filter((s) => s.follows_recall != null).length;
    console.log(`  saves following a recall (≤5min): ${followsRecall} of ${saves.length}  (${pct(followsRecall, saves.length)})`);
  }
}

function summarizeFollowThrough(events: AnyEvent[]): void {
  const loads = events.filter((e) => e.kind === "load_memory");
  const hookRecalls = events.filter((e) => e.kind === "hook_recall");
  if (loads.length === 0 && hookRecalls.length === 0) return;

  const fromHook = loads.filter((l) => l.from_hook_recall != null);
  const distinctHookRecallsConsumed = new Set(
    fromHook.map((l) => String(l.from_hook_recall)),
  );

  const rankCounts = new Map<number, number>();
  for (const l of fromHook) {
    const r = Number(l.hook_hint_rank ?? 0);
    if (r > 0) rankCounts.set(r, (rankCounts.get(r) ?? 0) + 1);
  }

  console.log(`\n## Follow-through  (did hook hints actually get loaded?)`);
  console.log(`  load_memory total:                ${loads.length}`);
  console.log(`  load_memory triggered by a hint:  ${fromHook.length}  (${pct(fromHook.length, loads.length)})`);
  console.log(`  hook_recalls that produced ≥1 load: ${distinctHookRecallsConsumed.size} of ${hookRecalls.length}  (${pct(distinctHookRecallsConsumed.size, hookRecalls.length)})`);
  if (rankCounts.size > 0) {
    console.log(`  loaded-from-hint by rank in hint list:`);
    for (const [r, n] of [...rankCounts.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(`     rank ${r}:  ${n.toString().padStart(4)}`);
    }
  }
}

// #144: PostToolUse:Bash act-signals — the widened acted_on measuring surface.
// Every completed Bash command pings /hook/act; matched_episodes > 0 means the
// signal closed episodes that were previously structurally invisible.
function summarizeActSignals(events: AnyEvent[]): void {
  const acts = events.filter((e) => e.kind === "hook_act");
  if (acts.length === 0) return;
  const matched = acts.reduce((sum, e) => sum + Number(e.matched_episodes ?? 0), 0);
  const success = acts.filter((e) => Number(e.exit_code ?? -1) === 0).length;
  console.log(`\n## Act-signals  (#144 — PostToolUse Bash pings closing episodes)`);
  console.log(`  pings:            ${acts.length}  (${success} from successful commands)`);
  console.log(`  episodes closed:  ${matched}`);
}

function summarizeUseRate(events: AnyEvent[]): void {
  const hookRecalls = events.filter((e) => e.kind === "hook_recall" && Array.isArray(e.hits));
  const episodes = events.filter((e) => e.kind === "recall_episode");
  if (hookRecalls.length === 0 && episodes.length === 0) return;

  // #77: Direkt-Loads ohne Hook-Hint fliegen aus den Band-Quoten — sonst
  // teilt below_floor acted-on-Direkt-Loads durch <30-Score-Hints (zwei
  // fremde Populationen). Alt-Events ohne `surfaced`-Feld werden über
  // surfaced_score != null erkannt (das war genau dann gesetzt, wenn ein
  // Hint voranging).
  const isSurfaced = (e: AnyEvent): boolean =>
    typeof e.surfaced === "boolean" ? Boolean(e.surfaced) : e.surfaced_score != null;
  const surfacedEpisodes = episodes.filter(isSurfaced);
  const directLoads = episodes.length - surfacedEpisodes.length;

  const bands = ["required", "optional", "below_floor"] as const;
  const surfaced = new Map<string, number>(bands.map((band) => [band, 0]));
  const loaded = new Map<string, number>(bands.map((band) => [band, 0]));
  const acted = new Map<string, number>(bands.map((band) => [band, 0]));

  for (const r of hookRecalls) {
    const hits = r.hits as Array<{ score?: number }>;
    for (const h of hits) {
      const score = Number(h.score ?? 0);
      const band = score >= MUST_LOAD_SCORE ? "required" : score >= SCORE_FLOOR ? "optional" : "below_floor";
      surfaced.set(band, (surfaced.get(band) ?? 0) + 1);
    }
  }

  for (const e of surfacedEpisodes) {
    const band = bands.includes(e.band as typeof bands[number])
      ? String(e.band)
      : "below_floor";
    loaded.set(band, (loaded.get(band) ?? 0) + 1);
    if (e.acted_on === true) acted.set(band, (acted.get(band) ?? 0) + 1);
  }

  console.log(`\n## USE-rate  (did loaded hints affect the next tool input?)`);
  for (const band of bands) {
    const s = surfaced.get(band) ?? 0;
    const l = loaded.get(band) ?? 0;
    const a = acted.get(band) ?? 0;
    // acted_on/surfaced ist der Funnel-Endpunkt (von Repeat-Resurfacing
    // verwässert); acted_on/loaded ist die EHRLICHE USE-rate, die die
    // Header-Frage „haben geladene Hints den nächsten Input beeinflusst?"
    // beantwortet — sonst liest man pct(a,s)≈0 als „wirkt nicht".
    console.log(`  ${band.padEnd(11)} surfaced ${s.toString().padStart(4)}  loaded ${l.toString().padStart(4)} (${pct(l, s)})  acted_on ${a.toString().padStart(4)}  (${pct(a, l)} of loaded · ${pct(a, s)} of surfaced)`);
  }
  if (directLoads > 0) {
    console.log(`  (excluded: ${directLoads} direct load(s) with no preceding hint — not part of any band quota)`);
  }

  // #71: Tripwire-Hints (bash-pre-hook, tool_name="Bash") getrennt von den
  // positiven Write/Edit-Hints ausweisen — die These ist, dass negative
  // Hints am gefährlichen Befehl eine deutlich höhere USE-rate haben.
  const recallTool = new Map<string, string>();
  for (const r of hookRecalls) recallTool.set(String(r.recall_id), String(r.tool_name ?? ""));
  const sourceOf = (e: AnyEvent): "bash-tripwire" | "write-edit" =>
    recallTool.get(String(e.recall_id)) === "Bash" ? "bash-tripwire" : "write-edit";

  const hintsBySource = { "bash-tripwire": 0, "write-edit": 0 };
  for (const r of hookRecalls) {
    const src = String(r.tool_name ?? "") === "Bash" ? "bash-tripwire" : "write-edit";
    hintsBySource[src] += (r.hits as unknown[]).length;
  }
  const epBySource = { "bash-tripwire": [0, 0], "write-edit": [0, 0] } as Record<string, [number, number]>;
  for (const e of surfacedEpisodes) {
    const src = sourceOf(e);
    epBySource[src][0]++;
    if (e.acted_on === true) epBySource[src][1]++;
  }
  console.log(`  by hint source:`);
  for (const src of ["bash-tripwire", "write-edit"] as const) {
    const s = hintsBySource[src];
    const [l, a] = epBySource[src];
    console.log(`    ${src.padEnd(14)} surfaced ${s.toString().padStart(4)}  loaded ${l.toString().padStart(4)} (${pct(l, s)})  acted_on ${a.toString().padStart(4)} (${pct(a, s)})`);
  }

  // #263/§17.4 Punkt 5: „Auswertung getrennt nach Client, Hook-Quelle und
  // Query-Klasse". Die Episode selbst trägt keine Dimensionen — sie hängt über
  // `recall_id` an dem hook_recall, der sie ausgelöst hat, und DER trägt sie.
  // Derselbe Join, den `recallTool` oben schon benutzt.
  for (const dim of ["client", "hook_source", "arm"] as const) {
    printDimensionSplit(dim, hookRecalls, surfacedEpisodes);
  }
}

/** Vor #263 geschriebene Ereignisse haben die Spalte nicht. Das ist etwas
 *  anderes als `unknown` („Oberfläche hat sich nicht ausgewiesen") und wird
 *  deshalb auch anders benannt — sonst liest man Altbestand als Messwert. */
const PRE_DIMENSIONS = "(pre-#263)";

function dimensionValue(event: AnyEvent | undefined, field: "client" | "hook_source" | "arm"): string {
  if (!event) return PRE_DIMENSIONS;
  const dims = event.dimensions as Record<string, unknown> | undefined;
  if (!dims) return PRE_DIMENSIONS;
  const raw = dims[field];
  return typeof raw === "string" ? raw : "unknown";
}

/**
 * Use-Rate je Ausprägung einer Dimension.
 *
 * `surfaced` kommt aus den Hits der hook_recalls, `loaded`/`acted_on` aus den
 * Episoden, die über `recall_id` daran hängen — beide Seiten also aus derselben
 * Population, sonst teilte man Zähler und Nenner aus zwei verschiedenen Welten.
 */
function printDimensionSplit(
  field: "client" | "hook_source" | "arm",
  hookRecalls: AnyEvent[],
  surfacedEpisodes: AnyEvent[],
): void {
  const byRecallId = new Map<string, AnyEvent>();
  for (const r of hookRecalls) byRecallId.set(String(r.recall_id), r);

  const surfaced = new Map<string, number>();
  const loaded = new Map<string, number>();
  const acted = new Map<string, number>();
  const bump = (m: Map<string, number>, key: string, n = 1): void => {
    m.set(key, (m.get(key) ?? 0) + n);
  };

  for (const r of hookRecalls) {
    bump(surfaced, dimensionValue(r, field), (r.hits as unknown[]).length);
  }
  for (const e of surfacedEpisodes) {
    const key = dimensionValue(byRecallId.get(String(e.recall_id)), field);
    bump(loaded, key);
    if (e.acted_on === true) bump(acted, key);
  }

  const keys = [...new Set([...surfaced.keys(), ...loaded.keys()])].sort();
  if (keys.length === 0) return;
  console.log(`  by ${field}:`);
  if (field === "arm" && keys.every((k) => k === "unassigned" || k === PRE_DIMENSIONS)) {
    // §17.4/#267: `unassigned` ist kein Arm, sondern die Abwesenheit eines
    // Experiments. Ohne diesen Satz liest jemand die Zeile als Armvergleich mit
    // einem Arm — und das wäre eine Aussage, die niemand gemacht hat.
    console.log(`    (no experiment configured — \`unassigned\` is the absence of an arm, not an arm)`);
  }
  for (const key of keys) {
    const s = surfaced.get(key) ?? 0;
    const l = loaded.get(key) ?? 0;
    const a = acted.get(key) ?? 0;
    console.log(
      `    ${key.padEnd(14)} surfaced ${s.toString().padStart(4)}  loaded ${l.toString().padStart(4)} (${pct(l, s)})  acted_on ${a.toString().padStart(4)}  (${pct(a, l)} of loaded)`,
    );
  }
}

function topHints(events: AnyEvent[]): void {
  const recalls = events.filter((e) => e.kind === "hook_recall" && Array.isArray(e.hits));
  const idCount = new Map<string, number>();
  for (const r of recalls) {
    const hits = r.hits as Array<{ id: string; score: number }>;
    for (const h of hits.slice(0, 1)) {
      // Only count the top hit per call to avoid inflating long-tail.
      idCount.set(h.id, (idCount.get(h.id) ?? 0) + 1);
    }
  }
  if (idCount.size === 0) return;
  const top = [...idCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log(`\n## Top-hit memorys (rank 1 from hook recall)`);
  for (const [id, n] of top) {
    console.log(`  ${n.toString().padStart(4)}  ${id}`);
  }
}

function topProjects(events: AnyEvent[]): void {
  const recalls = events.filter((e) => e.kind === "hook_recall");
  const projCount = new Map<string, number>();
  for (const r of recalls) {
    const p = r.project ? String(r.project) : "(no-project)";
    projCount.set(p, (projCount.get(p) ?? 0) + 1);
  }
  if (projCount.size === 0) return;
  console.log(`\n## Hook calls by project`);
  for (const [p, n] of [...projCount.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(4)}  ${p}`);
  }
}

/**
 * #457: die VOLLSTÄNDIGE Kontextrechnung — alle sechs Hook-Lanes plus die
 * Tool-Payloads (`recall`, `load_memory`, `read_document`). Der historische
 * `Net-context-ROI`-Block darunter zählt bewusst nur drei Lanes; er bleibt als
 * Vergleichsgröße stehen, beschreibt aber nicht „den Kontext".
 */
function summarizeContextTax(events: AnyEvent[]): void {
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

function summarizeContextROI(events: AnyEvent[]): void {
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

  // #263/§17.4: der ROI getrennt nach Oberfläche — soweit die Daten es
  // hergeben. Die TOKENSEITE stammt aus den Hook-CLI-Events (`hook_call` &
  // Co.), die eigene Prozesse mit eigenen Telemetrie-Interfaces schreiben und
  // die Dimensionen nicht führen. Attribuierbar ist deshalb nur die
  // Ertragsseite. Eine Zuordnung der Tokens über die Session zu erraten wäre
  // eine Zahl mit einer Genauigkeit, die sie nicht hat.
  const hookRecalls = events.filter((e) => e.kind === "hook_recall");
  const byRecallId = new Map<string, AnyEvent>();
  for (const r of hookRecalls) byRecallId.set(String(r.recall_id), r);
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
    `  (token side not split: hook-CLI emissions carry no dimensions — only the yield side is attributable)`,
  );
  console.log(
    actedSurfaced.length > 0
      ? `  tokens per acted-on load:     ~${Math.round(totalTokens / actedSurfaced.length)}`
      : `  tokens per acted-on load:     ∞ (no acted-on load yet — pure context tax so far)`,
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

function summarizeOllamaLifecycle(events: AnyEvent[]): void {
  const lifecycle = events.filter((e) => e.kind === "ollama_lifecycle");
  if (lifecycle.length === 0) return;
  const prewarms = lifecycle.filter((e) => e.action === "prewarm");
  const unloads = lifecycle.filter((e) => e.action === "unload");

  // RAM-Residenz-Schätzung (#109): Fenster vom letzten Load-Punkt (prewarm)
  // bis zum nächsten unload. Embeds zwischendrin verlängern real via
  // keep_alive — das hier ist die UNTERE Schranke, gut genug für den Trend.
  let residentMs = 0;
  let cycles = 0;
  let loadedAt: number | null = null;
  for (const e of lifecycle) {
    const t = Date.parse(String(e.ts));
    if (e.action === "prewarm" && e.ok === true && loadedAt === null) loadedAt = t;
    if (e.action === "unload" && e.ok === true && loadedAt !== null) {
      residentMs += Math.max(0, t - loadedAt);
      loadedAt = null;
      cycles++;
    }
  }

  console.log(`\n## Ollama model lifecycle  (${lifecycle.length} events)`);
  console.log(`  prewarms (boot wakeups):  ${prewarms.length}`);
  console.log(`  idle unloads:             ${unloads.length}`);
  if (cycles > 0) {
    console.log(`  est. RAM residency:       ~${Math.round(residentMs / 60000)} min across ${cycles} load cycle(s) (lower bound)`);
  }
  const lastUnload = unloads[unloads.length - 1];
  if (lastUnload && typeof lastUnload.embed_calls_since_boot === "number") {
    console.log(`  embed calls at last unload: ${lastUnload.embed_calls_since_boot} (since that daemon boot)`);
  }
}

function summarizeBridges(events: AnyEvent[]): void {
  const recalls = events.filter((e) => e.kind === "recall" || e.kind === "hook_recall");
  if (recalls.length === 0) return;
  const expanded = recalls.filter((e) => e.bridge_expansion && typeof e.bridge_expansion === "object");
  if (expanded.length === 0) return; // layer off or no bridge fired — stay quiet

  const byLang = new Map<string, number>();
  const termCounts = new Map<string, number>();
  let totalAdded = 0;
  for (const e of expanded) {
    const be = e.bridge_expansion as { lang?: string; added?: string[] };
    byLang.set(be.lang ?? "?", (byLang.get(be.lang ?? "?") ?? 0) + 1);
    if (Array.isArray(be.added)) {
      totalAdded += be.added.length;
      for (const t of be.added) termCounts.set(t, (termCounts.get(t) ?? 0) + 1);
    }
  }

  console.log(`\n## Learned-recall bridges  (#120 — did bridges widen queries?)`);
  console.log(`  recalls with a bridge expansion:  ${expanded.length} of ${recalls.length}  (${pct(expanded.length, recalls.length)})`);
  console.log(`  by query language:                ${[...byLang.entries()].map(([l, n]) => `${l}:${n}`).join("  ")}`);
  console.log(`  avg terms added per expansion:    ${(totalAdded / expanded.length).toFixed(1)}`);
  const top = [...termCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (top.length > 0) {
    console.log(`  most-added expansion terms:`);
    for (const [t, n] of top) console.log(`     ${t.padEnd(22)} ${n}`);
  }
}

/**
 * Exposure-normalisierte Nutzungsraten (#263, §17.5, C-037/C-044/C-071).
 *
 * §17.5: „Ein häufig ausgespieltes Memory sammelt automatisch mehr positive
 * Ereignisse und gilt deshalb nicht als besser belegt. Jedes Signal wird auf
 * die Zahl seiner Ausspielungen normiert, und diese Normalisierung wird im
 * Report als solche ausgewiesen."
 *
 * Der Nenner kommt aus dem BESTEHENDEN Usage-Sidecar (C-071) und nicht aus
 * einer zweiten, hier gebauten Zählung: `.bastra/usage/` führt `surfaced`,
 * `loaded` und `acted_on` je Memory-ID bereits. Ein Memory ohne Historie dort
 * zählt `unknown` — NICHT 0. Der Unterschied ist der ganze Punkt: 0 hieße „nie
 * ausgespielt und deshalb nie genutzt", unknown heißt „wir wissen nicht, wie
 * oft es ausgespielt wurde", und eine Rate mit unbekanntem Nenner ist keine
 * Rate.
 */
async function summarizeExposureNormalised(events: AnyEvent[]): Promise<void> {
  const vaultRoot = process.env.BASTRA_VAULT_PATH ?? process.env.NEXUS_VAULT_PATH;
  const episodes = events.filter((e) => e.kind === "recall_episode" && e.acted_on === true);
  if (episodes.length === 0) return;
  if (!vaultRoot) {
    console.log(`\n## Exposure-normalised use  (skipped: BASTRA_VAULT_PATH not set — the denominator lives in the vault's usage sidecar)`);
    return;
  }

  let usage: UsageAggregate;
  try {
    usage = await readUsage(vaultRoot);
  } catch (err) {
    console.log(`\n## Exposure-normalised use  (skipped: usage sidecar unreadable — ${(err as Error).message})`);
    return;
  }

  const actedByMemory = new Map<string, number>();
  for (const e of episodes) {
    const id = String(e.memory_id);
    actedByMemory.set(id, (actedByMemory.get(id) ?? 0) + 1);
  }

  const rows: { id: string; acted: number; surfaced: number | null }[] = [];
  for (const [id, acted] of actedByMemory) {
    const entry = usage[id];
    rows.push({ id, acted, surfaced: entry ? entry.surfaced : null });
  }
  const known = rows.filter((r) => r.surfaced !== null && r.surfaced > 0);
  const unknown = rows.filter((r) => r.surfaced === null);
  const neverSurfaced = rows.filter((r) => r.surfaced === 0);

  console.log(`\n## Exposure-normalised use  (acted_on per surfacing, denominator from the usage sidecar)`);
  console.log(`  NORMALISATION, NOT BIAS CORRECTION (§17.5). Dividing by the number of`);
  console.log(`  surfacings makes rates comparable; it says nothing about WHY a memory was`);
  console.log(`  surfaced, because the selection itself depends on the current ranking. A`);
  console.log(`  causal utility claim needs logged selection propensities, controlled`);
  console.log(`  exploration, and non-surfaced candidates treated as censored rather than`);
  console.log(`  negative. None of the three is in place, so what follows is descriptive.`);

  const top = known.sort((a, b) => b.acted / b.surfaced! - a.acted / a.surfaced!).slice(0, 10);
  if (top.length > 0) {
    console.log(`  highest acted_on rate (of memories with a known denominator):`);
    for (const r of top) {
      console.log(
        `    ${(r.acted / r.surfaced!).toFixed(3).padStart(6)}  ${r.acted.toString().padStart(3)}/${String(r.surfaced).padStart(4)}  ${r.id}`,
      );
    }
  }
  console.log(`  memories with a known denominator: ${known.length}`);
  if (neverSurfaced.length > 0) {
    console.log(
      `  acted_on but sidecar says surfaced=0: ${neverSurfaced.length} (rate undefined, not 0 — the sidecar is behind or the load came without a hint)`,
    );
  }
  if (unknown.length > 0) {
    console.log(
      `  no sidecar history — counted UNKNOWN, never 0: ${unknown.length} (${unknown.slice(0, 5).map((r) => r.id).join(", ")}${unknown.length > 5 ? ", …" : ""})`,
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
function summarizeContextGovernor(events: AnyEvent[]): void {
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

async function main(): Promise<void> {
  const events = await loadEvents();
  if (events.length === 0) {
    console.log("no events in window.");
    return;
  }
  const window = DAYS ? `last ${DAYS} day(s)` : "all-time";
  console.log(`# nexus-recall stats — ${window}`);
  console.log(`logs: ${LOG_DIR}`);
  console.log(`events: ${events.length}`);

  summarizeHook(events);
  summarizeSessionHook(events);
  summarizeMcp(events);
  summarizeFollowThrough(events);
  summarizeUseRate(events);
  summarizeActSignals(events);
  summarizeContextTax(events);
  summarizeContextROI(events);
  summarizeContextGovernor(events);
  await summarizeExposureNormalised(events);
  summarizeEvidenceGate(events, { pct, MUST_LOAD_SCORE, SCORE_FLOOR });
  summarizeBridges(events);
  summarizeOllamaLifecycle(events);
  topProjects(events);
  topHints(events);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
