/**
 * Die Mindest-N-Prüfung der Armauswertung (#437, §18.1/§17.4).
 *
 * WARUM ES DIESE DATEI GIBT. Der Report druckte für jeden Arm numerische
 * Surfaced-/Loaded-/Acted-on-Quoten, sobald überhaupt Zeilen vorlagen. §26.1
 * verlangt aber wörtlich, dass die Auswertung des Retrieval-/
 * Präsentationsexperiments „einen Arm unterhalb des Mindest-N ausdrücklich als
 * **nicht auswertbar** ausweist statt als Nullbefund", und die committete
 * Registrierung trägt dieselbe Regel als `underpowered_fallback.conclusion.
 * reporting_rule`. Eine Quote unter dem Mindest-N ist keine schwache Aussage,
 * sondern gar keine — sie sieht nur aus wie eine.
 *
 * WAS DIE VERSUCHSEINHEIT IST. Die Session, nicht das Ereignis (§17.4: „Die
 * Arm-Zuweisung erfolgt deterministisch pro pseudonymer Session-ID. Eine
 * Session verbleibt für alle zugehörigen Ereignisse im selben Arm."). Deshalb
 * zählt hier `experiment_session` und nicht die Zahl der Ausspielungen — eine
 * Rechnung über Ereignisse ignorierte die Clusterung und käme auf ein
 * Vielfaches der tatsächlichen Fallzahl.
 *
 * WOHER DIE ZAHL KOMMT. Aus der Registrierung, auf die die Zeilen seit #439
 * selbst verweisen — nicht aus dem Code. Eine im Code hinterlegte Zahl wäre
 * genau der nicht versionierte Wert, den §17.4 ausschließt. Fehlt der Verweis,
 * ist die Registrierung nicht lesbar oder trägt sie kein `min_n_per_arm`, dann
 * ist die Antwort nicht „dann eben ohne Prüfung", sondern NICHT AUSWERTBAR:
 * Ein Mindest-N, das niemand nachschlagen kann, ist keines.
 *
 * Bis auf `loadMinNRule` reine Funktionen, damit die Regel prüfbar ist, ohne
 * einen Report zu drucken.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Kein laufendes Experiment — derselbe Wert wie in telemetry-dimensions.ts. */
export const UNASSIGNED_ARM = "unassigned";

/** Die Identität, unter der eine Zeile ihrem Arm zugewiesen wurde (#439). */
export interface ArmIdentity {
  experiment: string;
  registration: string;
  registration_version: number;
}

/**
 * Die Dimensionsspalten einer geladenen Zeile, oder `null`.
 *
 * Die Eingabe ist bewusst `unknown`: Die Zeilen kommen aus einer JSONL-Datei,
 * sind also Fremdeingabe, und Zeilen vor #263 tragen die Spalten gar nicht.
 * Die Prüfung steht deshalb einmal hier statt an jeder Auswertungsstelle.
 */
function dimensionsOf(event: unknown): Record<string, unknown> | null {
  const dims = (event as { dimensions?: unknown } | null)?.dimensions;
  return typeof dims === "object" && dims !== null ? (dims as Record<string, unknown>) : null;
}

/**
 * Die Mindest-N-Regel, wie sie in der Registrierung steht.
 *
 * `minN === null` heißt NICHT „keine Regel", sondern: Die Registrierung hat
 * bewusst keine Zahl festgelegt und trägt stattdessen ihren gemessenen
 * Underpowered-Fallback — der Validator in `packages/eval/src/registrations.ts`
 * lässt eine fehlende Zahl nur MIT dieser Messung durchgehen. Für den Report
 * ist beides derselbe Schluss: kein erreichtes Mindest-N, also kein Ergebnis.
 */
export interface MinNRule {
  minN: number | null;
  /** §18.1-Berichtsregel im Wortlaut der Registrierung, wenn sie eine trägt. */
  reportingRule: string | null;
  /** `underpowered_fallback.conclusion.verdict`, wenn vorhanden. */
  fallbackVerdict: string | null;
}

/** Die Regel aus einer geparsten Registrierung ziehen. */
export function minNRuleFrom(registration: unknown): MinNRule {
  const reg = (registration ?? {}) as Record<string, unknown>;
  const raw = reg.min_n_per_arm;
  const minN = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
  const fb = (reg.underpowered_fallback ?? {}) as Record<string, unknown>;
  const conclusion = (fb.conclusion ?? {}) as Record<string, unknown>;
  return {
    minN,
    reportingRule:
      typeof conclusion.reporting_rule === "string" ? conclusion.reporting_rule : null,
    fallbackVerdict: typeof conclusion.verdict === "string" ? conclusion.verdict : null,
  };
}

