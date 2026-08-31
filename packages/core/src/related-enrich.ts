/**
 * Auto-Related-Enricher — pflegt `frontmatter.related_via` UND eine markierte
 * Body-Section mit `[[id]]`-Wikilinks automatisch via Embedding-Similarity.
 *
 * Warum beide Stellen?
 *   - `frontmatter.related_via[]` ist strukturiert (id + reason + score) und
 *     dient unserem Multi-Hop-Recall in search.ts.
 *   - Body-Wikilinks zwischen den Auto-Markern werden vom Obsidian-Graph als
 *     Edges erkannt. Wir wollen Obsidian sauber unterstützen, sonst hätten
 *     wir ein eigenes UI bauen können.
 *
 * Pipeline:
 *   EmbeddingIndex.onEmbed(id)
 *     → findSimilarById(id, topN+self)
 *     → cosine ≥ threshold filtern
 *     → `private`-Nachbarn verwerfen, außer das Memory ist selbst private
 *     → mit existing related_via UND existing body-section vergleichen
 *     → wenn etwas abweicht: file rewrite (frontmatter + body), vault.reindexFile
 *
 * Loop-Prevention:
 *   Der reindex triggert ein neues Embed (Body hat sich geändert). Das zweite
 *   Embed liefert dasselbe Similarity-Set → sameIdSet UND sameBody → no-op.
 *   Kein File-Write, kein Loop.
 *
 *   WICHTIG: Der Vergleich ist drift-tolerant (SCORE_EPSILON), nicht exakt.
 *   Zwei Prozesse auf demselben Vault (Daemon + Mac-App-Bridge) haben eigene
 *   EmbeddingIndizes mit minimal abweichenden Vektoren (~±0.002 Cosine). Ein
 *   exakter String-Vergleich ließ beide an Rundungsgrenzen (0.8049 vs 0.8051
 *   → "0.80" vs "0.81") dasselbe File im Sekundentakt gegenseitig
 *   überschreiben — Dauer-Re-Embed, Ollama-Modell entlud nie.
 */
import type { Vault } from "./vault.js";
import { mutateMemoryFile, type MutateOutcome } from "./memory-mutate.js";
import { MEMORY_WRITE_CONFLICT } from "./save-schema.js";
import type { EmbeddingIndex } from "./embeddings.js";
import { AUTO_RELATED_START, AUTO_RELATED_END, stripAutoRelatedSection } from "./save-text.js";

export interface RelatedEnricherOptions {
  /** Wieviele Nachbarn maximal nach related_via schreiben. Default 5. */
  topN?: number;
  /** Cosine-Schwellwert, unterhalb dessen Nachbarn nicht aufgenommen werden.
   *  Bei embeddinggemma (multilingual) ist 0.7 streng, 0.6 großzügig. Default
   *  0.7 — lieber wenige präzise Links als viele Halb-Treffer (Multi-Hop
   *  würde sonst rauschen). */
  threshold?: number;
  /** Optionaler Single-Writer-Gate: wird unmittelbar vor einem File-Write
   *  gefragt; liefert er false, wird der Write übersprungen (ein anderer
   *  Prozess — typisch der Daemon — besitzt die related_via-Pflege). Ohne
   *  Gate schreibt der Enricher immer. */
  writeGate?: () => boolean | Promise<boolean>;
}

/** Toleranz für Cosine-Drift zwischen Prozessen mit eigenem EmbeddingIndex
 *  (Daemon vs. Mac-App-Bridge). Drift liegt real bei ~±0.002 — 0.02 ist weit
 *  darüber und weit unter jeder inhaltlich relevanten Score-Änderung. */
const SCORE_EPSILON = 0.02;

interface RelatedViaEntry {
  id: string;
  reason: string;
  score: number;
}

export class RelatedEnricher {
  private detach?: () => void;
  private readonly topN: number;
  private readonly threshold: number;

  private readonly writeGate?: () => boolean | Promise<boolean>;

  constructor(
    private readonly vault: Vault,
    private readonly embeddings: EmbeddingIndex,
    opts: RelatedEnricherOptions = {},
  ) {
    this.topN = opts.topN ?? 5;
    this.threshold = opts.threshold ?? 0.7;
    this.writeGate = opts.writeGate;
  }

  start(): void {
    if (this.detach) return;
    this.detach = this.embeddings.onEmbed((id) => {
      // Enrichment is best-effort and runs detached, so an error here has no
      // caller to reach — it becomes an unhandled rejection, and Node ends the
      // process for those. It killed the daemon in practice: on a cloud-synced
      // vault the provider can remove the temp file before the atomic rename
      // reaches it (ENOENT on a file written milliseconds earlier), and every
      // save that hit it took the whole daemon down. launchd then restarted it,
      // which the map honestly reported as "daemon restarted" — a background
      // nicety must never be able to do that.
      void this.enrich(id).catch((err) => {
        console.error(`[bastra.related] enrich failed for ${id}: ${(err as Error).message}`);
      });
    });
  }

