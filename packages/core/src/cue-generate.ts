/**
 * Der Batch-Erzeuger für `descriptive_entity`-Cues (§31 Entscheidung 1, §11.4).
 *
 * §31 Entscheidung 1 lässt offen, ob abgeleitete Cues vom schreibenden Agenten
 * beim Save oder von einem „reproduzierbaren Offline-Batch" kommen, und gibt
 * die Frage in M2 zur kontrollierten Prüfung. Das hier ist der Batch-Weg — eine
 * der beiden Bedingungen von Anlage A. Der Agentenweg ist die andere und wird
 * getrennt gebaut; beide schreiben dasselbe Format, unterscheidbar allein am
 * `origin`-Feld.
 *
 * DIE FRAGE, die dieser Erzeuger stellt, steht in der Tabelle in §11.4:
 * „Welchem übergeordneten Begriff lässt sich dieser einzelne Fakt zuordnen?"
 * Also keine Paraphrase (das ist der TriggerExpander) und keine Situation (das
 * wäre `associative_bridge`), sondern die Oberbegriffe, unter denen jemand
 * suchen würde, der den Fakt nicht beim Namen nennt.
 *
 * WAS ER LIEST — und was ausdrücklich nicht. Eingang sind Titel, Summary, Tags,
 * `topic_path` und Body: der autorisierte Inhalt. `recall_when` bleibt außen
 * vor, und das ist keine Sparsamkeit, sondern die Trennung der
 * Vertrauensklassen aus §11.4. Ein Erzeuger, der die handgeschriebenen Trigger
 * liest, schreibt sie um, statt eine eigene Cue-Familie zu bilden — er
 * repliziert das Feld, mit dem er später verglichen werden soll, und der
 * Vergleich misst dann sich selbst. Dieselbe Grenze zieht der
 * Evidenz-Fingerabdruck in `cue-sidecar.ts`.
 *
 * ABLAGE: Sidecar, niemals Frontmatter. Der TriggerExpander schreibt
 * `recall_when_expanded` in die Datei; für die Betriebsarten (lokales Modell,
 * Selbsttest, Sweep mit Abbruchbremse) ist er das Vorbild, für die Ablage
 * ausdrücklich nicht — §11.4 verlangt „ohne jede Markdown-Änderung".
 *
 * WAS HIER NICHT ENTSCHIEDEN WIRD. Cues pro Memory, Konfidenzschwelle und
 * Modell sind freie Parameter nach §18.3 und stehen alle im Options-Objekt. Die
 * Auswahlphase bestimmt sie auf ihrem eigenen Teil der Fälle; ein hier
 * eingetragener Erfahrungswert wäre genau die Vorwegnahme, die die getrennte
 * Auswahl verhindern soll. Die Defaults unten sind Platzhalter, damit der Lauf
 * startet, und als solche benannt.
 */
import type { Memory } from "./schema.js";
import type { Vault } from "./vault.js";
import { scrubInjectedBlocks } from "./scrub.js";
import { isSlugChain } from "./trigger-expand.js";
import { cueSourceFingerprint, type DerivedCue } from "./cue-sidecar.js";

/** Prompt in, rohe Modellantwort raus — dieselbe Form wie beim
 *  TriggerExpander, damit der Aufrufer `ollamaChat` durchreichen kann. */
export type ChatFn = (prompt: string) => Promise<string>;

/**
 * Der Selbsttest: Holt dieser Cue sein eigenes Memory zurück, und auf welchem
 * Rang?
 *
 * `rank` ist 1-basiert, `null` heißt „nicht im Pool". Der Rang und nicht bloß
 * ein Ja/Nein, weil die Konfidenz aus ihm kommt: Ein Cue, der sein Memory auf
 * Platz 1 holt, behauptet etwas anderes als einer, der es auf Platz 9 mitnimmt.
 */
export type CueSelfTest = (cue: string, memoryId: string) => Promise<{ rank: number | null }>;

/**
 * Fassung des Prompts. Ändert sich der Prompt-Text, ändert sich diese Zahl —
 * sonst behaupten zwei Läufe dieselbe Herkunft für zwei verschiedene Fragen.
 */
export const CUE_PROMPT_VERSION = "descriptive-entity@1";

/** Die Fassung des Erzeugers selbst (Parser, Filter, Konfidenzbildung). */
export const CUE_GENERATOR_VERSION = "cue-batch@1";

/** Platzhalter, keine Empfehlung: die Auswahlphase setzt den Wert. */
const DEFAULT_MAX_CUES = 3;
/** Platzhalter, keine Empfehlung. 0 hieße „jeder Cue, der sein Memory
 *  überhaupt zurückholt". */
const DEFAULT_MIN_CONFIDENCE = 0;
/** Ein Oberbegriff ist kurz. Längere Zeilen sind das Modell beim Erzählen. */
const MAX_CUE_LEN = 60;
/** Wie beim TriggerExpander (#367): Ein Modell, das diesen Prompt fünfmal
 *  hintereinander nicht beantwortet, beantwortet ihn auch beim 900. Memory
 *  nicht — ohne Bremse verbringt ein Sweep Stunden damit, das herauszufinden. */