/**
 * Die Registrierung von der Platte holen und ihre Regel ziehen.
 *
 * `roots` sind die Verzeichnisse, gegen die ein relativer Verweis aufgelöst
 * wird — der Verweis in der Konfiguration ist repo-relativ, der Report läuft
 * aber nicht zwingend im Repo-Wurzelverzeichnis. Ein Fehler wird
 * ZURÜCKGEGEBEN, nicht geworfen: Eine unlesbare Registrierung darf den Report
 * nicht abbrechen, aber sie darf auch nicht zu einer stillen Quote führen.
 */
export function loadMinNRule(
  registration: string,
  roots: string[],
): { rule: MinNRule | null; error: string | null } {
  const candidates = isAbsolute(registration)
    ? [registration]
    : roots.map((r) => resolve(r, registration));
  for (const p of candidates) {
    try {
      return { rule: minNRuleFrom(JSON.parse(readFileSync(p, "utf8"))), error: null };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { rule: null, error: `the registration at ${p} could not be read (${(e as Error).message})` };
    }
  }
  return {
    rule: null,
    error: `the registration ${registration} was not found (looked in ${roots.join(", ")})`,
  };
}

/** Die Registrierungsidentitäten, die auf den Zeilen stehen (#439). */
export function armIdentities(events: readonly unknown[]): ArmIdentity[] {
  const seen = new Map<string, ArmIdentity>();
  for (const e of events) {
    const d = dimensionsOf(e);
    if (!d) continue;
    if (
      typeof d.experiment !== "string" ||
      typeof d.registration !== "string" ||
      typeof d.registration_version !== "number"
    ) {
      continue;
    }
    const id: ArmIdentity = {
      experiment: d.experiment,
      registration: d.registration,
      registration_version: d.registration_version,
    };
    seen.set(JSON.stringify([id.experiment, id.registration, id.registration_version]), id);
  }
  return [...seen.values()];
}

/**
 * Versuchseinheiten je Arm: DISTINKTE Sessions, nicht Ereignisse.
 *
 * Zeilen ohne Session-Pseudonym zählen nicht mit — sie können keiner
 * session-stabilen Zuweisung angehören und wären eine erfundene Einheit.
 */
export function sessionsPerArm(events: readonly unknown[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of events) {
    const d = dimensionsOf(e);
    if (!d || typeof d.arm !== "string") continue;
    if (typeof d.experiment_session !== "string" || d.experiment_session.length === 0) continue;
    let set = out.get(d.arm);
    if (!set) out.set(d.arm, (set = new Set<string>()));
    set.add(d.experiment_session);
  }
  return out;
}

/** Das Urteil über einen Arm. */
export interface ArmEvaluation {
  /** Erreichte Versuchseinheiten (Sessions). */
  sessions: number;
  /** Das geprüfte Mindest-N, oder `null`, wenn keines feststellbar war. */
  minN: number | null;
  /** Nur `true`, wenn ein Mindest-N feststand UND erreicht ist. */
  evaluable: boolean;
  /** Warum nicht — leer, wenn auswertbar. */
  why: string;
}

/**
 * Das Urteil für alle Arme eines Reports.
 *
 * `registration` ist die geparste Registrierung oder `null`, wenn sie nicht
 * gelesen werden konnte; `registrationError` sagt dann, warum. Beides kommt vom
 * Aufrufer, damit diese Funktion kein Dateisystem braucht.
 */
export function evaluateArms(
  events: readonly unknown[],
  rule: MinNRule | null,
  registrationError: string | null,
): Map<string, ArmEvaluation> {
  const identities = armIdentities(events);
  const sessions = sessionsPerArm(events);
  const out = new Map<string, ArmEvaluation>();

  for (const [arm, set] of sessions) {
    if (arm === UNASSIGNED_ARM) continue; // kein Arm, also auch kein Armurteil
    const n = set.size;
    let why = "";
    if (identities.length === 0) {
      why = "the rows carry no registration identity — the min-N rule cannot be looked up (#439)";
    } else if (identities.length > 1) {
      // Zwei Registrierungen sind zwei Experimente. Sie in einem Arm zu
      // addieren wäre genau die Konfundierung, die der Verweis verhindern soll.
      why = `rows from ${identities.length} different registrations cannot be pooled into one arm`;
    } else if (registrationError) {
      why = registrationError;
    } else if (!rule || rule.minN === null) {
      why =
        "the registration fixes no min_n_per_arm — its registered underpowered fallback stands" +
        (rule?.fallbackVerdict ? ` (${rule.fallbackVerdict})` : "");
    } else if (n < rule.minN) {
      why = `${n} session(s) of the registered min-N ${rule.minN}`;
    }
    out.set(arm, { sessions: n, minN: rule?.minN ?? null, evaluable: why === "", why });
  }
  return out;
}
