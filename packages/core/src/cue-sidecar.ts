/**
 * Die Cue-Schicht als read-only Sidecar-Projektion (§11.4).
 *
 * Ein Cue beantwortet „wann soll das auftauchen?", die Evidenz beantwortet „was
 * steht da und warum stimmt es?". `recall_when` ist der handgeschriebene
 * Zukunftscue und bleibt die primäre autorisierte Quelle; abgeleitete Cues
 * treten NEBEN ihn, nie hinein — §11.4 verbietet ausdrücklich, die beiden
 * Vertrauensklassen zu einem Feld zu verschmelzen.
 *
 * WAS DIESE SCHICHT NICHT TUT. Sie fasst kein Markdown an. §11.4: „die Schicht
 * beginnt als read-only Sidecar-Projektion ohne jede Markdown-Änderung", und
 * eine persistente Aufnahme ins Vault-Schema braucht denselben gesonderten
 * Repräsentationsentscheid wie Dual-Vektoren und Chunking (§11.2). Der
 * TriggerExpander, der `recall_when_expanded` ins Frontmatter schreibt, ist
 * deshalb NICHT das Vorbild für die Ablage — nur für die Betriebsarten.
 *
 * ROLLBACK ist die Abwesenheit der Datei. §11.4: „Die Sidecar-Datei wird
 * ignoriert. Retrieval verhält sich dann exakt wie heute." Genau das ist der
 * Produktionszustand, solange kein Generator gelaufen ist, und der Grund, warum
 * `SearchIndex` das achte Feld ohne geladene Projektion gar nicht erst anlegt.
 *
 * ABLAGEORT: `<vault>/.bastra/cues.jsonl`, nicht `memories/`. Der Vault-Bereich
 * ist der Nutzerbestand in Markdown; alles, was Bastra über ihn ABLEITET, liegt
 * unter `.bastra` (`embeddings.json`, `usage/`, `trash/`, `recovery/`). Eine
 * abgeleitete Projektion in `memories/` wäre genau die Vermischung, die die
 * Auflage „ohne jede Markdown-Änderung" verhindern soll.
 *
 * JSONL, nicht JSON: Ein Batch-Erzeuger schreibt zeilenweise, und eine kaputte
 * Zeile kostet dann einen Cue statt der ganzen Projektion. Der Preis ist eine
 * eigene Zeilenschleife statt `JSON.parse` — geschenkt gegenüber einer Datei,
 * die im Ganzen unlesbar wird, wenn ein Lauf mittendrin abbricht.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Memory } from "./schema.js";

/**
 * Die vier Cue-Familien aus der Tabelle in §11.4.
 *
 * Alle vier stehen im Typ, weil §11.4 sie alle im Prüfumfang hält („bis dahin
 * bleiben alle vier im Prüfumfang") — der Typ bildet den Vertrag ab und
 * schließt keine Familie durch Konstruktion aus. Gebaut wird operativ nur
 * `descriptive_entity`: Anlage A hält die Cue-Achsen auf EINER Konfiguration
 * fest, und die registrierte Konfiguration (registrations/cue-experiment.json,
 * `fixed_cue_configuration`) ist descriptive × item. Für die anderen drei gibt
 * es deshalb keinen Erzeuger und keinen Konsumenten — Vorratscode, den keine
 * Messung braucht.
 */
export type CueFamily =
  | "descriptive_entity"
  | "associative_bridge"
  | "descriptive_scene"
  | "associative_horizon";

/**
 * Ein abgeleiteter Cue mit seiner vollständigen Provenienz.
 *
 * §11.4: „jeder abgeleitete Cue trägt IMMER Ziel-ID des Memorys, Herkunft,
 * Generatorversion, `derived_at`, Konfidenz und die Verbindung zur Evidenz;
 * diese Felder sind Bestandteil des Cues und niemals Gegenstand einer Ablation
 * — ablated wird ausschließlich seine Rankingwirkung." Deshalb sind sie hier
 * alle Pflicht und keines ist optional: Ein Datensatz, dem eines fehlt, ist
 * kein sparsamer Cue, sondern keiner.
 */