const MAX_CONSECUTIVE_GEN_FAILURES = 5;

export interface CueBatchOptions {
  chat: ChatFn;
  /**
   * Pflicht, nicht optional — anders als beim TriggerExpander.
   *
   * Dort filtert der Selbsttest nur; hier ist er die QUELLE der Konfidenz, und
   * die ist nach §11.4 Bestandteil jedes Cues. Ohne ihn müsste dieser Erzeuger
   * eine Zahl erfinden, und eine erfundene Konfidenz ist keine Provenienz,
   * sondern eine Dekoration mit Nachkommastellen.
   */
  selfTest: CueSelfTest;
  /** Der Modellname, wie er beim Lauf angesprochen wird — wandert in die
   *  Provenienz. Der Erzeuger ruft nur `chat` und kennt das Modell sonst nicht. */
  model: string;
  /** Freier Parameter (§18.3). */
  maxCues?: number;
  /** Freier Parameter (§18.3): Cues unterhalb dieser Konfidenz fallen raus. */
  minConfidence?: number;
  /** Nur für Tests und für einen reproduzierbaren Zeitstempel im Artefakt. */
  now?: () => Date;
}

/** Was ein Lauf getan hat — Zahlen, keine Cue-Texte. */
export interface CueBatchReport {
  memories_seen: number;
  memories_with_cues: number;
  cues_written: number;
  /** Vom Parser verworfen: leer, zu lang, Slug-Kette, Dublette. */
  dropped_unparsable: number;
  /** Selbsttest: der Cue holte sein eigenes Memory nicht zurück. */
  dropped_self_test: number;
  /** Selbsttest bestanden, aber unter der Konfidenzschwelle. */
  dropped_low_confidence: number;
  /** Das Modell hat nichts geliefert. */
  generation_failures: number;
  /** Der Sweep wurde von der Bremse gestoppt. */
  stopped_early: boolean;
}

/**
 * Der Prompt.
 *
 * Quellfelder werden von injizierten Kontextblöcken befreit (#149) — sonst
 * bildet ein Memory, das einmal einen Hook-Block zitiert hat, Oberbegriffe über
 * das Gerüst statt über den Fakt. Der Evidenz-Fingerabdruck läuft weiterhin
 * über die ROHEN Felder: veraltet ist ein Cue, wenn der Autor etwas ändert,
 * nicht wenn sich das Scrubbing ändert.
 */
export function buildCuePrompt(m: Memory): string {
  const clean = (s: string): string => scrubInjectedBlocks(s).text;
  const body = clean(m.body).trim().slice(0, 1200);
  return [
    "Below is a single fact a user saved. Name the SUPERORDINATE CONCEPTS it",
    "belongs to — the broader categories someone would think of when they do not",
    "remember the fact itself.",
    "",
    "Rules:",
    "- Each line is ONE short concept, a noun or noun phrase of one to four words,",
    '  like "insurance paperwork" or "Steuerunterlagen" — NOT a sentence, NOT a',
    "  question, NOT a slug or hyphen-chain.",
    "- Go one level UP from the fact. If the fact is about a specific invoice, a",
    "  good answer is the kind of thing it is, not the invoice number again.",
    "- Use ONLY concepts justified by the text below. Never invent product names,",
    "  companies, people or dates that are not in it.",
    "- Write in the SAME language(s) the note uses — never translate.",
    "- One concept per line. No numbering, no quotes, no commentary, no headings.",
    "",
    `Title: ${clean(m.fm.title)}`,
    `Summary: ${clean(m.fm.summary)}`,
    `Tags: ${m.fm.tags.join(", ")}`,
    `Topic path: ${m.fm.topic_path.join(" / ")}`,
    `Text: ${body}`,
  ].join("\n");
}

/**
 * Die Antwort in Kandidaten zerlegen.
 *
 * Dieselben Strukturfilter wie beim TriggerExpander, inklusive
 * `isSlugChain` — importiert und nicht nachgebaut, weil zwei Kopien derselben
 * Regel genau die Drift sind, die die Cue-Schicht anderswo schon einmal
 * gekostet hat. Bewusst OHNE Abgleich gegen `recall_when`: Dieser Erzeuger
 * liest das Feld nicht, auch nicht zum Entdoppeln.
 */
