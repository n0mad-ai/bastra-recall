/**
 * Scope-Kompatibilitätsfilter für Recall-Hints — daemon-seitig, weil
 * `passesScopeFilter` den Score-Band-Kontext (mustLoadScore, anchor_strength)
 * kennen muss, den die zentrale `isScopeCompatible` (@bastra-recall/core)
 * selbst nicht trägt.
 *
 * Split aus `hook-skip.ts` (#360-Folgefund): `isScopeCompatible` lag dort
 * bis zur Zentralisierung, aber `hook-skip.ts` wird von `hook.ts` importiert
 * — dem THIN CLIENT, der bei JEDEM Tool-Call neu startet und laut eigenem
 * Kopfkommentar bewusst "stdlib + the dependency-free hook-skip/env modules
 * only" lädt. Ein Re-Export von `@bastra-recall/core/scope` aus `hook-skip.ts`
 * hätte diesen Import in JEDEN hook.ts-Start gezogen, obwohl hook.ts nur
 * `shouldSkipPath` braucht. Dieses Modul trägt den core-Import stattdessen;
 * `write-lane.ts` (das core ohnehin komplett lädt) importiert von hier.
 */
import { GLOBAL_SCOPES, isScopeCompatible, normalizeScopeKey } from "@bastra-recall/core/scope";
import { detectProjectDetailed, type DetectedProject } from "@bastra-recall/core/topics";

export { GLOBAL_SCOPES, isScopeCompatible };

/**
 * Scope-Filter-Entscheidung pro Hint (#148): lässt einen starken, ABSICHTLICHEN
 * Cross-Scope-Hit durch die #110-Hard-Filter, ohne den tag/topic-Noise-Fall
 * wieder zu öffnen.
 *
 * Kompatible Scopes passieren immer (`isScopeCompatible`). Ein FREMDER
 * Projekt-Scope passiert nur, wenn beides gilt:
 *   - der Hit matchte auf seinem HAND-geschriebenen `recall_when`
 *     (`matched_recall_when` — deliberate Cross-Project-Relevanz, nicht bloß
 *     thematische tag/topic-Überlappung), UND
 *   - er sitzt im REQUIRED-Band (`score ≥ mustLoadScore`).
 *
 * Warum nicht Score allein: der ursprüngliche #107-Bypass ließ jeden Hit mit
 * `score ≥ 100` durch, in der Annahme „hoher Score ≈ starker recall_when-Match".
 * Das wurde am Einführungstag widerlegt (#110) — ein bastra-io-Hint kam mit
 * Score 159 über reinen tag/topic-Overlap durch. Das echte
 * `matched_recall_when`-Signal trennt die beiden Fälle: der 159er-Noise-Hit
 * hätte es nie gesetzt, der absichtliche Cross-Scope-Treffer schon.
 */
export function passesScopeFilter(
  hit: {
    scope: string;
    score: number;
    matched_recall_when?: boolean;
    anchor_strength?: "strong" | "weak";
  },
  project: string | null,
  mustLoadScore: number,
): boolean {
  if (isScopeCompatible(hit.scope, project)) return true;
  // P0: Ein einzelnes häufiges Wort, das zufällig in einer fremden
  // Triggerphrase steht, ist keine Absichtserklärung — dafür verlangt der
  // Bypass jetzt einen TRAGFÄHIGEN Anker (zwei exakte Trigger-Terme oder einen
  // seltenen, siehe `anchorStrength` in core). Fehlt das Feld — ältere Antwort,
  // fremder Aufrufer —, bleibt es beim reinen Flag: Der Filter darf an einem
  // unbekannten Feld nicht strenger werden, als er es vorher war.
  if (hit.anchor_strength !== undefined && hit.anchor_strength !== "strong") return false;
  return hit.matched_recall_when === true && hit.score >= mustLoadScore;
}

// ─── Lane-Anwendung: Shadow zuerst, Erzwingen danach ───────────────────────

