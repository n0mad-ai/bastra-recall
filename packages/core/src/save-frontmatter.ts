/**
 * Wie aus Eingabe und Bestand das Frontmatter wird.
 *
 * Herausgelöst aus `save.ts` (dieselbe Begründung wie bei `save-commit.ts`,
 * `save-target.ts` und `save-text.ts`): Die Datei war über 800 Zeilen, und
 * das ist bei jeder Änderung eine Lesekosten-Hypothek. Reiner Umzug — der
 * Rumpf unten ist byte-identisch der frühere Block aus `commitMemory`, kein
 * Feld, keine Reihenfolge und keine Bedingung wurde angefasst.
 *
 * WAS HIER ENTSCHIEDEN WIRD. Für jedes Feld: Gewinnt die Eingabe, gewinnt der
 * Bestand, oder fällt es weg? Die Antwort ist pro Feld verschieden und steht
 * jeweils am Feld. Was hier NICHT entschieden wird: wohin die Datei kommt
 * (`save-target.ts`), ob geschrieben werden darf (`save-commit.ts`) und wie
 * der Text serialisiert wird (der Aufrufer).
 */
import { coerceAliases } from "./schema.js";
import { clampSummary } from "./summary.js";
import type { SaveMemoryInput } from "./save-schema.js";
import { extractWikilinks, todayISO, dedupe } from "./save-text.js";

/**
 * Die Frontmatter-Felder, die DIESER Save-Pfad selbst verwaltet (C-084,
 * entschieden am 29.08.2026).
 *
 * Der Save baut das Frontmatter aus einer festen Feldliste NEU, statt das
 * bestehende zu patchen — jeder Key, den er nicht kennt, fiel deshalb bei jedem
 * Overwrite weg. Für einen Vault, der in Obsidian liegt, heißt das: `aliases`
 * aus dem Properties-Panel, `cssclasses`, ein Dataview-Feld, ein Tag-Plugin —
 * alles einmal in der App gesetzt und beim nächsten Save des Agenten still
 * verloren. Seit dieser Entscheidung überleben fremde Keys ein Overwrite
 * unverändert.
 *
 * DIE LISTE IST DIE KOLLISIONSREGEL: Was hier steht, gehört dem Save-Pfad —
 * er setzt es aus Input und Bestand nach seinen eigenen Regeln, und ein
 * gleichnamiger Wert aus der alten Datei kann ihn nicht überstimmen. Bekannt
 * schlägt fremd. Alles andere wird unverändert durchgereicht.
 *
 * Sie enthält deshalb AUCH die Felder, die der Save bewusst WEGLÄSST: Die
 * Bookmark-Felder (`url`, `read_status`, …) werden nur bei `type: "bookmark"`
 * geschrieben, damit ein Memory kein bookmark-förmiges Frontmatter bekommt.
 * Stünden sie nicht hier, machte ein Typwechsel bookmark→reference sie zu
 * „fremden" Keys und trüge sie genau in die Datei zurück, aus der sie
 * herausgehalten werden sollen.
 *
 * Wer ein Feld ergänzt, das der Save schreibt, trägt es hier ein. Vergisst er
 * es, wird das Feld als fremd behandelt und aus dem Bestand zurückgeholt —
 * `save-unknown-keys.test.ts` prüft genau diesen Fall für die Felder, bei denen
 * das Weglassen Absicht ist.
 */
export const SAVE_MANAGED_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  // Kernfelder, bei jedem Save geschrieben
  "id",
  "title",
  "type",
  "summary",
  "topic_path",
  "tags",
  "scope",
  "recall_when",
  "related",
  "aliases",
  "related_via",
  "sensitivity",
  "write_origin",
  "confidence",
  "created",
  "updated",
  "affects_files",
  "issues",
  // Optionale Felder: Input gewinnt, sonst Bestand, sonst weg
  "recall_when_expanded",
  "recall_when_expanded_src",
  "valid_until",
  "expires_after_days",
  "last_reviewed_at",
  "stale_status",
  "content_hash",
  "content_size",
  "source",
  "replaces",
  "siblings",
  "verify_cmd",
  "superseded_by",
  "salience",
  "emotion",
  "recall_mode",
  // Bookmark-Felder — nur bei `type: "bookmark"` gesetzt, siehe oben
  "url",
  "categories",
  "read_status",
  "og_image",
  "source_app",
  "saved_at",
]);

/** Das Ergebnis: das fertige Frontmatter und der eine Hinweis, den der
 *  Aufrufer für seine Antwort braucht. */
export interface BuiltFrontmatter {
  fm: Record<string, unknown>;
  /** Die Zusammenfassung war zu lang und wurde an einer Wortgrenze gekappt —
   *  der Save gelingt trotzdem, der Aufrufer meldet es als nicht-fatalen
   *  Hinweis. */
  summaryTruncated: boolean;
}

