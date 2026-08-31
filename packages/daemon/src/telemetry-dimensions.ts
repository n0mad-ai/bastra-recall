/**
 * Die Auswertungsdimensionen des Ereignisstroms (#263/#15, §17.4/§17.5, §21.1).
 *
 * §21.1 nennt als Releasevertrag: „Score-, Evidenz-, Abstention- und
 * No-answer-Telemetrie um `client`, `hook_source` und eine pseudonyme
 * `session_id` erweitern." §17.4 sagt, wofür: Die Hook-Load-Quote hängt nicht
 * allein am Ranking, also muss die Auswertung „getrennt nach Client,
 * Hook-Quelle und Query-Klasse" laufen. Ohne diese Spalten ist jede
 * Aufteilung eine Behauptung über einen Durchschnitt, der aus verschiedenen
 * Oberflächen zusammengerührt wurde.
 *
 * WARUM ALLOWLISTEN UND KEINE FREITEXTE. `client` und `hook_source` kommen von
 * außen — aus dem Body eines Loopback-Requests, den jeder lokale Prozess
 * absetzen kann. Ein durchgereichter String wäre ein Freitextfeld im
 * Telemetrie-Log, und §23 verlangt für die Experimentdimensionen ausdrücklich
 * Inhaltsfreiheit. Was nicht auf der Liste steht, wird `unknown` — nicht
 * abgelehnt, denn eine unbekannte Oberfläche ist eine Beobachtung, kein Fehler.
 *
 * WARUM DIE SESSION GEHASHT WIRD. §23: „Pseudonyme Experiment-Session-IDs
 * enthalten keinen Query- oder Vault-Inhalt." Die `session_id` im Hook-Payload
 * ist heute eine Claude-Session-UUID und damit harmlos — aber sie kommt vom
 * Aufrufer, und der Daemon kann nicht erzwingen, was dort steht. Der Hash macht
 * die Zusage strukturell statt vertrauensvoll: Was hier herauskommt, kann
 * keinen Inhalt tragen, egal was hineingeht. Die Zuordnung bleibt stabil, also
 * bleibt eine Session über alle ihre Ereignisse dieselbe Einheit.
 *
 * WAS HIER NICHT ENTSCHIEDEN WIRD. Die Experimentkonfiguration. §17.4 verlangt,
 * dass Mindest-N je Arm „nach dem M0-Baseline-Run festgelegt und gemeinsam mit
 * Zuweisungsfunktion und Experimentkonfiguration versioniert abgelegt" wird —
 * das ist eine Registrierung, kein Codewert. Solange keine hinterlegt ist,
 * trägt jedes Ereignis `unassigned`: die Spalte existiert, behauptet aber kein
 * laufendes Experiment. Die Zuweisungsfunktion steht hier, damit die
 * Registrierung sie später benennen kann.
 */
import { createHash } from "node:crypto";

/**
 * Welche Anwendung den Aufruf ausgelöst hat.
 *
 * `unknown` ist ein vollwertiger Wert und keine Lücke: Ein Aufruf ohne Angabe
 * ist eine Beobachtung über eine Oberfläche, die sich (noch) nicht ausweist.
 * Ihn als `null` zu führen hieße, ihn beim Gruppieren zu verlieren.
 */
export const TELEMETRY_CLIENTS = [
  "claude-code",
  "codex",
  "claude-desktop",
  "mac-app",
  "webui",
  "cli",
  "unknown",
] as const;
export type TelemetryClient = (typeof TELEMETRY_CLIENTS)[number];

/**
 * Welche Hook-Lane die Anfrage erzeugt hat — oder `mcp`, wenn es gar kein Hook
 * war.
 *
 * `mcp` steht bewusst in derselben Liste: Der MCP-Forwarder proxyt `recall`
 * über denselben `/hook/recall`-Endpunkt wie die Lanes. Ohne einen eigenen Wert
 * dafür wären MCP-Aufrufe von Hook-Aufrufen nicht trennbar, und genau diese
 * Trennung ist der Zweck der Spalte.
 */
export const HOOK_SOURCES = [
  "pre-tool",
  "prompt",
  "session",
  "stop",
  "bash-pre",
  "bash-fail",
  "todo",
  "mcp",
  // #265: der geteilte Session-Assembler. Kein Hook, aber eine eigene
  // Oberfläche — ohne eigenen Wert wären seine Recalls von denen des
  // Forwarders nicht zu trennen, und genau diese Trennung ist der Zweck.
  "session-context",
  "unknown",
] as const;
export type HookSource = (typeof HOOK_SOURCES)[number];

