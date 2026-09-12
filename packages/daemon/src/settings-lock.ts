/**
 * Serialisierung der Settings-Mutationen (#534).
 *
 * Jeder Setter in settings.ts ist ein Read-Modify-Write: lesen, EIN Feld
 * ändern, den kompletten Schnappschuss per tmp+rename veröffentlichen. Das
 * Rename verhindert eine halb geschriebene Datei — es serialisiert die
 * Transaktion aber nicht. Gemessen auf a4c0896: `Promise.all([setUpdateMode,
 * setDocsMode])` verlor in 20 von 20 Läufen ein Feld, zwei getrennte Prozesse
 * in 10 von 10 Runden. Beide Aufrufe meldeten Erfolg.
 *
 * Zwei Ebenen, weil es zwei Rennen gibt:
 *
 *   1. IM PROZESS: eine Promise-Kette pro Pfad — dasselbe Mittel, das die
 *      Floor-Registry seit #240/A9 benutzt (floors.ts, withRegistryLock).
 *      Node bedient überlappende HTTP-Anfragen nebenläufig, also reicht das
 *      gegen den häufigsten Fall (eine Oberfläche schreibt mehrere Felder).
 *   2. ZWISCHEN PROZESSEN: CLI, Onboarding-Assistent und Daemon sind eigene
 *      Prozesse und teilen sich dieselbe Datei, deshalb reicht die Kette hier
 *      nicht. Ein Lock-File neben der Settings-Datei, angelegt mit O_EXCL
 *      ("wx") — dasselbe Muster wie der Commit-Claim in core/save-commit.ts.
 *
 * ZUSAGE NACH AUSSEN (die von #534 verlangte Entscheidung): Mutationen
 * derselben Settings-Datei sind vollständig serialisiert, im Prozess
 * garantiert, prozessübergreifend solange alle Schreiber dieselbe lokale
 * Datei sehen. Ein verwaistes Lock-File (Prozess gestorben) wird nach
 * {@link LOCK_STALE_MS} übernommen; wer {@link LOCK_WAIT_MS} lang nicht
 * drankommt, schreibt OHNE prozessübergreifendes Lock weiter und sagt es auf
 * stderr. Das ist bewusst fail-open: der schlechteste Fall ist genau das
 * Verhalten von vorher, und eine Einstellung, die sich nicht mehr speichern
 * lässt, wäre der teurere Fehler.
 *
 * NICHT abgedeckt: ein Vault auf einem Netzlaufwerk, auf dem O_EXCL nicht
 * atomar ist. Dafür bräuchte es eine Lease mit Heartbeat, die diese Datei
 * nicht wert ist.
 */

import { mkdir, open, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Ab wann ein liegengebliebenes Lock als verwaist gilt und übernommen wird. */
const LOCK_STALE_MS = 10_000;
/** Wie lange ein Schreiber auf das Lock wartet, bevor er fail-open weitermacht. */
const LOCK_WAIT_MS = 5_000;

const chains = new Map<string, Promise<unknown>>();

/** Promise-Kette pro Pfad — wortgleich zu floors.ts/withRegistryLock (#240/A9). */
function withChain<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(path) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Kette am Leben halten, aber eine Ablehnung nie an den nächsten Wartenden weitergeben.
  chains.set(
    path,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export function settingsLockPath(path: string): string {
  return `${path}.lock`;
}

async function acquireFileLock(path: string): Promise<boolean> {
  const lockPath = settingsLockPath(path);
  const body = JSON.stringify({ pid: process.pid, host: hostnameSafe(), ts: Date.now() });
  const deadline = Date.now() + LOCK_WAIT_MS;
  // Das Lock liegt neben der Settings-Datei; beim allerersten Schreiben gibt
  // es ~/.bastra noch gar nicht (writeSettings legt es sonst selbst an).
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => undefined);
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(body, "utf8");
      } finally {
        await handle.close();
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
        // Kein schreibbares Verzeichnis o.ä. — dann eben ohne Lock, wie bisher.
        process.stderr.write(
          `[bastra-recall] cannot create settings lock ${lockPath} (${(err as Error).message}) — writing unserialized\n`,
        );
        return false;
      }
    }
    // Verwaist? Alter ist hier das einzige Indiz, das ohne Zusatzzustand
    // auskommt; der Verlierer eines Übernahme-Rennens landet im Verhalten von
    // vorher, nicht in etwas Schlimmerem.
    try {
      const st = await stat(lockPath);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
    } catch {
      continue; // Lock ist zwischendurch verschwunden — sofort neu versuchen.
    }
    if (Date.now() >= deadline) {
      process.stderr.write(
        `[bastra-recall] settings lock ${lockPath} busy for ${LOCK_WAIT_MS}ms — writing unserialized\n`,
      );
      return false;
    }
    await delay(5 + Math.floor(Math.random() * 10));
  }
}

function hostnameSafe(): string {
  try {
    return hostname();
  } catch {
    return "unknown";
  }
}

/**
 * Führt `fn` als einzige laufende Mutation dieser Settings-Datei aus — im
 * Prozess und, solange das Lock-File trägt, auch prozessübergreifend.
 */
export function withSettingsLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  return withChain(path, async () => {
    const held = await acquireFileLock(path);
    try {
      return await fn();
    } finally {
      if (held) await unlink(settingsLockPath(path)).catch(() => undefined);
    }
  });
}
