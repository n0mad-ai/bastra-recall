/**
 * The words `bastra update` prints for a source checkout — whether its build
 * may be re-registered (source-build.ts, #528) and whether the running daemon
 * serves it afterwards (live-revision.ts) — by language.primary (#1602).
 * English is the default and the fallback, byte-identical to before; German
 * complete. Only the terminal reads these lines. Text the product writes —
 * never matched against user text.
 */

const en = {
  restartClients:
    "Restart any open AI clients (Claude Code, Claude Desktop, Codex, ChatGPT Desktop, Cursor) to pick up the new code.\n",
  // ─── the build in the checkout ───
  unknownRevision: "unknown",
  buildFirst: (rebuild: string) => `    Build it first, then re-run 'bastra update':\n      ${rebuild}\n`,
  current: (rev: string) => `  ✓ the build in this checkout was produced from HEAD ${rev}\n`,
  dirty: (rev: string) =>
    `  ✓ the build in this checkout was produced from HEAD ${rev} plus uncommitted changes\n` +
    `    That build is what will be re-registered — but it is not any commit,\n` +
    `    so this command will not claim a verified revision for it.\n`,
  unknown: "  ⚠ no workspace sources found here — the build could not be verified\n",
  unbuilt: (rev: string) => `  ✗ this checkout${rev} has no build output — nothing to re-register.\n`,
  staleTimes: (built: string, source: string) => ` (built ${built}, newest source ${source})`,
  stale: (rev: string, times: string) =>
    `  ✗ the build in this checkout${rev} is older than its sources` +
    `${times}.\n` +
    `    Re-registering now would pin every surface to the OLD code.\n`,
  unstamped: (rev: string) =>
    `  ✗ the build in this checkout${rev} does not say which revision it came from.\n` +
    `    Its timestamps look current, and a timestamp proves nothing: output copied\n` +
    `    from another checkout, or simply touched, looks exactly the same (#528).\n`,
  mismatch: (built: string, rev: string) =>
    `  ✗ the build in this checkout was produced from ${built}, not from HEAD ${rev}.\n` +
    `    Re-registering now would pin every surface to that OTHER revision.\n`,
  unverifiable: (built: string) =>
    `  ✗ git could not be asked for HEAD, so the built revision (${built}) cannot be checked.\n` +
    `    Put git on PATH and re-run 'bastra update'.\n`,
  // ─── the running daemon afterwards ───
  unknownBuild: "an unknown build",
  liveReport: (head: string) => `  ✓ the running daemon answers from HEAD ${head}\n\n`,
  /** The closings below end with `restartClients`, appended by describeLiveRevision. */
  liveClosing: (head: string) => `→ done — HEAD ${head} is live in the running daemon. `,
  noDaemonReport: "  · no daemon is answering — nothing is holding old code either\n\n",
  noDaemonClosing: (head: string) =>
    `→ done — HEAD ${head} is registered everywhere and goes live on the next daemon start.\n  `,
  otherReport: (running: string, head: string) =>
    `  ✗ the running daemon still answers from ${running}, not from HEAD ${head}\n\n`,
  otherClosing: (running: string, head: string, port: string) =>
    `→ registered, NOT live — the daemon in memory is ${running}, HEAD is ${head}.\n` +
    "  Restart it, then re-check with 'bastra status':\n" +
    `    lsof -i :${port}             # find the daemon pid\n` +
    "    kill <pid>                 # forwarder respawns it with the new code\n",
  unknownBuildReport: "  ? the running daemon does not report which revision it was built from\n\n",
  unknownBuildClosing: (head: string) =>
    `→ registered — HEAD ${head} is built here, but the running daemon cannot say which\n` +
    "  revision it serves (a daemon predating #528). Restart it to be sure.\n",
  unprovableClosing: "→ done — no revision is claimed: this checkout's build is not tied to a commit.\n  ",
};
export type SourceBuildWords = typeof en;