export interface DerivedCue {
  /** Ziel-ID des Memorys. */
  memory_id: string;
  family: CueFamily;
  /** Der Cue-Text selbst — das, was in den Index geht. */
  cue: string;
  /** Herkunft des Erzeugungswegs. Die beiden Bedingungen von Anlage A (§18.3,
   *  §31 Entscheidung 1); welcher Weg gewinnt, ist offen und wird gemessen. */
  origin: "batch" | "agent";
  /**
   * Die drei Felder, die einen Lauf nachvollziehbar machen. §31 Entscheidung 1
   * verlangt einen „reproduzierbaren Offline-Batch", und reproduzierbar heißt
   * bei einem LLM nicht deterministisch: Dieselbe Eingabe kann eine andere
   * Formulierung ergeben. Nachvollziehbar ist der ANSPRUCH — wer mit welchem
   * Modell und welcher Prompt-Fassung diesen Cue erhoben hat. Ohne das ließe
   * sich ein späterer Befund keiner Erzeugung zuordnen, und der Vergleich der
   * beiden Wege aus Anlage A wäre nicht auswertbar.
   */
  generator_version: string;
  /** Der Modellname, wie er beim Lauf angesprochen wurde. */
  model: string;
  /** Fassung des Prompts — ein umformulierter Prompt ist ein anderer Erzeuger. */
  prompt_version: string;
  /** ISO-8601. */
  derived_at: string;
  /** 0..1. */
  confidence: number;
  /**
   * Die Verbindung zur Evidenz: der Fingerabdruck des Memory-Inhalts, aus dem
   * dieser Cue abgeleitet wurde.
   *
   * Trägt beide Auflagen aus §11.4 auf einmal. „Ein Cue ohne auflösbare Ziel-ID
   * ODER ohne Evidenzverbindung ist kein unvollständiger Cue, sondern ein
   * ungültiger" — ohne dieses Feld wird der Datensatz verworfen. Und „ein Cue,
   * dessen Ziel-Memory sich ändert, wird als veraltet markiert, statt
   * stillschweigend weiter zu feuern" — weicht der Fingerabdruck vom aktuellen
   * Stand ab, hat sich das Ziel geändert.
   */
  evidence: { source_fingerprint: string };
}

/**
 * Der Fingerabdruck des Inhalts, aus dem ein Item-Cue abgeleitet wird.
 *
 * Bewusst über den AUTORISIERTEN Inhalt und nicht über die Datei: `mtime` und
 * Byte-Stand ändern sich auch, wenn ein anderer Prozess das Frontmatter
 * umsortiert oder ein Sync die Datei anfasst, und dann wäre jeder Cue nach dem
 * ersten Reindex veraltet. Umgekehrt ist alles, was ein `descriptive_entity`
 * beschreibt, in genau diesen Feldern enthalten — ändert sich einer, ist die
 * Beschreibung möglicherweise nicht mehr wahr.
 *
 * `recall_when` steht bewusst NICHT drin: Es ist die konkurrierende
 * Vertrauensklasse, und ein neu geschriebener Trigger soll die abgeleiteten
 * Cues nicht ungültig machen.
 */
