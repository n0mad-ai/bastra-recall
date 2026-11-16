/**
 * #1438 — abgeschlossene Telemetrie-Tage in der App-Datenbank (recall.db,
 * Migration v3 "telemetry-days").
 *
 * `GET /ui/telemetry?days=N` las früher bei jeder Anfrage alle Tagesdateien
 * des Fensters neu (90 Tage ≈ 300 MB JSONL). Ein abgeschlossener UTC-Tag
 * ändert sich nicht mehr; er wird deshalb einmal gelesen und als schlanker
 * Auszug gespeichert. Nur der laufende Tag kommt weiter aus dem Log.
 *
 * Gespeichert werden die Ereignisse selbst, beschnitten auf die Felder, die
 * der Bericht liest — keine fertigen Tageszahlen. Der Bericht rechnet über
 * ein rollendes Fenster (now − N × 24 h, der älteste Tag zählt nur teilweise),
 * Median/p95 über das ganze Fenster und Kennzahlen über Sitzungen und
 * Recall-IDs, die über Mitternacht reichen. Das lässt sich aus Tageszahlen
 * nicht exakt zusammensetzen; aus dem Auszug rechnet derselbe Code dasselbe
 * Ergebnis wie aus dem Log. Der Auszug liegt gzip-komprimiert in der Zeile
 * (90 Tage: rund 84 MB JSON, komprimiert etwa ein Zehntel; Entpacken kostet
 * wenige Millisekunden je Tag).
 *
 * Neu gerechnet wird ein Tag, wenn
 *   - sich `TELEMETRY_DAY_VERSION` ändert (Auszug oder Leseregeln geändert),
 *   - die Logdatei nachträglich gewachsen oder sonst geändert ist (Größe oder
 *     mtime weichen ab — kurz nach Mitternacht schreiben Hooks noch Zeilen
 *     mit Zeitstempel des Vortags; die Datei wählt der Zeitstempel).
 * Zeilen von Tagen, deren Logdatei die Retention gelöscht hat, werden entfernt.
 */
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { openAppDatabase, type AppDatabase } from "./app-database.js";
import { parseEventLines, type FinishedDaySource, type ReportEvent } from "./telemetry-report.js";

/**
 * Version des gespeicherten Auszugs. Erhöhen, wenn ein Berichtsabschnitt ein
 * Feld liest, das `KEPT_FIELDS` / `NESTED` nicht mitnehmen, oder wenn sich die
 * Leseregeln einer Tagesdatei ändern — dann werden alle Tage neu gelesen.
 * Der Test `telemetry-day-store.test.ts` prüft, dass jedes vom Bericht
 * gelesene Feld im Auszug steht.
 */
export const TELEMETRY_DAY_VERSION = 1;

/** Oberste Ereignisfelder, die der Bericht (inkl. Filter und Faltung) liest. */
const KEPT_FIELDS = new Set([
  "acted_on",
  "action",
  "applies_to_count",
  "applies_to_tokens_est",
  "backoff_streak",
  "band",
  "basis",
  "boundary",
  "budget",
  "caller_session",
  "candidate_count",
  "claimed_count",
  "client",
  "code_basis",
  "code_block_tokens_est",
  "code_dependents",
  "code_listed",
  "code_stale",
  "code_targets",
  "command_head",
  "context",
  "count",
  "counts",
  "created",
  "daemon_reachable",
  "daemon_url",
  "decisions",
  "dedupe_hit",
  "degraded",
  "delivered_lane",
  "delivered_tokens_est",
  "delivery",
  "detail",
  "detected_mode",
  "dimensions",
  "dropped_dedup_count",
  "dropped_scope_count",
  "dropped_scopes",
  "dropped_unanchored_count",
  "duration_ms",
  "embed_calls_since_boot",
  "emission_index",
  "error",
  "exit_code",
  "external_resolved",
  "external_total",
  "failed",
  "file_path",
  "files",
  "filter_project",
  "first_over",
  "followed",
  "found",
  "from_hook_recall",
  "hint_count",
  "hint_kind",
  "hint_reason",
  "hint_tokens_by_part",
  "hint_tokens_est",
  "hinted_ids",
  "hinted_types",
  "hit_count",
  "hits",
  "hook_hint_rank",
  "hook_version",
  "host",
  "id",
  "ids",
  "k",
  "kernel_chars",
  "kernel_degraded_ids",
  "kernel_ids",
  "kernel_omitted",
  "kernel_paged_index",
  "kind",
  "lane",
  "latency_ms",
  "latency_ms_recall",
  "latency_ms_total",
  "matched_pattern",
  "memory_id",
  "mode",
  "model",
  "ms",
  "non_conformance",
  "ok",
  "origin",
  "outcome",
  "overwrite",
  "payload_tokens_est",
  "pending_harvest",
  "pending_lanes",
  "presentation",
  "pretool_shape",
  "prewarm",
  "project",
  "project_confidence",
  "query_chars",
  "reason",
  "recall_id",
  "repo",
  "required_count",
  "round",
  "scope_filter_skipped",
  "score_kind",
  "served",
  "session_id",
  "severity",
  "shadow",
  "skipped_reason",
  "source",
  "status",
  "stored_count",
  "suggested_count",
  "suppressed",
  "suppressed_tokens_est",
  "surface",
  "surfaced",
  "surfaced_score",
  "tokens",
  "tokens_est",
  "took_ms",
  "tool",
  "tool_name",
  "top_score",
  "topics",
  "trigger",
  "ts",
  "type",
  "unavailable_reason",
  "unfused",
  "usage_suppressed",
  "usage_suppressed_mode",
  "usage_suppressed_tokens_est",
  "would_drop",
  "written",
]);

