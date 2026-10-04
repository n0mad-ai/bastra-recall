/**
 * Eine stabile, datensparsame Kennung für DIESE Maschine (#493).
 *
 * WOZU. Tor 5 aus #492 fragt: „Wenn im Messfenster eine zweite Maschine
 * gemeldet hat, muss ihr Profil angesehen werden, bevor die Konstanten fallen
 * — der ganze Zweck der Selbstkalibrierung ist Hardware, die uns nicht
 * gehört." Zusammengeführte Logs konnten Hosts bis hierher überhaupt nicht
 * auseinanderhalten: Jede Zeile trug Session- und Boot-ids, und beide wechseln
 * auf DERSELBEN Maschine ständig. „Zwei Hosts" war von „zwei Daemon-Starts"
 * nicht zu unterscheiden.
 *
 * WAS NICHT DRIN STEHT. Kein Hostname, kein Nutzername, keine Seriennummer.
 * Was die Maschine beschreibt, geht in einen SHA-256 zusammen mit einem
 * zufälligen Salt, der lokal in `~/.bastra/host-profile.json` liegt und diese
 * Datei nie verlässt. Ohne den Salt lässt sich die Kennung weder zurückrechnen
 * noch gegen eine geratene Maschine prüfen — sie sagt nur „dieselbe wie in
 * Zeile X" oder „eine andere", und genau das braucht das Tor.
 *
 * WARUM ÜBERHAUPT EIN FINGERABDRUCK, wenn der Salt schon zufällig ist. Ein
 * reiner Zufallswert wäre genauso datensparsam, würde aber nach einem Umzug
 * des Vault-Verzeichnisses auf ein anderes Gerät stillschweigend behaupten, es
 * sei dieselbe Maschine. Der Fingerabdruck lässt die Kennung dann wechseln,
 * was die ehrlichere Aussage ist.
 *
 * Synchron gelesen und geschrieben, wie der Join-State-Snapshot (telemetry-join-state.ts):
 * Es passiert einmal pro Prozess, und der Wert wird an Stellen gebraucht, die
 * kein `await` mehr haben.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, homedir, hostname, platform, totalmem, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { envFirst, testRunHostProfilePath } from "./env.js";

const FILE_VERSION = 1;

interface HostProfileFile {
  version: number;
  /** Zufällig, lokal, verlässt diese Datei nie. */
  salt: string;
}

export function hostProfilePath(): string {
  // BASTRA_HOST_PROFILE_PATH is a test seam, not a user setting. It always
  // names the FILE, and setting it moves the salt — so the host id changes.
  return (
    envFirst("BASTRA_HOST_PROFILE_PATH") ?? testRunHostProfilePath() ?? join(homedir(), ".bastra", "host-profile.json")
  );
}

/**
 * Was die Maschine ausmacht. Nichts davon wird gespeichert oder gemeldet — es
 * geht ausschließlich gesalzen und gehasht nach draußen.
 */
function fingerprint(): string {
  const cpu = cpus()[0]?.model ?? "";
  return [hostname(), userInfo().username, platform(), arch(), cpu, String(totalmem())].join("\0");
}

function readOrCreateSalt(path: string): string {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<HostProfileFile>;
    if (parsed.version === FILE_VERSION && typeof parsed.salt === "string" && parsed.salt.length >= 32) {
      return parsed.salt;
    }
  } catch {
    // Fehlt oder ist kaputt — dann wird sie gleich neu geschrieben.
  }
  const salt = randomBytes(32).toString("hex");
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const file: HostProfileFile = { version: FILE_VERSION, salt };
    writeFileSync(path, JSON.stringify(file) + "\n", { encoding: "utf8", mode: 0o600 });
  } catch {
    // Nicht schreibbar: Die Kennung gilt dann nur für diesen Prozesslauf. Das
    // ist schlechter als eine stabile, aber besser als gar keine — und es ist
    // kein Grund, den Daemon nicht zu starten.
  }
  return salt;
}

/**
 * Die Kennung für einen bestimmten Ablageort. Injizierbar, damit der Test
 * hermetisch bleibt (Stabilität über zwei Aufrufe, Verschiedenheit über zwei
 * Salts) statt am echten Home zu hängen.
 */
export function computeHostProfileId(path: string, fp: string = fingerprint()): string {
  const salt = readOrCreateSalt(path);
  // 16 Hexzeichen = 64 Bit. Genug, dass zwei Maschinen nicht kollidieren, und
  // kurz genug, dass die Kennung in jeder Telemetriezeile stehen kann.
  return createHash("sha256").update(salt).update("\0").update(fp).digest("hex").slice(0, 16);
}

let cached: string | null = null;

/** Die Kennung dieses Hosts. Einmal pro Prozess berechnet. */
export function hostProfileId(): string {
  if (cached === null) cached = computeHostProfileId(hostProfilePath());
  return cached;
}