/**
 * `shadow` (Default) MISST, was ein Scope-Filter verwerfen würde, verwirft
 * aber nichts. `enforce` verwirft. Umgelegt über
 * `BASTRA_SCOPE_FILTER_LANES=enforce`.
 *
 * Warum nicht sofort erzwingen: Write-Lane und SessionStart filtern seit #110
 * hart, Prompt- und Todo-Lane filterten NIE (Befund aus §19 des
 * Recall-Handoffs). Wie viele Treffer das betrifft, weiß niemand — die Zahl
 * existiert nirgends, weil der Filter dort nie lief. Ein Filter, der ohne
 * gemessene Grundlinie scharfgeschaltet wird, kann eigene Treffer lautlos
 * entfernen, und genau diese Fehlerklasse (#360) wurde gerade geschlossen.
 * Der Shadow-Modus schreibt `dropped_scope_count` in dieselbe Telemetrie, aus
 * der die Entscheidung dann fällt.
 */
export type ScopeFilterMode = "shadow" | "enforce";

export function laneScopeFilterMode(): ScopeFilterMode {
  return process.env.BASTRA_SCOPE_FILTER_LANES === "enforce" ? "enforce" : "shadow";
}

export interface LaneScopeHit {
  scope: string;
  score: number;
  matched_recall_when?: boolean;
  anchor_strength?: "strong" | "weak";
  recall_mode?: string;
}

export interface LaneScopeFilterOptions {
  /**
   * Lässt einen starken, absichtlichen Cross-Scope-Anker durch
   * ({@link passesScopeFilter}). Die Prompt-Lane behält diese Ausnahme — dort
   * ist ein hand-geschriebener Trigger aus einem anderen Projekt eine echte
   * Absichtserklärung. Die Todo-Lane bekommt sie NICHT: Sie fragt ausdrücklich
   * nach `type: project-fact` für den aktuellen Arbeitsplan, und ein fremder
   * Projekt-Fakt ist dort fast immer Kontamination.
   */
  allowAnchoredCrossScope: boolean;
  /** Nur relevant, wenn {@link allowAnchoredCrossScope} gilt. */
  mustLoadScore: number;
  /**
   * Ohne Fusion gibt es kein „beide Arme stimmen überein"-Signal, an dem sich
   * ein Cross-Scope-Bypass festmachen könnte — rohe BM25-Werte reißen jede
   * Schwelle. Für FREMDE Scopes ist die Ausnahme dann zu, unabhängig von
   * `allowAnchoredCrossScope`: fail-closed, weil das Signal fehlt, nicht weil
   * der Treffer schlecht wäre.
   */
  unfused: boolean;
  /**
   * Vom User verdrahtete Reflex-Treffer passieren IMMER. Sie sind hart
   * getriggert und ausdrücklich autorisiert — das ist eigene Produktsemantik
   * (#217), kein Ranking-Ergebnis, das ein Scope-Filter zweitbewerten dürfte.
   * Gilt auch für semantische Treffer mit `recall_mode: "reflex"`.
   */
  exemptReflex: boolean;
  /**
   * Kennt der VAULT diesen Projektnamen (`project_known` aus der
   * Recall-Antwort)? Das ist der belastbare Beleg — `false` heißt: der Name
   * kam aus dem Dateisystem, nicht aus dem Gedächtnis, und darf nichts
   * verwerfen. Fehlt das Feld (älterer Daemon, fremder Aufrufer), fällt der
   * Filter auf den schwächeren Beleg aus der Ergebnisliste zurück; strenger
   * darf er an einem unbekannten Feld nie werden.
   */
  projectKnown?: boolean;
}