export function cueSourceFingerprint(m: Memory): string {
  const canonical = JSON.stringify([
    m.fm.id,
    m.fm.title,
    m.fm.summary,
    m.fm.tags,
    m.fm.topic_path,
    m.body,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Warum ein Datensatz nicht in die Projektion kam. */
export type CueRejectionReason =
  /** Die Zeile war kein JSON. */
  | "malformed_line"
  /** Pflichtfelder fehlen oder haben den falschen Typ — inklusive der
   *  Provenienz, die nach §11.4 immer mitzuführen ist. */
  | "incomplete_provenance"
  /** Die Ziel-ID löst im Vault nicht auf. §11.4: ungültig, nicht degradiert. */
  | "unresolvable_target";

export interface CueRejection {
  /** 1-basiert, damit die Meldung auf die Zeile in der Datei zeigt. */
  line: number;
  reason: CueRejectionReason;
  /** Die Ziel-ID, falls die Zeile überhaupt eine trug. */
  memory_id?: string;
}

/**
 * Ein veralteter Cue — eigener Typ, weil §11.4 die beiden Fälle ausdrücklich
 * trennt: der ungültige wird VERWORFEN, der veraltete wird MARKIERT. Ihn unter
 * einen Zurückweisungsgrund zu schieben würde genau diese Unterscheidung
 * einebnen, und sie ist der Grund, warum der Satz im Vertrag steht.
 */
export interface CueStale {
  line: number;
  memory_id: string;
}

/**
 * Was geladen wurde — und was nicht.
 *
 * Die Zurückweisungen stehen hier, weil sie nach Auflage gezählt und gemeldet
 * werden müssen. Eine Projektion, die stillschweigend die Hälfte verschluckt,
 * beantwortet die Frage „wirken Cues?" mit einer Zahl, die niemand einordnen
 * kann.
 */
export interface CueProjection {
  /** Cue-Texte je Memory-ID — gültig UND aktuell. Das ist, was in den Index geht. */
  byMemory: Map<string, string[]>;
  /** Wieviele Cues es in die Projektion geschafft haben. */
  accepted: number;
  /** Verworfen, mit Grund und Zeile. */
  rejected: CueRejection[];
  /**
   * Veraltet: Ziel auflösbar, aber sein Inhalt hat sich seit der Ableitung
   * geändert. §11.4 trennt das ausdrücklich vom ungültigen Cue — der eine wird
   * verworfen, der andere „als veraltet markiert, statt stillschweigend weiter
   * zu feuern". Markiert heißt hier: gezählt und gemeldet, und NICHT in
   * `byMemory` — weiter zu feuern wäre genau das, was der Satz ausschließt.
   */
  stale: CueStale[];
}

/** Der Sidecar-Pfad eines Vaults. */
export function cueSidecarPath(vaultRoot: string): string {
  return join(vaultRoot, ".bastra", "cues.jsonl");
}

/** Woran die Ziel-ID aufgelöst wird. Strukturell von `Vault` erfüllt; als
 *  eigenes Interface, damit ein Test keinen Vault bauen muss. */
export interface CueTargetSource {
  get(id: string): Memory | undefined;
}

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

const FAMILIES: readonly string[] = [
  "descriptive_entity",
  "associative_bridge",
  "descriptive_scene",
  "associative_horizon",
];

/**
 * Eine Zeile zu einem Cue machen — oder sagen, was fehlt.
 *
 * Prüft die Provenienz vollständig, weil §11.4 sie vollständig verlangt. Ein
 * fehlendes `confidence` ist hier kein „default 1", sondern ein Grund zur
 * Zurückweisung: Ein Wert, den der Leser sich ausdenkt, ist keine Provenienz.
 */
export function parseCueRecord(value: unknown): DerivedCue | null {
  const r = value as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  if (!isNonEmptyString(r.memory_id)) return null;
  if (!isNonEmptyString(r.cue)) return null;
  if (typeof r.family !== "string" || !FAMILIES.includes(r.family)) return null;
  if (r.origin !== "batch" && r.origin !== "agent") return null;
  if (!isNonEmptyString(r.generator_version)) return null;
  if (!isNonEmptyString(r.model)) return null;
  if (!isNonEmptyString(r.prompt_version)) return null;
  if (!isNonEmptyString(r.derived_at)) return null;
  if (typeof r.confidence !== "number" || !Number.isFinite(r.confidence)) return null;
  if (r.confidence < 0 || r.confidence > 1) return null;
  const evidence = r.evidence as Record<string, unknown> | undefined;
  if (!evidence || typeof evidence !== "object") return null;
  if (!isNonEmptyString(evidence.source_fingerprint)) return null;
  return {
    memory_id: r.memory_id,
    family: r.family as CueFamily,
    cue: r.cue,
    origin: r.origin,
    generator_version: r.generator_version,
    model: r.model,
    prompt_version: r.prompt_version,
    derived_at: r.derived_at,
    confidence: r.confidence,
    evidence: { source_fingerprint: evidence.source_fingerprint },
  };
}

/** Eine Projektion aus Zeilen bauen. Getrennt vom Datei-I/O, damit ein Test
 *  keine Datei anlegen muss und der Erzeuger später denselben Weg nimmt. */
export function projectCues(lines: string[], targets: CueTargetSource): CueProjection {
  const byMemory = new Map<string, string[]>();
  const rejected: CueRejection[] = [];
  const stale: CueStale[] = [];
  let accepted = 0;

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line.length === 0) return;
    const at = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      rejected.push({ line: at, reason: "malformed_line" });
      return;
    }
    const cue = parseCueRecord(parsed);
    if (!cue) {
      const id = (parsed as { memory_id?: unknown })?.memory_id;
      rejected.push({
        line: at,
        reason: "incomplete_provenance",
        ...(isNonEmptyString(id) ? { memory_id: id } : {}),
      });
      return;
    }
    const target = targets.get(cue.memory_id);
    if (!target) {
      rejected.push({ line: at, reason: "unresolvable_target", memory_id: cue.memory_id });
      return;
    }
    if (cueSourceFingerprint(target) !== cue.evidence.source_fingerprint) {
      stale.push({ line: at, memory_id: cue.memory_id });
      return;
    }
    const list = byMemory.get(cue.memory_id);
    if (list) list.push(cue.cue);
    else byMemory.set(cue.memory_id, [cue.cue]);
    accepted++;
  });

  return { byMemory, accepted, rejected, stale };
}

/**
 * Die Projektion eines Vaults laden.
 *
 * Eine fehlende Datei ist KEIN Fehler, sondern der Normalfall und zugleich der
 * Rollback aus §11.4: keine Datei, keine Cues, Retrieval wie heute. Alles
 * andere — unlesbar, kaputte Zeilen — wird gemeldet, nicht verschluckt.
 */
export async function loadCueProjection(
  vaultRoot: string,
  targets: CueTargetSource,
  path: string = cueSidecarPath(vaultRoot),
): Promise<CueProjection> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { byMemory: new Map(), accepted: 0, rejected: [], stale: [] };
    }
    throw err;
  }
  return projectCues(raw.split("\n"), targets);
}

/** Eine Zeile für die Meldung — Zahlen, keine Cue-Texte. */
export function describeCueProjection(p: CueProjection): string {
  const byReason = new Map<CueRejectionReason, number>();
  for (const r of p.rejected) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
  const reasons = [...byReason].map(([r, n]) => `${r}=${n}`).join(", ");
  return (
    `${p.accepted} cues over ${p.byMemory.size} memories` +
    (p.rejected.length > 0 ? `, ${p.rejected.length} rejected (${reasons})` : "") +
    (p.stale.length > 0 ? `, ${p.stale.length} stale` : "")
  );
}