export function parseCueCandidates(raw: string, max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const cue = line
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
      .replace(/^["'`]|["'`]$/g, "")
      .trim();
    if (!cue || cue.length > MAX_CUE_LEN || isSlugChain(cue)) continue;
    // Eine Frage ist kein Oberbegriff — das Modell hat dann die Aufgabe
    // wiederholt statt sie zu lösen.
    if (cue.endsWith("?")) continue;
    const key = cue.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cue);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Konfidenz aus dem Rang des Selbsttests: der reziproke Rang.
 *
 * Rang 1 → 1.0, Rang 2 → 0.5, Rang 4 → 0.25. Keine gelernte Kalibrierung,
 * sondern die übliche Ablesung eines Rangs als Güte, und sie ist monoton in
 * genau dem, was der Selbsttest misst. Die SCHWELLE darauf ist der freie
 * Parameter; die Abbildung selbst ist Teil des Erzeugers und steht deshalb in
 * seiner Version.
 */
export function confidenceFromRank(rank: number | null): number {
  if (rank === null || rank < 1) return 0;
  return 1 / rank;
}

/** Cues für ein Memory erzeugen. Wirft nur, was `chat` wirft. */
export async function generateCuesFor(
  m: Memory,
  opts: CueBatchOptions,
): Promise<{ cues: DerivedCue[]; dropped: { unparsable: number; selfTest: number; lowConfidence: number } }> {
  const max = opts.maxCues ?? DEFAULT_MAX_CUES;
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const now = opts.now ?? (() => new Date());

  const raw = await opts.chat(buildCuePrompt(m));
  if (raw.trim().length === 0) {
    return { cues: [], dropped: { unparsable: 0, selfTest: 0, lowConfidence: 0 } };
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0).length;
  const candidates = parseCueCandidates(raw, max);
  const unparsable = Math.max(0, lines - candidates.length);

  const fingerprint = cueSourceFingerprint(m);
  const cues: DerivedCue[] = [];
  let selfTestDropped = 0;
  let lowConfidence = 0;
  for (const cue of candidates) {
    const { rank } = await opts.selfTest(cue, m.fm.id);
    const confidence = confidenceFromRank(rank);
    if (confidence <= 0) {
      selfTestDropped++;
      continue;
    }
    if (confidence < minConfidence) {
      lowConfidence++;
      continue;
    }
    cues.push({
      memory_id: m.fm.id,
      family: "descriptive_entity",
      cue,
      origin: "batch",
      generator_version: CUE_GENERATOR_VERSION,
      model: opts.model,
      prompt_version: CUE_PROMPT_VERSION,
      derived_at: now().toISOString(),
      // Auf 4 Nachkommastellen: der reziproke Rang ist eine Ablesung, keine
      // Messung mit 17 Stellen Genauigkeit.
      confidence: Number(confidence.toFixed(4)),
      evidence: { source_fingerprint: fingerprint },
    });
  }
  return { cues, dropped: { unparsable, selfTest: selfTestDropped, lowConfidence } };
}

/**
 * Der Sweep über den Vault.
 *
 * Sequenziell, wie der Backfill des TriggerExpanders: ein LLM-Aufruf nach dem
 * anderen ist die natürliche Drossel, und ein Batch, der offline läuft, hat es
 * nicht eilig. `onCue` bekommt jeden fertigen Cue sofort, damit der Aufrufer
 * zeilenweise schreiben kann statt alles im Speicher zu halten — und damit ein
 * abgebrochener Lauf die bis dahin erhobenen Cues behält.
 */
export async function generateCueBatch(
  vault: Vault,
  opts: CueBatchOptions & { onCue: (cue: DerivedCue) => void | Promise<void> },
): Promise<CueBatchReport> {
  const report: CueBatchReport = {
    memories_seen: 0,
    memories_with_cues: 0,
    cues_written: 0,
    dropped_unparsable: 0,
    dropped_self_test: 0,
    dropped_low_confidence: 0,
    generation_failures: 0,
    stopped_early: false,
  };
  let consecutiveFailures = 0;

  for (const m of vault.list()) {
    if (m.fm.obsolete === true) continue;
    report.memories_seen++;
    let result;
    try {
      result = await generateCuesFor(m, opts);
    } catch (err) {
      report.generation_failures++;
      consecutiveFailures++;
      console.error(`[bastra.cues] generation failed for ${m.fm.id}: ${(err as Error).message}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_GEN_FAILURES) {
        console.error(
          `[bastra.cues] batch stopped after ${MAX_CONSECUTIVE_GEN_FAILURES} consecutive generation failures — check the model`,
        );
        report.stopped_early = true;
        break;
      }
      continue;
    }
    if (result.cues.length === 0 && result.dropped.unparsable === 0) {
      // Das Modell hat nichts Verwertbares geliefert — als Fehlschlag zählen,
      // sonst läuft die Bremse gegen einen stummen Sweep nicht an.
      report.generation_failures++;
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_GEN_FAILURES) {
        console.error(
          `[bastra.cues] batch stopped after ${MAX_CONSECUTIVE_GEN_FAILURES} consecutive empty generations — check the model`,
        );
        report.stopped_early = true;
        break;
      }
    } else {
      consecutiveFailures = 0;
    }
    report.dropped_unparsable += result.dropped.unparsable;
    report.dropped_self_test += result.dropped.selfTest;
    report.dropped_low_confidence += result.dropped.lowConfidence;
    if (result.cues.length > 0) report.memories_with_cues++;
    for (const cue of result.cues) {
      await opts.onCue(cue);
      report.cues_written++;
    }
  }
  return report;
}

/** Ein Cue als Sidecar-Zeile. */
export function cueToJsonl(cue: DerivedCue): string {
  return JSON.stringify(cue) + "\n";
}
