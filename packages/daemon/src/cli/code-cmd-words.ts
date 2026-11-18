/**
 * The words `bastra code` and the install step's code-awareness question
 * print, by language.primary (#1602): English is the default and the fallback
 * (byte-identical to before), German complete. Text the product writes —
 * never matched against user text.
 */
const en = {
  unknownSub: (sub: string) => `unknown subcommand '${sub}' — try: status, enable, disable, index, rebuild\n`,
  pinned: (version: string | null, pin: string) => `  ✓ ${version} (pinned ${pin})\n`,
  path: (path: string) => `  path: ${path}\n`,
  unavailable: (reason: string) => `  ✗ unavailable: ${reason}\n`,
  ownGraphify: (path: string) => `  note: you have your own Graphify at ${path}`,
  ownGraphifyLeft: " — Recall leaves it alone and uses its own pinned copy\n",
  repositories: "\n→ repositories\n",
  noneEnabled: "  none enabled — run 'bastra code enable' inside a repository\n",
  noGraphYet: "    no graph yet — run 'bastra code index'\n",
  built: (at: string | null, stale: boolean) => `    built: ${at ?? "never"}${stale ? "  (may be outdated)" : ""}\n`,
  graphFiles: (version: string, count: number) => `    graphify ${version}, ${count} files`,
  lastError: (error: string) => `    last error: ${error}\n`,
  unfinished: "    a build did not finish — it will be retried\n",
  coverage: (status: string, collecting: boolean) =>
    `    ${status} (experimental${collecting ? "" : ", collection off: bastra config set coverageMap.enabled true"})\n`,
  enableUnavailable: (reason: string) => `✗ code awareness unavailable: ${reason}\n`,
  enableInstallHint: (pin: string) =>
    `  run 'bastra install' and say yes to code awareness, which installs graphifyy==${pin}\n`,
  enabled: (dir: string, changed: boolean) =>
    changed ? `✓ code awareness enabled for ${dir}\n` : `code awareness was already enabled for ${dir}\n`,
  experimental:
    "  experimental: it can help an agent find its way into an unfamiliar or large repository. " +
    'For "what breaks if I change this" it did not beat plain search in our measurements, and it costs ' +
    "context (the dependents block before edits) and background CPU (graph refreshes). " +
    "'bastra code disable' turns it off.\n",
  notEnabled: (dir: string) => `code awareness was not enabled for ${dir}\n`,
  disabled: (dir: string) => `✓ code awareness disabled for ${dir}\n`,
  graphKept: (path: string) => `  the graph is kept at ${path} — delete it yourself if you want it gone\n`,
  enableFirst: (dir: string) => `${dir} is not enabled — run 'bastra code enable' first\n`,
  confirmForce: "Rebuild with --force? This overrides Graphify's refusal to replace a larger graph with a smaller one.",
  cancelled: "cancelled — nothing was changed\n",
  building: (rebuild: boolean): string => (rebuild ? "rebuilding (forced)…\n" : "indexing…\n"),
  buildFailed: (secs: string, reason: string, detail: string) =>
    `✗ build failed after ${secs}s (${reason}): ${detail}\n`,
  previousUntouched: "  the previous graph is untouched\n",
  tookOverLock: "  note: took over a lock left by a daemon that died mid-build\n",
  indexed: (secs: string, size: string | null) => `✓ indexed in ${secs}s${size === null ? "" : ` (${size} MB)`}\n`,
  resumes: "  the daemon resumes automatic refreshes for this repository\n",
  excludeAdded: (entry: string, file: string) => `  added ${entry} to ${file}\n`,
  excludeFailed: (entry: string) => `  could not write the exclude file — add ${entry} to .gitignore yourself\n`,
  notInstalled: "Graphify is not installed for Recall",
  versionMismatch: (pin: string) => `the installed Graphify is not the pinned ${pin}`,
  unsupportedPlatform: "this platform is not supported yet (macOS and Linux only)",
  unreadable: "the Graphify binary did not report a version",
  alreadyInstalled: (version: string | null) => `→ code awareness: already installed (graphify ${version})\n`,
  offer: (pin: string) =>
    "Enable code awareness (experimental)? It uses Graphify to build a code map of a repository " +
    "and shows an agent what depends on a file before it edits one. It can help an agent find its way " +
    'into an unfamiliar or large repository; for "what breaks if I change this" it did not beat plain ' +
    "search in our measurements, and it costs context and background CPU. " +
    `This installs graphifyy==${pin} (Apache-2.0) into Recall's own tool directory. ` +
    "Nothing is indexed until you enable a repository, and no code is sent anywhere.",
  skipped: "→ code awareness: skipped — enable it later with 'bastra code enable'\n",
  needsUv: "→ code awareness: needs `uv` (https://docs.astral.sh/uv/) — install it, then run 'bastra code enable'\n",
  installing: (pin: string) => `→ code awareness: installing graphifyy==${pin}…\n`,
  installFailed: (detail: string | undefined) =>
    `  could not install it (${detail ?? "failed"}) — Recall works without it\n`,
  installed: "  ✓ installed — run 'bastra code enable' inside a repository to switch it on\n",
};
export type CodeCmdWords = typeof en;

