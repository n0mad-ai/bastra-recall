/**
 * Der projektbewusste Session-Assembler (#265, §16.1, §9.4, §26.1).
 *
 * Bis hierher gab es zwei Wege in denselben Kontext: die SessionStart-Lane für
 * Claude Code (projektbewusst, über Loopback-Aufrufe) und `buildSessionContext`
 * für hooklose Clients über den MCP-Forwarder (in-Prozess, aber absichtlich
 * projektlos). Der zweite konnte den ersten nicht ersetzen — §26.1 verlangt
 * genau das: EIN geteilter Assembler, der Projektpfad und Scope korrekt
 * übernimmt und für bestehende Clients kompatibel bleibt.
 *
 * DIE AUFTEILUNG. Dieses Modul erhebt Abschnitte (`assembleSessionSections`)
 * und rendert sie (`renderSessionContext`). Der `GET`-Vertrag ist genau die
 * Projektion „projektlos, ohne Budget" — er ruft dieselben Erheber und bekommt
 * denselben Text wie vorher; ein Test hält das fest. `POST` ist dieselbe
 * Erhebung mit Projekt, Budgets und Metadaten in der Antwort.
 *
 * REIHENFOLGE IST NICHT PRIORITÄT. Die Blöcke erscheinen im Text in der
 * gewachsenen Reihenfolge (gepinnt, Hinweise, Konventionen, Care, Import,
 * Onboarding) — daran hängt der bestehende Vertrag. Welche Blöcke ein knappes
 * Budget ÜBERLEBEN, ist eine andere Frage und steht als eigenes Feld daneben:
 * Ein gepinnter Floor ist push-by-state und darf nicht am Budget sterben, ein
 * Onboarding-Angebot schon. Beides in eine Zahl zu falten hieße, den Text
 * umzusortieren, sobald jemand die Priorität ändert.
 *
 * WAS HIER NICHT LÄUFT. Kein Cross-Encoder, kein Reranker, kein Deep Recall —
 * §9.4 und C-031/C-052 verbieten das im SessionStart-Budget, und der Assembler
 * ruft nichts davon auf. Er blockiert auch auf nichts dergleichen: Was seine
 * Deadline reißt, wird fallengelassen und benannt.
 *
 * SCHNITTSTELLE FÜR #266. `SessionBudget` und die `blocks`-Liste der Antwort
 * sind die Fläche, an der der Context Governor später ansetzt: Er würde die
 * Budgets setzen, statt sie wie heute aus der Anfrage oder den Defaults zu
 * nehmen. Hier wird nichts dafür vorgebaut — die Felder existieren, weil dieser
 * Endpunkt sie selbst braucht.
 */
import { readFile } from "node:fs/promises";
import { CANDIDATES_ONLY_NOTICE } from "./band-wording.js";
import { join } from "node:path";
import type { Vault } from "@bastra-recall/core";
import { abandonAfter } from "@bastra-recall/core";
import { recallHandler, type ToolDeps } from "./tool-handlers.js";
import { governContext, estimateTokens } from "./context-governor.js";
import { runHookRecall, type HookRecallDeps } from "./http-hook-routes.js";
import { listFloors } from "./floors.js";
import type { PinnedFloorLean } from "./pinned-block.js";
import type { ConventionLean } from "./taxonomy.js";
import { listConventions } from "./taxonomy.js";
import { parseCareFile, CARE_FILE } from "./webui.js";
import { countOpenImports, IMPORT_FILE } from "./import-review.js";
import { queueStatus } from "./import-mining.js";
import { isOnboardingNeeded } from "./onboarding.js";

const MAX_PINNED = 5;
const MAX_HINTS = 3;
const MAX_CONVENTIONS = 4;
/** Projekt-Hinweise, wenn ein Projekt erkannt wurde — dieselbe Zahl wie in der
 *  SessionStart-Lane, damit beide Wege denselben Umfang liefern. */
const MAX_PROJECT_HINTS = 3;

/** Voreinstellung des Gesamtbudgets. Bewusst großzügig gegenüber dem
 *  Hook-Budget: Dieser Weg bedient auch hooklose Clients ohne 500-ms-Fenster.
 *  Der Aufrufer überschreibt beides pro Anfrage. */