const de: SourceBuildWords = {
  restartClients:
    "Starte offene KI-Clients (Claude Code, Claude Desktop, Codex, ChatGPT Desktop, Cursor) neu, damit sie den neuen Code laden.\n",
  unknownRevision: "unbekannt",
  buildFirst: (rebuild) => `    Baue es zuerst und führe dann 'bastra update' erneut aus:\n      ${rebuild}\n`,
  current: (rev) => `  ✓ der Build in diesem Checkout stammt von HEAD ${rev}\n`,
  dirty: (rev) =>
    `  ✓ der Build in diesem Checkout stammt von HEAD ${rev} plus nicht committeten Änderungen\n` +
    `    Dieser Build wird neu eingetragen — er entspricht aber keinem Commit,\n` +
    `    deshalb nennt dieser Befehl dafür keine bestätigte Revision.\n`,
  unknown: "  ⚠ hier liegen keine Workspace-Quellen — der Build ließ sich nicht prüfen\n",
  unbuilt: (rev) => `  ✗ dieser Checkout${rev} hat keine Build-Ausgabe — nichts neu einzutragen.\n`,
  staleTimes: (built, source) => ` (gebaut ${built}, neueste Quelle ${source})`,
  stale: (rev, times) =>
    `  ✗ der Build in diesem Checkout${rev} ist älter als seine Quellen` +
    `${times}.\n` +
    `    Jetzt neu einzutragen würde jede Oberfläche auf den ALTEN Code festlegen.\n`,
  unstamped: (rev) =>
    `  ✗ der Build in diesem Checkout${rev} sagt nicht, aus welcher Revision er stammt.\n` +
    `    Seine Zeitstempel wirken aktuell, doch ein Zeitstempel beweist nichts: Ausgabe, die\n` +
    `    aus einem anderen Checkout kopiert oder nur angefasst wurde, sieht genauso aus (#528).\n`,
  mismatch: (built, rev) =>
    `  ✗ der Build in diesem Checkout stammt von ${built}, nicht von HEAD ${rev}.\n` +
    `    Jetzt neu einzutragen würde jede Oberfläche auf diese ANDERE Revision festlegen.\n`,
  unverifiable: (built) =>
    `  ✗ git ließ sich nicht nach HEAD fragen, deshalb kann die gebaute Revision (${built}) nicht geprüft werden.\n` +
    `    Mach git über PATH erreichbar und führe 'bastra update' erneut aus.\n`,
  unknownBuild: "ein unbekannter Build",
  liveReport: (head) => `  ✓ der laufende Daemon antwortet von HEAD ${head}\n\n`,
  liveClosing: (head) => `→ fertig — HEAD ${head} läuft im aktiven Daemon. `,
  noDaemonReport: "  · kein Daemon antwortet — es hält also auch niemand alten Code\n\n",
  noDaemonClosing: (head) =>
    `→ fertig — HEAD ${head} ist überall eingetragen und läuft ab dem nächsten Daemon-Start.\n  `,
  otherReport: (running, head) => `  ✗ der laufende Daemon antwortet noch von ${running}, nicht von HEAD ${head}\n\n`,
  otherClosing: (running, head, port) =>
    `→ eingetragen, aber NICHT aktiv — der Daemon im Speicher ist ${running}, HEAD ist ${head}.\n` +
    "  Starte ihn neu und prüfe dann mit 'bastra status':\n" +
    `    lsof -i :${port}             # Daemon-PID finden\n` +
    "    kill <pid>                 # der Forwarder startet ihn mit dem neuen Code neu\n",
  unknownBuildReport: "  ? der laufende Daemon meldet nicht, aus welcher Revision er gebaut wurde\n\n",
  unknownBuildClosing: (head) =>
    `→ eingetragen — HEAD ${head} ist hier gebaut, aber der laufende Daemon kann nicht sagen, welche\n` +
    "  Revision er ausliefert (ein Daemon älter als #528). Starte ihn zur Sicherheit neu.\n",
  unprovableClosing:
    "→ fertig — keine Revision wird behauptet: der Build dieses Checkouts gehört zu keinem Commit.\n  ",
};

export const SOURCE_BUILD_WORDS: Readonly<Record<string, SourceBuildWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function sourceBuildWordsIn(language: string | undefined): SourceBuildWords {
  return SOURCE_BUILD_WORDS[language ?? "en"] ?? en;
}