const de: CodeCmdWords = {
  unknownSub: (sub: string) =>
    `unbekannter Unterbefehl '${sub}' — möglich sind: status, enable, disable, index, rebuild\n`,
  pinned: (version: string | null, pin: string) => `  ✓ ${version} (festgelegt auf ${pin})\n`,
  path: (path: string) => `  Pfad: ${path}\n`,
  unavailable: (reason: string) => `  ✗ nicht verfügbar: ${reason}\n`,
  ownGraphify: (path: string) => `  Hinweis: du hast ein eigenes Graphify unter ${path}`,
  ownGraphifyLeft: " — Recall lässt es unberührt und nutzt seine eigene festgelegte Kopie\n",
  repositories: "\n→ Repositories\n",
  noneEnabled: "  keines eingeschaltet — 'bastra code enable' in einem Repository ausführen\n",
  noGraphYet: "    noch kein Graph — 'bastra code index' ausführen\n",
  built: (at: string | null, stale: boolean) =>
    `    gebaut: ${at ?? "nie"}${stale ? "  (möglicherweise veraltet)" : ""}\n`,
  graphFiles: (version: string, count: number) => `    graphify ${version}, ${count} Dateien`,
  lastError: (error: string) => `    letzter Fehler: ${error}\n`,
  unfinished: "    ein Bau wurde nicht fertig — er wird wiederholt\n",
  coverage: (status: string, collecting: boolean) =>
    `    ${status} (experimentell${collecting ? "" : ", Erfassung aus: bastra config set coverageMap.enabled true"})\n`,
  enableUnavailable: (reason: string) => `✗ Code-Wissen nicht verfügbar: ${reason}\n`,
  enableInstallHint: (pin: string) =>
    `  'bastra install' ausführen und dem Code-Wissen zustimmen; das installiert graphifyy==${pin}\n`,
  enabled: (dir: string, changed: boolean) =>
    changed ? `✓ Code-Wissen eingeschaltet für ${dir}\n` : `Code-Wissen war für ${dir} schon eingeschaltet\n`,
  experimental:
    "  experimentell: es kann einem Agenten helfen, sich in einem fremden oder großen Repository zurechtzufinden. " +
    'Bei „was geht kaputt, wenn ich das ändere" war es in unseren Messungen nicht besser als einfache Suche, und es kostet ' +
    "Kontext (der Block mit den Abhängigen vor Änderungen) und Rechenzeit im Hintergrund (Graph-Aktualisierungen). " +
    "'bastra code disable' schaltet es aus.\n",
  notEnabled: (dir: string) => `Code-Wissen war für ${dir} nicht eingeschaltet\n`,
  disabled: (dir: string) => `✓ Code-Wissen ausgeschaltet für ${dir}\n`,
  graphKept: (path: string) => `  der Graph bleibt unter ${path} — lösch ihn selbst, wenn du ihn nicht mehr willst\n`,
  enableFirst: (dir: string) => `${dir} ist nicht eingeschaltet — zuerst 'bastra code enable' ausführen\n`,
  confirmForce:
    "Mit --force neu bauen? Das übergeht Graphifys Weigerung, einen größeren Graphen durch einen kleineren zu ersetzen.",
  cancelled: "abgebrochen — nichts wurde geändert\n",
  building: (rebuild: boolean): string => (rebuild ? "wird neu gebaut (erzwungen) …\n" : "wird indexiert …\n"),
  buildFailed: (secs: string, reason: string, detail: string) =>
    `✗ Bau nach ${secs} s fehlgeschlagen (${reason}): ${detail}\n`,
  previousUntouched: "  der bisherige Graph ist unverändert\n",
  tookOverLock: "  Hinweis: Sperre eines Daemons übernommen, der mitten im Bau beendet wurde\n",
  indexed: (secs: string, size: string | null) => `✓ indexiert in ${secs} s${size === null ? "" : ` (${size} MB)`}\n`,
  resumes: "  der Daemon nimmt die automatischen Aktualisierungen für dieses Repository wieder auf\n",
  excludeAdded: (entry: string, file: string) => `  ${entry} in ${file} eingetragen\n`,
  excludeFailed: (entry: string) =>
    `  die Ausschlussdatei ließ sich nicht schreiben — ${entry} selbst in .gitignore eintragen\n`,
  notInstalled: "Graphify ist für Recall nicht installiert",
  versionMismatch: (pin: string) => `das installierte Graphify ist nicht die festgelegte Version ${pin}`,
  unsupportedPlatform: "diese Plattform wird noch nicht unterstützt (nur macOS und Linux)",
  unreadable: "das Graphify-Programm hat keine Version gemeldet",
  alreadyInstalled: (version: string | null) => `→ Code-Wissen: bereits installiert (graphify ${version})\n`,
  offer: (pin: string) =>
    "Code-Wissen einschalten (experimentell)? Es baut mit Graphify eine Code-Karte eines Repositorys " +
    "und zeigt einem Agenten, was von einer Datei abhängt, bevor er sie ändert. Es kann einem Agenten helfen, sich " +
    'in einem fremden oder großen Repository zurechtzufinden; bei „was geht kaputt, wenn ich das ändere" war es in ' +
    "unseren Messungen nicht besser als einfache Suche, und es kostet Kontext und Rechenzeit im Hintergrund. " +
    `Das installiert graphifyy==${pin} (Apache-2.0) in Recalls eigenen Werkzeugordner. ` +
    "Nichts wird indexiert, bevor du ein Repository einschaltest, und kein Code wird irgendwohin gesendet.",
  skipped: "→ Code-Wissen: übersprungen — später einschalten mit 'bastra code enable'\n",
  needsUv:
    "→ Code-Wissen: braucht `uv` (https://docs.astral.sh/uv/) — installieren, dann 'bastra code enable' ausführen\n",
  installing: (pin: string) => `→ Code-Wissen: graphifyy==${pin} wird installiert …\n`,
  installFailed: (detail: string | undefined) =>
    `  ließ sich nicht installieren (${detail ?? "fehlgeschlagen"}) — Recall funktioniert auch ohne\n`,
  installed: "  ✓ installiert — 'bastra code enable' in einem Repository ausführen, um es einzuschalten\n",
};

export const CODE_CMD_WORDS: Readonly<Record<string, CodeCmdWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function codeCmdWordsIn(language: string | undefined): CodeCmdWords {
  return CODE_CMD_WORDS[language ?? "en"] ?? en;
}