const DEFAULT_BUDGET_MS = 800;
/** `0` heißt „kein Token-Budget" — der bestehende GET-Vertrag kennt keins. */
const DEFAULT_BUDGET_TOKENS = 0;

/** Welche Abschnitte es gibt. Der Name landet in der Antwort, also ist er
 *  Vertrag und keine Beschriftung. */
export type SectionKind =
  | "pinned"
  | "project"
  | "cross_project"
  | "hints"
  | "conventions"
  | "care"
  | "import"
  | "onboarding";

/**
 * Reihenfolge im gerenderten Text. Entspricht exakt dem gewachsenen Aufbau;
 * `project` steht direkt hinter den gepinnten Einträgen, weil es dieselbe
 * Sorte Aussage ist — was in DIESEM Projekt gilt.
 */
const RENDER_ORDER: SectionKind[] = [
  "pinned",
  "project",
  "cross_project",
  "hints",
  "conventions",
  "care",
  "import",
  "onboarding",
];

/**
 * Was ein knappes Budget überlebt, kleiner ist wichtiger.
 *
 * Gepinnte Floors zuerst, weil sie push-by-state sind: Ein Constraint, das
 * präsent sein soll, wenn der Turn ihn nicht für relevant hält, darf nicht am
 * Budget sterben. Onboarding zuletzt, weil es ein Angebot ist und beim nächsten
 * Start wiederkommt.
 */
const PRIORITY: Record<SectionKind, number> = {
  pinned: 1,
  project: 2,
  cross_project: 3,
  hints: 4,
  conventions: 5,
  care: 6,
  import: 7,
  onboarding: 8,
};

export interface SessionSection {
  kind: SectionKind;
  /** Die fertigen Zeilen dieses Abschnitts. Leer = nichts zu sagen. */
  lines: string[];
}

/** Ein Abschnitt in der Antwort — inklusive der Auskunft, warum er fehlt. */
export interface SectionReport {
  kind: SectionKind;
  priority: number;
  tokens_est: number;
  included: boolean;
  /** Nur wenn `included` false ist. `empty` = der Abschnitt hatte nichts zu
   *  sagen; `deadline` = er war nicht rechtzeitig fertig; `token_budget` = er
   *  hätte das Budget gesprengt. */
  omitted?: "empty" | "deadline" | "token_budget";
}

export interface SessionBudget {
  /** Gesamtzeit für die Erhebung. */
  time_ms?: number;
  /** Obergrenze für den gerenderten Text; 0 = keine. */
  tokens?: number;
}