/**
 * Baut das Frontmatter für EINEN Save.
 *
 * `prev` ist das Frontmatter der bestehenden Datei (leer bei einer Neuanlage),
 * bereits um die Date-Koerzierung bereinigt. `id` und `scope` kommen aus der
 * Zielauflösung: Der Scope im Frontmatter muss dem Ordner entsprechen, in dem
 * die Datei wirklich landet (#360-D).
 */
export function buildFrontmatter(
  input: SaveMemoryInput,
  prev: Record<string, unknown>,
  id: string,
  scope: string,
): BuiltFrontmatter {
  /** Übernimmt den Bestandswert nur, wenn er den erwarteten Typ hat. */
  const kept = <T>(value: unknown, ok: (v: unknown) => boolean): T | undefined =>
    ok(value) ? (value as T) : undefined;
  const isStr = (v: unknown): boolean => typeof v === "string" && v.length > 0;
  const isNum = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
  const isArr = (v: unknown): boolean => Array.isArray(v);
  /**
   * Optionales Frontmatter-Feld: Input gewinnt, sonst der Bestandswert,
   * sonst bleibt das Feld ganz weg (kein `field: undefined` im YAML).
   */
  const optional = (
    key: string,
    value: unknown,
    ok: (v: unknown) => boolean,
  ): Record<string, unknown> => {
    const next = value ?? kept(prev[key], ok);
    return next == null ? {} : { [key]: next };
  };

  /** #360: union of the file's existing `siblings` and this save's
   *  `sibling_of`, order-stable, empty list omitted from the frontmatter. */
  const mergedSiblings = (): Record<string, unknown> => {
    const previous = kept<unknown[]>(prev.siblings, isArr) ?? [];
    const merged = [...new Set([...previous, ...(input.sibling_of ?? [])].filter(isStr))];
    return merged.length === 0 ? {} : { siblings: merged };
  };

  const aliases = input.aliases ?? coerceAliases(prev.aliases);
  const existingOrigin = kept<string>(prev.write_origin, isStr);
  const salience =
    input.salience ??
    kept<number>(prev.salience, (v) => isNum(v) && (v as number) >= 0 && (v as number) <= 1);
  const emotion =
    input.emotion ??
    kept<string>(prev.emotion, (v) =>
      ["frustration", "success", "risk", "neutral"].includes(v as string),
    );
  const recallMode =
    input.recall_mode ??
    kept<string>(prev.recall_mode, (v) => v === "reflex" || v === "deliberate");

  const today = todayISO();
  // Wikilinks aus dem Body in `related[]` spiegeln. Im OSS-Stack existiert
  // sonst keine Stelle, die `[[id]]`-Referenzen in Strukturdaten überführt
  // — Multi-Hop-Recall sähe sie nie. Reihenfolge: vom Caller mitgegebene
  // related zuerst, dann neue aus dem Body, dedupliziert.
  const bodyLinks = extractWikilinks(input.body);
  const mergedRelated = dedupe([
    ...(input.related ?? kept<string[]>(prev.related, isArr) ?? []),
    ...bodyLinks,
  ]).filter(
    (rel) => rel !== id, // self-link macht keinen Sinn
  );

  // Clamp instead of reject: an over-long summary is truncated at a word
  // boundary so the write always succeeds; the caller gets a non-fatal note.
  const { summary: clampedSummary, truncated: summaryTruncated } = clampSummary(input.summary);

  const fm: Record<string, unknown> = {
    id,
    title: input.title,
    type: input.type,
    summary: clampedSummary,
    topic_path: input.topic_path,
    tags: input.tags,
    // Immer identisch zum Ordner, den `resolveMemoryTarget` gewählt hat
    // (#360-D): kanonisch bei jedem normalen Save, im Bestandsfall die alte
    // Schreibweise — sonst zeigt das Frontmatter auf ein Regal, in dem die
    // Datei gar nicht liegt.
    scope,
    recall_when: input.recall_when,
    related: mergedRelated,
    ...(aliases && aliases.length > 0 ? { aliases } : {}),
    related_via: input.related_via ?? kept(prev.related_via, isArr) ?? [],
    // sensitivity trägt das allow_private-Gate: ein stiller private→team-
    // Downgrade beim Text-Refresh würde das Memory für externe Caller öffnen.
    sensitivity: input.sensitivity ?? kept(prev.sensitivity, isStr) ?? "team",
    // #158: Provenance-Stempel — Bestands-Memories ohne Feld gelten als
    // agent-session (Backfill per Default-Semantik, kein Massen-Rewrite)
    write_origin: input.write_origin ?? existingOrigin ?? "agent-session",
    // Maschinell erzeugte Trigger-Expansion (#117): der Save baut das
    // Frontmatter neu, also fielen doc2query-Trigger bei jedem Overwrite raus
    // und mussten vom Background-Pass neu berechnet werden.
    // Nur aus dem Bestand: SaveMemoryInput kennt diese Felder nicht, sie
    // entstehen ausschließlich im Background-Pass (trigger-expand.ts).
    ...optional("recall_when_expanded", undefined, isArr),
    ...optional("recall_when_expanded_src", undefined, isStr),
    ...optional("valid_until", input.valid_until, isStr),
    ...optional("expires_after_days", input.expires_after_days, isNum),
    ...optional("last_reviewed_at", input.last_reviewed_at, isStr),
    ...optional("stale_status", input.stale_status, isStr),
    ...optional("content_hash", input.content_hash, isStr),
    ...optional("content_size", input.content_size, isNum),
    ...optional("source", input.source, isStr),
    // #164: the forward half of the supersession edge. The backward half
    // (`superseded_by` on the predecessor) is stamped by the daemon. Kept from
    // the previous file when absent, so re-saving a memory does not drop the
    // version link it already declared.
    ...optional("replaces", input.replaces, isStr),
    // #360: MERGED, not replaced — `optional()` would let a save that names one
    // sibling drop every earlier quittance, and the gate would then ask about a
    // pair the agent has already answered for.
    ...mergedSiblings(),
    ...optional("verify_cmd", input.verify_cmd, isStr),
    ...optional("superseded_by", undefined, isStr),
    confidence: input.confidence ?? kept(prev.confidence, isNum) ?? 1,
    // #217: `!= null` statt truthy — salience 0 ist ein gültiger Wert.
    ...(salience != null ? { salience } : {}),
    ...(emotion != null ? { emotion } : {}),
    ...(recallMode != null ? { recall_mode: recallMode } : {}),
    // `created` ist die Entstehungszeit, nicht die letzte Schreibzeit — und
    // über SaveMemoryInput gar nicht setzbar. Vorher stand hier unbedingt
    // `today`, wodurch jedes Overwrite die Historie des Memorys löschte.
    created: kept<string>(prev.created, isStr) ?? today,
    updated: today,
    affects_files: input.affects_files ?? kept(prev.affects_files, isArr) ?? [],
    issues: input.issues ?? kept(prev.issues, isArr) ?? [],
  };

  // Bookmark-specific fields, only set when type === "bookmark" so memory
  // files don't get bookmark-shaped frontmatter pollution.
  if (input.type === "bookmark") {
    // #240/A6 gilt auch hier: diese Felder wurden ausschließlich aus dem Input
    // gesetzt, ohne Blick auf den Bestand — ein Refresh, der nur `summary` oder
    // `read_status` schickt, warf url/og_image/categories/source_app aus dem
    // File. Dieselbe Patch-Semantik wie oben: Input gewinnt, sonst Bestand,
    // sonst bleibt das Feld weg.
    Object.assign(
      fm,
      optional("url", input.url, isStr),
      optional("categories", input.categories, isArr),
      optional("read_status", input.read_status, isStr),
      optional("og_image", input.og_image, isStr),
      optional("source_app", input.source_app, isStr),
    );
    // #240/A6 auch hier: `saved_at` ist die Erfassungszeit des Bookmarks (das
    // Bookmark-Pendant zu `created`), nicht die letzte Schreibzeit — niemand im
    // Stack leitet daraus Staleness ab. Ohne Carry-over restampte jedes
    // Overwrite den Importzeitpunkt des Bookmarks auf jetzt.
    fm.saved_at = input.saved_at ?? kept<string>(prev.saved_at, isStr) ?? new Date().toISOString();
  }

  // C-084: Was der Save-Pfad nicht kennt, gehört ihm auch nicht — es überlebt
  // das Overwrite unverändert. Steht am ENDE, nachdem `fm` fertig ist: Die
  // Prüfung gegen `SAVE_MANAGED_FRONTMATTER_KEYS` entscheidet die Kollision
  // (bekannt schlägt fremd), `key in fm` fängt zusätzlich ein verwaltetes Feld
  // ab, das jemand in `fm` ergänzt und in der Liste vergessen hat.
  //
  // Die Werte werden NICHT geprüft oder normalisiert. Ein fremdes Feld hat für
  // uns keine Semantik — es zu validieren hieße, sie ihm zuzuschreiben, und
  // eine Reparatur nach unseren Regeln wäre für den Besitzer des Feldes eine
  // stille Änderung. Bei einer Neuanlage (`prev` leer) passiert hier nichts.
  for (const [key, value] of Object.entries(prev)) {
    if (SAVE_MANAGED_FRONTMATTER_KEYS.has(key)) continue;
    if (key in fm) continue;
    fm[key] = value;
  }

  return { fm, summaryTruncated };
}