  stop(): void {
    this.detach?.();
    this.detach = undefined;
  }

  /** Berechnet related_via + Body-Wikilink-Section für ein Memory und
   *  schreibt das File neu, wenn sich Frontmatter ODER Body-Section ändern.
   *  Liefert die geschriebenen Einträge zurück, oder `null` wenn nichts zu
   *  tun war. */
  async enrich(id: string): Promise<RelatedViaEntry[] | null> {
    const memory = this.vault.get(id);
    if (!memory) return null;

    const similar = this.embeddings.findSimilarById(id, this.topN * 2);
    if (!similar) return null; // Vector noch nicht da

    const existing = (memory.fm as { related_via?: RelatedViaEntry[] }).related_via ?? [];
    // Hysterese: bestehende Links überleben bis threshold−ε. Sonst flappt ein
    // Nachbar, der zwischen zwei Prozessen um die Schwelle pendelt (0.699 vs
    // 0.701), als add/remove-Ping-Pong.
    const keepIds = new Set(existing.map((e) => e.id));
    // #365/13: ein `private`-Nachbar wird nie in eine Datei anderer
    // sensitivity geschrieben — weder als related_via-Kante noch als
    // [[slug]]-Wikilink. Der Slug IST der Titel (`id = slugify(title)`,
    // save.ts), die Kante trägt also Klartext an jeden Leser der fremden
    // Datei: `verbosity:'full'`, `read_document`, Obsidian-Graph. graph.ts
    // unterdrückt dieselbe Kante schon als Ghost-Node.
    // Umgekehrt gilt der Filter NICHT: im privaten Memory selbst dürfen
    // private Nachbarn stehen — die Datei trägt die Einstufung, ihr Inhalt
    // verlässt sie nicht. Der Filter läuft vor `.slice(0, topN)`, damit ein
    // ausgeschlossener Nachbar keinen Slot verbraucht, und nach der
    // Hysterese, damit eine Bestandskante ihn nicht überlebt.
    const hostIsPrivate = memory.fm.sensitivity === "private";
    const filtered = similar
      .filter((h) => h.score >= this.threshold - (keepIds.has(h.id) ? SCORE_EPSILON : 0))
      .filter((h) => hostIsPrivate || this.vault.get(h.id)?.fm.sensitivity !== "private")
      .slice(0, this.topN)
      .map<RelatedViaEntry>((h) => ({
        id: h.id,
        reason: `cosine ${h.score.toFixed(3)}`,
        score: Number(h.score.toFixed(3)),
      }));

    const sameVia = sameIdSet(existing, filtered);

    const expectedBody = rebuildBodyWithAutoSection(memory.body, filtered);
    const sameBody = autoRelatedEquivalent(memory.body, expectedBody);

    // #188: Doc-Sidecars heißen nach dem Original-File (`<file>.jpg.md`),
    // nicht nach der id — Obsidian löst [[<doc-id>]]-Links nur über die
    // `aliases`-Frontmatter-Liste auf (Standard-Obsidian-Feature). Der
    // Enricher stellt die eigene id als Alias auf jedem Doc-Sidecar sicher,
    // das er anfasst — inkrementeller Backfill statt Big-Bang-Migration.
    const aliasId = memory.fm.type === "doc" ? id : undefined;
    const missingAlias =
      aliasId !== undefined && !(memory.fm.aliases ?? []).includes(aliasId);

    if (sameVia && sameBody && !missingAlias) return null;

    if (this.writeGate && !(await this.writeGate())) return null;

    // Ein Hintergrundlauf darf jederzeit ausfallen — ein Save nicht. `raced`
    // heißt: ein anderer Writer war schneller, seine Fassung bleibt stehen.
    const outcome = await rewriteFile(
      this.vault.root,
      memory.filePath,
      id,
      filtered,
      expectedBody,
      aliasId,
    );
    if (outcome.kind !== "written") return null;
    await this.vault.reindexFile(memory.filePath);
    return filtered;
  }
}

function sameIdSet(a: RelatedViaEntry[], b: RelatedViaEntry[]): boolean {
  if (a.length !== b.length) return false;
  const aIds = new Set(a.map((e) => e.id));
  for (const e of b) if (!aIds.has(e.id)) return false;
  return true;
}

const AUTO_LINE = /^- \[\[([^\]]+)\]\] \(cosine (\d+(?:\.\d+)?)\)$/;

/** Liest die Einträge der Auto-Related-Section als id→cosine-Map.
 *  Ohne Section: leere Map (== „keine Einträge"). */