export interface AssembleOptions {
  /** Das erkannte Projekt, oder `null` für den projektlosen Weg. */
  project?: string | null;
  /** `startup` | `resume` | `clear` | `compact` — durchgereicht an die
   *  Telemetrie, damit sich Sessionstarts von Mid-Session-Neuaufbauten
   *  trennen lassen. */
  source?: string | null;
  session_id?: string | null;
  budget?: SessionBudget;
  /**
   * #265/C-046: Die Hop-Baseline. `1` heißt: ein `related_via`-Hop wird
   * mitgenommen — der einzige live erprobte semantische Blick des Hook-Pfades
   * und der Kontrollarm, den jede neue Sicht schlagen muss (§13.1, §22).
   *
   * Der Default ist deshalb `1` und nicht das Weglassen: Bisher kam der Hop
   * dadurch zustande, dass der `/hook/recall`-Endpunkt ihn setzt, wenn der
   * Aufrufer nichts sagt — kein Hook fragt ihn an. Absorbiert der Assembler
   * diese Recalls, verschwände die Baseline stillschweigend, sobald niemand sie
   * ausdrücklich anfordert. Genau das verbietet die Auflage.
   *
   * Der GET-Weg setzt ausdrücklich `0` und behält damit sein heutiges
   * Verhalten: Der MCP-Forwarder fragt Hops ebenfalls nicht an (`expand_hops`
   * 0 in mcp-forwarder.ts), und eine hooklose Oberfläche soll nicht plötzlich
   * mehr bekommen, weil hier ein Default umgezogen ist.
   */
  expand_hops?: 0 | 1;
  /**
   * #265: Die Cross-Project-Regeln (`scope: "all-projects"`) mit erheben.
   *
   * Nur die SessionStart-Lane fragt sie; der Forwarder-Weg kennt sie nicht und
   * bekommt sie auch nicht, sonst wüchse sein Block. Default aus.
   */
  cross_project?: boolean;
  /**
   * Wieviel je Abschnitt. Die Vorgaben sind die des Endpunkts; die Lane setzt
   * ihre eigenen, weil ihr Dokument seit jeher andere Mengen zeigt
   * (6 Konventionen, ungekappte Floors, 7 gemergte Hinweise). Ohne diese
   * Optionen wäre der Umzug der Lane eine stille Produktänderung.
   */
  caps?: { pinned?: number; hints?: number; conventions?: number; project?: number };
  /**
   * WELCHE Recall-Pipeline (#265).
   *
   * Fehlt das Feld, läuft `recallHandler` — der MCP-Weg, und das ist der
   * GET-Vertrag. Ist es gesetzt, läuft `runHookRecall`: dieselbe Pipeline, die
   * `/hook/recall` fährt, inklusive Scope-Filter (#110/#148), Reflex-Hits und
   * Router-Schatten (#362).
   *
   * Der Schalter steht hier ausdrücklich und nicht als globale Umstellung: Die
   * beiden Wege liefern NACHWEISLICH verschiedene Trefferauswahlen, und der
   * Forwarder auf die Hook-Pipeline zu heben wäre eine stille Produktänderung
   * für hooklose Clients — am selben Tag, an dem der GET-Vertrag byte-gleich
   * festgeschrieben wurde. Die Vereinheitlichung ist eine eigene, bewusste
   * Entscheidung (offener Punkt zu #265, vermutlich mit #264).
   */
  hookRecall?: HookRecallDeps;
  /**
   * Deadline des dichten Arms in ms, pro Aufruf (`vector_deadline_ms`).
   *
   * Fehlt das Feld, gilt der hookweite Default (`BASTRA_VECTOR_DEADLINE_MS`,
   * 150) — die Prompt-Lane und der GET-Weg bleiben damit unangetastet. Gesetzt
   * wird es nur von der SessionStart-Lane: der Deep-Dive vom 07.09.2026 hat
   * gemessen, dass 46 % ihrer Recalls bei 150 ms einarmig zurückkommen, weil
   * der erste Embed auf kaltem Modell ~160-180 ms braucht und diese Route
   * keinen Prewarmer hat. Nur wirksam auf dem `hookRecall`-Weg — der GET-Weg
   * fährt `recallHandler`, der die Deadline nicht kennt.
   */
  vector_deadline_ms?: number;
  /**
   * #494: Ohne dichten Arm erheben (`lexical_only`).
   *
   * Gesetzt vom SessionStart auf einem Modell, das NICHT im Speicher liegt.
   * Vorher schickte er dort eine 50-ms-Frist — ein Embed, der sicher aufgegeben
   * wird, dreimal parallel, neben dem Warmup, der daneben ohnehin läuft. Der
   * Verzicht ist billiger und liefert dasselbe Ergebnis. Schlägt
   * `vector_deadline_ms`: Wo kein Arm läuft, gibt es keine Frist zu setzen.
   */
  lexical_only?: boolean;
  /**
   * Das Budget, gegen das der Schatten-Router seine Kostenschätzung hält, in ms
   * (`hook_budget_ms`).
   *
   * Fehlt das Feld, gilt der hookweite Wert (`BASTRA_HOOK_BUDGET_MS`, 200).
   * Gesetzt wird es nur von der SessionStart-Lane, die eine andere Wanduhr hat
   * als die Prompt-Lane. Rein diagnostisch: der Wert erreicht `routeRetrieval`
   * und von dort ausschließlich das `shadow_route`-Telemetriefeld — kein
   * Timeout, kein Abbruch, keine Trefferauswahl (#362 Phase 2 ist Schatten).
   */
  hook_budget_ms?: number;
  /**
   * #493: Die Klammer um die (bis zu drei) Recalls EINES Sitzungsstarts.
   *
   * Sie reist bis auf jedes `hook_recall`-Event durch. Ohne sie ist „20
   * Kaltstarts" (Tor 3 aus #492) nicht von „7 Kaltstarts × 3 Recalls" zu
   * unterscheiden, und die `session_id` beantwortet die Frage nicht: Sie
   * bleibt über compact/clear/resume dieselbe, also über beliebig viele
   * Starts hinweg.
   */
  session_start_call_id?: string | null;
  /** #263: Wer fragt. Der Endpunkt weist sich als eigene Hook-Quelle aus,
   *  sonst wären seine Recalls von denen des Forwarders nicht zu trennen.
   *  `unknown`, weil der Wert aus einem Request-Body kommt — normalisiert wird
   *  er in `telemetry.ts`, nicht hier. */
  client?: unknown;
}