/** Die vier Spalten, die §17.5 an JEDES Nutzungssignal hängt. */
export interface TelemetryDimensions {
  client: TelemetryClient;
  hook_source: HookSource;
  /** Pseudonym der Session — gehasht, nie die rohe id. `null`, wenn der
   *  Aufrufer keine mitgeschickt hat. */
  experiment_session: string | null;
  /** `unassigned`, solange keine Experimentkonfiguration registriert ist. */
  arm: string;
}

/** Kein laufendes Experiment. */
export const UNASSIGNED_ARM = "unassigned";

const CLIENTS = new Set<string>(TELEMETRY_CLIENTS);
const SOURCES = new Set<string>(HOOK_SOURCES);

/** Einen gemeldeten Client auf die Allowlist zwingen. */
export function normalizeClient(raw: unknown): TelemetryClient {
  return typeof raw === "string" && CLIENTS.has(raw) ? (raw as TelemetryClient) : "unknown";
}

/** Dieselbe Behandlung für die Hook-Quelle. */
export function normalizeHookSource(raw: unknown): HookSource {
  return typeof raw === "string" && SOURCES.has(raw) ? (raw as HookSource) : "unknown";
}

/**
 * Das Session-Pseudonym: die ersten 16 Hex-Stellen eines SHA-256.
 *
 * 16 Stellen sind 64 Bit — bei der Zahl Sessions, die ein einzelner Vault je
 * sieht, ist eine Kollision kein praktisches Risiko, und die Spalte bleibt in
 * einem Log lesbar. Ungesalzen und damit über Läufe hinweg stabil: Eine
 * Session, die morgen wiederkommt, ist dieselbe Einheit. Umkehren ließe sich
 * das nur, wenn man die ursprüngliche id bereits kennt — und die ist eine UUID.
 */
export function pseudonymousSession(sessionId: string | null | undefined): string | null {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

/**
 * Die registrierte Experimentkonfiguration.
 *
 * `arms` sind die Armnamen in registrierter Reihenfolge; die Zuweisung geht
 * über das Session-Pseudonym, damit eine Session „für alle zugehörigen
 * Ereignisse im selben Arm" bleibt (§17.4).
 */
export interface ExperimentConfig {
  /** Name des Experiments — steht in der Registrierung, nicht im Code. */
  experiment: string;
  arms: string[];
}

/**
 * Deterministische Armzuweisung aus dem Session-Pseudonym.
 *
 * Ohne Konfiguration oder ohne Session gibt es keinen Arm: `unassigned`. Das
 * ist keine Notlösung, sondern der ehrliche Wert — ein Ereignis ohne Session
 * kann keiner Session-stabilen Zuweisung angehören, und ein Arm ohne
 * Experiment wäre eine erfundene Gruppe.
 *
 * Die Zahl kommt aus denselben Hex-Stellen, die schon das Pseudonym bilden:
 * gleichverteilt, weil ein Hash gleichverteilt ist, und ohne zweite
 * Hashrunde nachvollziehbar.
 */
export function assignArm(
  experimentSession: string | null,
  config: ExperimentConfig | null,
): string {
  if (!config || config.arms.length === 0 || experimentSession === null) return UNASSIGNED_ARM;
  // Die letzten 8 Hex-Stellen als Zahl — 32 Bit reichen für eine Aufteilung auf
  // eine Handvoll Arme, und `parseInt` bleibt exakt.
  const bucket = Number.parseInt(experimentSession.slice(-8), 16);
  if (!Number.isFinite(bucket)) return UNASSIGNED_ARM;
  return config.arms[bucket % config.arms.length];
}

/**
 * Die vier Spalten aus dem, was ein Aufrufer mitgeschickt hat.
 *
 * Eine Stelle, damit kein Produzent eine Spalte vergisst und keine zwei
 * Produzenten sie verschieden normalisieren. Was hier hineingeht, ist
 * ungeprüfte Fremdeingabe; was herauskommt, ist auf beiden Allowlisten und
 * inhaltsfrei.
 */
export function dimensionsFrom(
  input: { client?: unknown; hook_source?: unknown; session_id?: unknown },
  config: ExperimentConfig | null = null,
): TelemetryDimensions {
  const experimentSession = pseudonymousSession(
    typeof input.session_id === "string" ? input.session_id : null,
  );
  return {
    client: normalizeClient(input.client),
    hook_source: normalizeHookSource(input.hook_source),
    experiment_session: experimentSession,
    arm: assignArm(experimentSession, config),
  };
}