/**
 * Hat der Filter einen BELEG, dass sein Projektname eine reale Scope-Identität
 * ist? (Codex-Gegenreview zum Confidence-Gate.)
 *
 * `root-match` heißt nur „ein Pfadsegment hieß workspace/src/code" — nicht,
 * dass der Name danach ein Vault-Scope ist. `/workspace/packages/core` und
 * `/Users/me/src/packages/core` liefern beide das Filterprojekt "packages",
 * beide mit voller Zuversicht. Ein scharfer Filter würde damit erneut das
 * gesamte eigene Projektgedächtnis entfernen — dieselbe Wirkung wie #360,
 * wieder aus einer anderen Ursache.
 *
 * Der Beleg steht in der Antwort selbst: Trägt KEIN Treffer einen Scope, der
 * zu diesem Projekt passt, dann kennt der Filter seinen eigenen Namen nicht
 * wieder und wirft blind alles weg. Globale Scopes zählen dabei NICHT als
 * Beleg — sie passen per Definition zu jedem Projekt und würden auch einen
 * erfundenen Namen bestätigen.
 *
 * Das ist absichtlich eine lokale Prüfung an der Ergebnisliste und keine
 * Abfrage der Vault-Scopes: Sie braucht keinen Vault-Zugriff im Hot Path,
 * greift in allen drei Lanes gleich und schlägt genau dann an, wenn der
 * Schaden entstehen würde — nämlich wenn nichts als „eigenes" übrig bliebe.
 */
function hasScopeEvidence(hits: LaneScopeHit[], project: string): boolean {
  for (const h of hits) {
    if (!h.scope || GLOBAL_SCOPES.has(normalizeScopeKey(h.scope))) continue;
    if (isScopeCompatible(h.scope, project)) return true;
  }
  return false;
}

export interface LaneScopeFilterResult<T> {
  /** Was die Lane weiterverwendet — im Shadow-Modus die Eingabe unverändert. */
  hits: T[];
  /** Wie viele ein Erzwingen verwerfen würde. Im Shadow-Modus die Messung. */
  droppedCount: number;
  /** Die fremden Scopes, für die Auswertung nach Häufigkeit. */
  droppedScopes: string[];
  mode: ScopeFilterMode;
  /** Der Name, gegen den tatsächlich verglichen wurde — `null`, wenn nicht
   *  gefiltert wurde. Ohne ihn ist `dropped_scopes` nicht interpretierbar:
   *  Man sähe die verworfenen Scopes, aber nicht, dass irrtümlich gegen
   *  "packages" verglichen wurde. */
  filterProject: string | null;
  /** Warum nicht gefiltert wurde, wenn nicht gefiltert wurde. */
  skipped?: "no-project" | "no-scope-evidence";
}

export function applyLaneScopeFilter<T extends LaneScopeHit>(
  hits: T[],
  project: string | null,
  opts: LaneScopeFilterOptions,
  mode: ScopeFilterMode = laneScopeFilterMode(),
): LaneScopeFilterResult<T> {
  if (!project) {
    return { hits, droppedCount: 0, droppedScopes: [], mode, filterProject: null, skipped: "no-project" };
  }
  if (opts.projectKnown === false || (opts.projectKnown === undefined && !hasScopeEvidence(hits, project))) {
    return {
      hits,
      droppedCount: 0,
      droppedScopes: [],
      mode,
      filterProject: null,
      skipped: "no-scope-evidence",
    };
  }
  const kept: T[] = [];
  const droppedScopes: string[] = [];
  for (const h of hits) {
    if (passesLaneScope(h, project, opts)) {
      kept.push(h);
      continue;
    }
    droppedScopes.push(h.scope);
  }
  return {
    hits: mode === "enforce" ? kept : hits,
    droppedCount: droppedScopes.length,
    droppedScopes,
    mode,
    filterProject: project,
  };
}

function passesLaneScope(hit: LaneScopeHit, project: string | null, opts: LaneScopeFilterOptions): boolean {
  if (opts.exemptReflex && hit.recall_mode === "reflex") return true;
  if (isScopeCompatible(hit.scope, project)) return true;
  if (!opts.allowAnchoredCrossScope || opts.unfused) return false;
  return passesScopeFilter(hit, project, opts.mustLoadScore);
}

// ─── Wann ein Projektname überhaupt filtern darf ──────────────────────────