function parseAutoSectionEntries(body: string): Map<string, number> {
  const entries = new Map<string, number>();
  const startIdx = body.indexOf(AUTO_RELATED_START);
  const endIdx = body.indexOf(AUTO_RELATED_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return entries;
  const section = body.slice(startIdx + AUTO_RELATED_START.length, endIdx);
  for (const line of section.split("\n")) {
    const m = AUTO_LINE.exec(line.trim());
    if (m) entries.set(m[1], Number(m[2]));
  }
  return entries;
}

/** Drift-toleranter Body-Vergleich: gleich, wenn der Body außerhalb der
 *  Auto-Section identisch ist und die Section dieselben ids mit Cosines
 *  innerhalb von SCORE_EPSILON trägt. Reihenfolge der Einträge ist egal —
 *  zwei Prozesse dürfen bei nahezu gleichen Scores unterschiedlich sortieren,
 *  ohne sich gegenseitig zu überschreiben. */
function autoRelatedEquivalent(current: string, expected: string): boolean {
  if (current === expected) return true;
  if (stripAutoRelatedSection(current) !== stripAutoRelatedSection(expected)) {
    return false;
  }
  const a = parseAutoSectionEntries(current);
  const b = parseAutoSectionEntries(expected);
  if (a.size !== b.size) return false;
  for (const [id, score] of b) {
    const cur = a.get(id);
    if (cur === undefined || Math.abs(cur - score) > SCORE_EPSILON) return false;
  }
  return true;
}

/**
 * Baut den Body so, dass die Auto-Related-Section am Ende exakt die
 * übergebenen Einträge spiegelt. Existierende Section wird ersetzt. Bei
 * leerer Liste wird die Section komplett entfernt — der „kein guter
 * Nachbar"-Zustand soll keinen toten Block hinterlassen.
 */
function rebuildBodyWithAutoSection(
  body: string,
  entries: RelatedViaEntry[],
): string {
  const stripped = stripAutoRelatedSection(body).replace(/\n+$/, "");
  if (entries.length === 0) {
    return stripped.length > 0 ? stripped + "\n" : "";
  }
  const lines = [
    "",
    "",
    `## Auto-Related ${AUTO_RELATED_START}`,
    "",
    ...entries.map((e) => `- [[${e.id}]] (cosine ${e.score.toFixed(2)})`),
    "",
    AUTO_RELATED_END,
    "",
  ];
  return stripped + lines.join("\n");
}

/**
 * Codex-Gegenreview (P0): Hier stand eine eigene Kopie von
 * `mutateMemoryFile` — Read, Transform, Compare-and-Swap, Rename, alles von
 * Hand. Sie kannte weder die ID-Transaktion noch die Identitätsprüfung: Ein
 * Hintergrundlauf stempelte damit auf eine Datei, die inzwischen ein anderes
 * Memory hielt, und sein Rename konnte einen parallelen Save rückgängig
 * machen. Jetzt derselbe Weg wie jeder andere Writer.
 */
async function rewriteFile(
  vaultRoot: string,
  filePath: string,
  id: string,
  related_via: RelatedViaEntry[],
  newBody: string,
  ensureAlias?: string,
): Promise<MutateOutcome> {
  try {
    return await mutateMemoryFile(
      filePath,
      id,
      {
        frontmatter: (parsed) => {
          const fm = { ...parsed };
          fm.related_via = related_via;
          if (ensureAlias !== undefined) {
            // Bestehende (User-)Aliases bleiben erhalten, die id wird nur
            // ergänzt — Obsidian erlaubt auch die Bare-String-Form, deshalb
            // normalisieren.
            const existing = Array.isArray(fm.aliases)
              ? fm.aliases.map(String)
              : typeof fm.aliases === "string"
                ? [fm.aliases]
                : [];
            if (!existing.includes(ensureAlias)) fm.aliases = [...existing, ensureAlias];
          }
          return fm;
        },
        body: () => (newBody.startsWith("\n") ? newBody : `\n${newBody}`),
      },
      { vaultRoot },
    );
  } catch (err) {
    // Zwei Anreicherungen desselben Memories treffen sich jetzt am id-Lock,
    // und der Verlierer bekommt einen Write-Conflict. Für einen
    // Hintergrundlauf ist das kein Fehler, sondern genau die Aussage von
    // `raced`: Ein anderer Writer war schneller, seine Fassung bleibt stehen.
    // Das gilt auch für einen Save, der gleichzeitig läuft — der darf nicht
    // scheitern, diese Anreicherung schon.
    if ((err as { code?: string })?.code === MEMORY_WRITE_CONFLICT) return { kind: "raced" };
    throw err;
  }
}