/** Injizierbare Mitspieler — Defaults treffen die echten Module. */
export interface SessionContextDeps {
  recallFn?: typeof recallHandler;
  listFloorsFn?: typeof listFloors;
  listConventionsFn?: typeof listConventions;
}

/**
 * Der Modus-Marker aus §9.4.
 *
 * `deep_recall` steht dort auch, kommt hier aber nie vor: Der Assembler ist
 * kein Konsument von Deep Recall (C-031/C-052).
 */
export type RetrievalMarker = "lexical_only" | "hybrid" | "degraded";

/**
 * Das Rohmaterial hinter den Abschnitten (#265).
 *
 * Die SessionStart-Lane rendert ihr Dokument selbst — mit Banding, Headline und
 * eigenen Mengen. Sie braucht deshalb die Daten, nicht die fertigen Zeilen. Die
 * Felder sind additiv: Wer nur `sections` liest, merkt nichts davon.
 */
export interface SessionRawData {
  /** Pro Recall die Antwort der Pipeline, in Abfragereihenfolge — dieselbe
   *  Form, die `/hook/recall` liefert, damit die Lane sie wie bisher liest
   *  (`isUnfused`, `mergeSessionHits`). `null`, wo der Recall scheiterte. */
  recalls: Array<{ scope: string; resp: unknown | null }>;
  floors: PinnedFloorLean[];
  conventions: ConventionLean[];
  care: { open: number; queued: number };
  imports: { open: number; queued: number };
  onboarding: boolean;
}

export interface AssembledSession {
  sections: SessionSection[];
  /** #265: das Rohmaterial, für Aufrufer die selbst rendern. */
  data: SessionRawData;
  reports: SectionReport[];
  /**
   * Wie der Retrievalpfad wirklich gelaufen ist.
   *
   * Rangfolge, und sie ist die Umsetzung von „ein unvollständiger Hybridpfad
   * darf nicht so tun, als wäre er vollständig": Meldet ein Recall ein
   * `degraded`, gewinnt das — dort war ein Arm geplant und ausgefallen.
   * `lexical_only` heißt, dass gar kein zweiter Arm vorgesehen war. Erst wenn
   * beides nicht zutrifft, ist es `hybrid`.
   *
   * `null`, wenn kein Recall lief (dann gibt es keinen Pfad zu kennzeichnen).
   */
  marker: RetrievalMarker | null;
  /** Abschnitte, die die Deadline gerissen haben. */
  aborted: SectionKind[];
  elapsed_ms: number;
}

interface RecallHitLean {
  id: string;
  type: string;
  summary: string;
  score: number;
}