/**
 * Der Projektname, mit dem ein HARD-FILTER arbeiten darf — oder `null`.
 *
 * `detectProject()` gibt für jeden nichtleeren Pfad irgendeinen Namen zurück:
 * `/tmp/worktree/packages/core` wird zu "core", und der Aufrufer kann das
 * nicht von einer echten Erkennung unterscheiden. Ein Filter, der auf so einem
 * geratenen Namen fußt, entfernt EIGENE Treffer lautlos — dieselbe Wirkung wie
 * der case-sensitive Vergleich aus #360, nur mit anderer Ursache.
 *
 * Deshalb: filtern nur bei `root-match` (ein bekanntes Repo-Wurzelsegment wie
 * `Projekte/` wurde getroffen). Beim Fallback liefert diese Funktion `null` —
 * `isScopeCompatible(scope, null)` ist true, der Filter ist also offen statt
 * falsch streng. Für Telemetrie bleibt der geratene Name über
 * `projectConfidence` sichtbar; zum Wegwerfen taugt er nicht.
 *
 * Rückgabe ist `key`, nie `raw`: Filter vergleichen kanonisch (topics.ts).
 */
export function projectForFilter(cwd: string): string | null {
  const d = detectProjectDetailed(cwd);
  return isTrustedDetection(d) ? d.key : null;
}

/**
 * Der Projektname, den eine Lane für QUERY und ANZEIGE benutzen darf — oder
 * `null`.
 *
 * Ursprünglich stand hier `detectProject()`: jeder Pfad ergab irgendeinen
 * Namen, und die Lanes bauten daraus eine Recall-Query `scope: <geraten>` und
 * ein `project="<geraten>"` im ausgelieferten Block. Für ein cwd ohne `.git`
 * und ohne Container-Segment — eine Agenten-Session in `~/.buzz` — hieß das
 * Projekt dann ".buzz": die Lane lud Kandidaten für ein Projekt, das es nicht
 * gibt, und behauptete im Kontextblock, das sei das Projekt der Sitzung. Eine
 * geratene Erkennung ist kein Projekt, also gibt es dann auch keine
 * projektbezogene Query und kein `project`-Attribut.
 *
 * Dieselbe Konfidenz-Regel wie {@link projectForFilter} — nur die Projektion
 * ist eine andere: `raw` statt `key`, weil Query und Anzeige seit jeher den
 * Namen in echter Schreibweise tragen und `isScopeCompatible` die Groß-/
 * Kleinschreibung ohnehin faltet.
 */
export function projectForLane(cwd: string): string | null {
  const d = detectProjectDetailed(cwd);
  return isTrustedDetection(d) ? d.raw : null;
}

/** `git-root` und `root-match` sind Erkennungen, `fallback` ist ein Rat. Ein
 *  git-root ist die einzige Auskunft, die wirklich ein Repo benennt; die
 *  Container-Heuristik bleibt als Rückfall für Verzeichnisse ohne `.git`. */
function isTrustedDetection(d: DetectedProject): boolean {
  return d.confidence === "git-root" || d.confidence === "root-match";
}

/** Die Erkennungsgüte für die Telemetrie — ohne sie ist `dropped_scope_count`
 *  nicht interpretierbar: Verwerfen bei geratenem Projekt heißt etwas anderes
 *  als Verwerfen bei erkanntem. */
export function projectConfidence(cwd: string): DetectedProject["confidence"] {
  return detectProjectDetailed(cwd).confidence;
}

/**
 * Kennt der Vault diesen Projektnamen als Scope — oder als Familienmitglied?
 *
 * Die Frage, die `root-match` NICHT beantwortet (siehe {@link projectForFilter}).
 * Sie ist nur dort beantwortbar, wo der Vault liegt: im Daemon-Prozess, nicht
 * in den Lanes, die ihn über HTTP ansprechen. Die Recall-Antwort trägt das
 * Ergebnis als `project_known` zu ihnen.
 *
 * Früher Abbruch: Im Normalfall trifft der erste eigene Treffer sofort; nur
 * der seltene Fehlerfall („packages") läuft einmal durch die Liste.
 */
export function vaultKnowsProject(
  vault: { list(): Array<{ fm: { scope?: unknown } }> },
  project: string,
): boolean {
  if (!project) return false;
  for (const m of vault.list()) {
    const scope = m.fm.scope;
    if (typeof scope !== "string" || !scope) continue;
    if (GLOBAL_SCOPES.has(normalizeScopeKey(scope))) continue;
    if (isScopeCompatible(scope, project)) return true;
  }
  return false;
}