const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const pick = (o: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
  const r: Record<string, unknown> = {};
  for (const k of keys) if (k in o) r[k] = o[k];
  return r;
};
const eachItem = (v: unknown, f: (o: Record<string, unknown>) => unknown): unknown =>
  Array.isArray(v) ? v.map((x) => (isPlain(x) ? f(x) : x)) : v;

/** Die drei großen verschachtelten Felder, beschnitten auf das Gelesene. */
const NESTED: Record<string, (v: unknown) => unknown> = {
  // isEvalTraffic liest nur `dimensions.client`.
  dimensions: (v) => (isPlain(v) ? pick(v, ["client"]) : v),
  // Qualität/Evidenz lesen je Treffer nur den Score.
  hits: (v) => eachItem(v, (h) => pick(h, ["score"])),
  decisions: (v) =>
    eachItem(v, (d) => {
      const r = pick(d, ["decision", "abstain_reason", "hop"]);
      if ("evidence" in d) r.evidence = isPlain(d.evidence) ? pick(d.evidence, ["lexical_score"]) : d.evidence;
      return r;
    }),
};

/** Ein Ereignis, beschnitten auf die Felder, die der Bericht liest. */
export function slimEvent(e: ReportEvent): ReportEvent {
  const r: Record<string, unknown> = {};
  for (const k of Object.keys(e)) {
    if (!KEPT_FIELDS.has(k)) continue;
    const v = (e as Record<string, unknown>)[k];
    r[k] = NESTED[k] ? NESTED[k](v) : v;
  }
  return r as ReportEvent;
}

export class TelemetryDayStore implements FinishedDaySource {
  constructor(private readonly db: AppDatabase) {}

  /**
   * Die Ereignisse eines abgeschlossenen Tages. Fehler der Logdatei (fehlt,
   * unlesbar) gehen an den Aufrufer, der den Tag überspringt wie beim
   * direkten Lesen. Ein Datenbankfehler kostet nur den Speichervorteil: der
   * Tag wird dann aus dem Log gelesen.
   */
  async eventsOf(logDir: string, file: string, day: string): Promise<ReportEvent[]> {
    // Größe und Inhalt kommen aus DEMSELBEN geöffneten Deskriptor: stat vor
    // dem Lesen — wächst die Datei dazwischen, passt die gespeicherte Größe
    // nicht mehr und der Tag wird beim nächsten Mal neu gelesen.
    const handle = await open(join(logDir, file), "r");
    try {
      return await this.eventsFromHandle(handle, logDir, day);
    } finally {
      await handle.close();
    }
  }

  private async eventsFromHandle(handle: FileHandle, logDir: string, day: string): Promise<ReportEvent[]> {
    const st = await handle.stat();
    try {
      const row = this.db.sqlite
        .prepare("SELECT version,file_size,file_mtime_ms,events_json_gz FROM telemetry_days WHERE log_dir=? AND day=?")
        .get(logDir, day);
      if (
        row &&
        Number(row.version) === TELEMETRY_DAY_VERSION &&
        Number(row.file_size) === st.size &&
        Number(row.file_mtime_ms) === st.mtimeMs
      ) {
        return JSON.parse(gunzipSync(row.events_json_gz as Uint8Array).toString("utf8")) as ReportEvent[];
      }
    } catch {
      /* database unavailable: read the log below */
    }
    const events = parseEventLines(await handle.readFile("utf8")).map(slimEvent);
    try {
      this.db.sqlite
        .prepare(
          `INSERT INTO telemetry_days(log_dir,day,version,file_size,file_mtime_ms,event_count,events_json_gz,computed_at)
          VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(log_dir,day) DO UPDATE SET version=excluded.version, file_size=excluded.file_size,
            file_mtime_ms=excluded.file_mtime_ms, event_count=excluded.event_count, events_json_gz=excluded.events_json_gz,
            computed_at=excluded.computed_at`
        )
        .run(
          logDir,
          day,
          TELEMETRY_DAY_VERSION,
          st.size,
          st.mtimeMs,
          events.length,
          gzipSync(JSON.stringify(events)),
          Date.now()
        );
    } catch {
      /* not stored: the next request reads this day from the log again */
    }
    return events;
  }

  /** Entfernt gespeicherte Tage, deren Logdatei es nicht mehr gibt (Retention). */
  prune(logDir: string, existingDays: ReadonlySet<string>): void {
    const gone = this.db.sqlite
      .prepare("SELECT day FROM telemetry_days WHERE log_dir=?")
      .all(logDir)
      .map((r) => String(r.day))
      .filter((d) => !existingDays.has(d));
    const del = this.db.sqlite.prepare("DELETE FROM telemetry_days WHERE log_dir=? AND day=?");
    for (const d of gone) del.run(logDir, d);
  }
}

let shared: TelemetryDayStore | null = null;
/** Eine Verbindung je Prozess auf der Standard-recall.db (BASTRA_DB_PATH, ~/.bastra/recall.db). */
export function telemetryDayStore(): TelemetryDayStore {
  shared ??= new TelemetryDayStore(openAppDatabase());
  return shared;
}