interface RecallShape {
  hits?: RecallHitLean[];
  unfused?: boolean;
  degraded?: string;
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** #266: Die Token-Schätzung kommt aus dem Governor — eine Formel, nicht zwei.
 *  Re-exportiert, damit die bestehenden Aufrufer ihren Importpfad behalten. */
export { estimateTokens } from "./context-governor.js";

/**
 * Alle Abschnitte erheben — nebenläufig, unter einer gemeinsamen Deadline.
 *
 * Die sieben Erheber hängen nicht voneinander ab; sequenziell addierten sich
 * ihre Kosten in genau dem Budget, das §16.1 begrenzt. Jeder ist für sich
 * fail-open: Ein kaputter Taxonomie-Aufruf kostet seinen Abschnitt, nicht die
 * Antwort.
 */
export async function assembleSessionSections(
  toolDeps: ToolDeps,
  vault: Vault,
  opts: AssembleOptions = {},
  deps: SessionContextDeps = {},
): Promise<AssembledSession> {
  const startedAt = Date.now();
  const recallFn = deps.recallFn ?? recallHandler;
  const listFloorsFn = deps.listFloorsFn ?? listFloors;
  const listConventionsFn = deps.listConventionsFn ?? listConventions;
  const project = opts.project ?? null;
  const budgetMs = opts.budget?.time_ms ?? DEFAULT_BUDGET_MS;
  const budgetTokens = opts.budget?.tokens ?? DEFAULT_BUDGET_TOKENS;

  // Der Modus wird aus den Recalls gelesen, nicht geraten.
  let sawDegraded = false;
  let sawUnfused = false;
  let sawRecall = false;

  // C-046: Die Baseline gilt, solange der Aufrufer nichts anderes sagt.
  const expandHops = opts.expand_hops ?? 1;

  // #265: Die Rohantworten, in Abfragereihenfolge — die Lane liest sie wie die
  // Antworten ihrer früheren Einzelaufrufe.
  // Die Erheber laufen nebenläufig, die Antworten kämen also in
  // Abschlussreihenfolge an — für einen Aufrufer, der die Reihenfolge als
  // Priorität liest, wäre das von Lauf zu Lauf verschieden. Deshalb trägt jeder
  // Recall seinen Platz mit und wird am Ende danach sortiert.
  const recalls: Array<{ scope: string; resp: unknown | null; order: number }> = [];
  let rawFloors: PinnedFloorLean[] = [];
  let rawConventions: ConventionLean[] = [];
  let rawCare = { open: 0, queued: 0 };
  let rawImports = { open: 0, queued: 0 };
  let rawOnboarding = false;

  const runRecall = async (
    query: string,
    scope: string,
    k: number,
    order: number,
  ): Promise<string[]> => {
    let result: RecallShape;
    if (opts.hookRecall) {
      // Die Pipeline, die auch `/hook/recall` fährt: Scope-Filter, Reflex-Hits,
      // Router-Schatten. `t0` ist der Startpunkt dieser Erhebung.
      result = (await runHookRecall(
        {
          query,
          scope,
          k,
          expand_hops: expandHops,
          session_id: opts.session_id ?? undefined,
          // #429: Die Dimensionen gehören AUCH auf diesen Weg. `runHookRecall`
          // liest `client` und `hook_source` aus dem Body und schreibt sie an
          // `hook_recall` UND `evidence_decision`; fehlen sie, landet die
          // produktive POST-Lane als `unknown/unknown` und die Splits aus #263
          // trennen ausgerechnet sie nicht. Gleiche Werte wie im GET-Zweig
          // unten — es ist dieselbe Oberfläche, nur die andere Pipeline.
          client: opts.client,
          hook_source: "session-context",
          ...(opts.vector_deadline_ms !== undefined
            ? { vector_deadline_ms: opts.vector_deadline_ms }
            : {}),
          // #494: siehe `lexical_only` oben — der Verzicht reist bis an die
          // Pipeline durch, sonst führe hier doch ein dichter Arm.
          ...(opts.lexical_only ? { lexical_only: true } : {}),
          ...(opts.hook_budget_ms !== undefined ? { hook_budget_ms: opts.hook_budget_ms } : {}),
          // #493: siehe `session_start_call_id` oben.
          ...(opts.session_start_call_id ? { session_start_call_id: opts.session_start_call_id } : {}),
        },
        query,
        startedAt,
        opts.hookRecall,
      )) as RecallShape;
    } else {
      result = (await recallFn(
        toolDeps,
        { query, scope, k, expand_hops: expandHops },
        {
          // #263: Dieser Endpunkt ist eine eigene Oberfläche.
          client: opts.client,
          hook_source: "session-context",
          session_id: opts.session_id ?? undefined,
        },
      )) as RecallShape;
    }
    recalls.push({ scope, resp: result, order });
    sawRecall = true;
    if (result.degraded) sawDegraded = true;
    if (result.unfused) sawUnfused = true;
    const out: string[] = [];
    for (const h of result.hits ?? []) {
      if (h.score < 30) continue;
      out.push(`- ${h.id} (${h.type}): ${clip(h.summary, 200)}`);
    }
    return out;
  };

  const producers: Array<{ kind: SectionKind; run: () => Promise<string[]> }> = [
    {
      kind: "pinned",
      run: async () => {
        // Ohne erkanntes Projekt nur globale Floors — fremd-gescopte Einträge
        // wären in einer projektlosen Session Rauschen.
        const all = await listFloorsFn(project ?? undefined);
        // `0` heißt ungekappt — die Lane zeigt seit jeher alle Floors, und
        // `Infinity` überlebt kein JSON.
        const capped = opts.caps?.pinned ?? MAX_PINNED;
        const floors = (project ? all : all.filter((e) => !e.scope)).slice(
          0,
          capped > 0 ? capped : undefined,
        );
        rawFloors = floors;
        return floors.map(
          (f) =>
            `- [pinned] ${f.memory_id}` +
            (vault.get(f.memory_id)
              ? `: ${clip(vault.get(f.memory_id)!.fm.summary ?? vault.get(f.memory_id)!.fm.title, 180)}`
              : ""),
        );
      },
    },
    {
      kind: "project",
      run: async () =>
        project
          ? runRecall(
              `${project} active context project-facts decisions`,
              project,
              opts.caps?.project ?? MAX_PROJECT_HINTS,
              0,
            )
          : [],
    },
    {
      kind: "cross_project",
      run: async () =>
        opts.cross_project ? runRecall("cross-project working rules", "all-projects", 2, 1) : [],
    },
    {
      kind: "hints",
      run: () =>
        runRecall(
          "session-start preferences active context",
          "user-preference",
          opts.caps?.hints ?? MAX_HINTS,
          2,
        ),
    },
    {
      kind: "conventions",
      run: async () => {
        const conventions = listConventionsFn(vault).slice(
          0,
          opts.caps?.conventions ?? MAX_CONVENTIONS,
        );
        rawConventions = conventions;
        return conventions.length > 0
          ? [
              `- Conventions (BINDING when saving in these clusters — load_memory(id) for the rule): ` +
                conventions.map((c) => c.id).join(", "),
            ]
          : [];
      },
    },
    {
      kind: "care",
      run: async () => {
        const content = await readFile(join(toolDeps.vaultPath, CARE_FILE), "utf8");
        const openCare = parseCareFile(content).filter((e) => !e.done).length;
        rawCare = { open: openCare, queued: 0 };
        return openCare > 0
          ? [
              `- Vault care: ${openCare} open flag(s) in ${CARE_FILE} — when the user asks to groom the vault, work the "- [ ]" entries through WITH them.`,
            ]
          : [];
      },
    },
    {
      kind: "import",
      run: async () => {
        const lines: string[] = [];
        const openImports = await countOpenImports(toolDeps.vaultPath);
        rawImports = { open: openImports, queued: 0 };
        if (openImports > 0) {
          lines.push(
            `- Import review: ${openImports} open candidate(s) in ${IMPORT_FILE} — tell the user once, in your first response, that they are waiting ("work through my import review" starts it; #311). Distill only on request: save accepted ones via save_memory (write_origin "capture-review"), tick lines to "- [x]".`,
          );
        }
        const queue = await queueStatus();
        rawImports = { open: openImports, queued: queue.remaining };
        if (queue.remaining > 0) {
          lines.push(
            `- Chat-history mining: ${queue.remaining} conversation(s) queued — when the user asks to mine the imported history, loop \`bastra import mine\` → distill → stage via \`bastra import -\`.`,
          );
        }
        return lines;
      },
    },
    {
      kind: "onboarding",
      run: async () =>
        (rawOnboarding = await isOnboardingNeeded(toolDeps.vaultPath, vault.size()))
          ? [
              `- Onboarding: this vault is fresh — offer ONCE a ~5-minute interview (persona, address/tone, hard rules, persona follow-ups), save each answer via save_memory with write_origin "user-directed"; finish with \`bastra onboard done\`, decline with \`bastra onboard skip\`.`,
            ]
          : [],
    },
  ];

  const settled = await Promise.all(
    producers.map(async (p) => {
      const remaining = Math.max(0, budgetMs - (Date.now() - startedAt));
      // `abandonAfter` gibt auf, statt abzubrechen — dieselbe Semantik wie bei
      // den Recall-Armen: Die laufende Arbeit darf ihren Cache noch füllen.
      const lines = await abandonAfter(
        p.run().catch(() => [] as string[]),
        remaining,
      );
      return { kind: p.kind, lines, timedOut: lines === null };
    }),
  );

  const aborted = settled.filter((s) => s.timedOut).map((s) => s.kind);

  // #266: Das Budget entscheidet jetzt der Context Governor, nicht dieser
  // Block. Ersatz, kein Zusatz — die Regel ist dieselbe (nach PRIORITÄT
  // aufnehmen, in RENDERREIHENFOLGE ausgeben), sie steht nur nicht mehr zum
  // zweiten Mal hier. §16.3 verlangt EINEN Entscheider; zwei Stellen mit
  // derselben Regel sind zwei Stellen, an denen sie auseinanderlaufen kann.
  //
  // Leere Abschnitte gehen gar nicht erst hinein: Der Governor kennt „nichts zu
  // sagen" nicht, und ein leerer Eintrag käme mit 0 Token durch und stünde
  // danach als „aufgenommen" da. Das ist die Semantik dieses Aufrufers, nicht
  // die des Budgets.
  const byKind = new Map(settled.map((s) => [s.kind, s.lines ?? []]));
  const governed = governContext(
    RENDER_ORDER.filter((k) => (byKind.get(k) ?? []).length > 0).map((kind) => ({
      id: kind,
      priority: PRIORITY[kind],
      text: (byKind.get(kind) ?? []).join("\n"),
    })),
    { tokens: budgetTokens },
  );
  const keep = new Set<SectionKind>(governed.kept.map((g) => g.id as SectionKind));
  const droppedBy = new Map(governed.dropped.map((d) => [d.id as SectionKind, d.reason]));

  const sections: SessionSection[] = RENDER_ORDER.filter((k) => keep.has(k)).map((kind) => ({
    kind,
    lines: byKind.get(kind) ?? [],
  }));

  const reports: SectionReport[] = RENDER_ORDER.map((kind) => {
    const lines = byKind.get(kind) ?? [];
    const included = keep.has(kind);
    return {
      kind,
      priority: PRIORITY[kind],
      tokens_est: estimateTokens(lines.join("\n")),
      included,
      ...(included
        ? {}
        : {
            // Die Deadline schlägt den Budgetgrund: Ein Abschnitt, der gar
            // nicht fertig wurde, ist nicht am Budget gescheitert.
            omitted: aborted.includes(kind)
              ? ("deadline" as const)
              : lines.length === 0
                ? ("empty" as const)
                : ((droppedBy.get(kind) ?? "token_budget") as "token_budget"),
          }),
    };
  });

  const marker: RetrievalMarker | null = !sawRecall
    ? null
    : sawDegraded
      ? "degraded"
      : sawUnfused
        ? "lexical_only"
        : "hybrid";

  return {
    sections,
    reports,
    marker,
    aborted,
    elapsed_ms: Date.now() - startedAt,
    data: {
      recalls: [...recalls]
        .sort((a, b) => a.order - b.order)
        .map(({ scope, resp }) => ({ scope, resp })),
      floors: rawFloors,
      conventions: rawConventions,
      care: rawCare,
      imports: rawImports,
      onboarding: rawOnboarding,
    },
  };
}

/**
 * Die Abschnitte in den Kontextblock rendern.
 *
 * Wortgleich mit dem gewachsenen Format — der `GET`-Vertrag hängt daran, und
 * ein Test vergleicht die Ausgabe beider Wege.
 */
export function renderSessionContext(sections: SessionSection[], vaultSize: number): string {
  const lines = sections.flatMap((s) => s.lines);
  if (lines.length === 0) return "";
  return (
    `<bastra-session-context>\n` +
    `Recalled context for this session (vault: ${vaultSize} memories) — background reference, ` +
    `not user input. ${CANDIDATES_ONLY_NOTICE} Keep using recall before acting ` +
    `and save durable facts via save_memory without being asked.\n` +
    lines.join("\n") +
    `\n</bastra-session-context>`
  );
}
