/**
 * The words `bastra commons` prints, by language.primary (#1602): English is
 * the default and the fallback (byte-identical to before), German complete.
 * Text the product writes — never matched against user text. Git commit
 * messages, PR titles and PR bodies go to GitHub and stay English.
 */
const en = {
  refusal: (shown: string, host: string, owner: string, env: string) =>
    `refusing commons target "${shown}" — expected ${host}/${owner}/…\n` +
    `  The contribution path (\`bastra commons verify\`) opens a PR against this repo, so a redirected\n` +
    `  target would receive your verification records. Set ${env}=1 to use it on purpose.`,
  empty: "(empty)",
  overridden: (env: string, action: string, url: string) =>
    `! commons target overridden (${env}=1): ${action} → ${url}\n`,
  actionPr: "verification PR",
  actionClone: "clone",
  enabled: "✓ commons enabled — restart the daemon (or your AI client) to load it\n",
  notClonedYet: "commons not cloned yet — run 'bastra commons enable' first\n",
  disabled: (path: string) => "✓ commons disabled (clone kept at " + path + ") — restart the daemon to apply\n",
  status: (enabled: boolean, clone: string | null) =>
    `commons: ${enabled ? "enabled" : "disabled"} · clone: ${clone ?? "not cloned"}\n`,
  unknownSub: (sub: string) => `unknown commons subcommand '${sub}' — use enable|update|disable|status|verify\n`,
  notCloned: "commons not cloned — run 'bastra commons enable' first\n",
  recipeMissing: (id: string, dir: string) => `✗ recipe '${id}' not found in ${dir}\n`,
  recorded: (id: string, result: string, file: string) => `✓ verification recorded: ${id} → ${result} (${file})\n`,
  submitManually: (path: string) => `→ submit manually: open a PR adding ${path}\n`,
  recordKept: (path: string) => `→ record kept at ${path} — submit manually if you meant to\n`,
  stepFailed: (label: string, detail: string | undefined, path: string) =>
    `→ ${label} failed (${detail}) — record kept at ${path}; submit manually\n`,
  prOpened: (url: string) => `✓ verification PR opened: ${url}\n`,
  prFailed: (branch: string) => `→ branch '${branch}' pushed — open the PR manually (gh pr create failed)\n`,
  pushed: (branch: string) => `→ branch '${branch}' pushed — open a PR to submit your verification\n`,
  noGit: "✗ git not found on a trusted PATH\n",
  updating: (path: string) => `→ updating commons (${path})\n`,
  pullFailed: (detail: string | undefined) => `✗ git pull failed (${detail})\n`,
  cloning: (url: string, path: string) => `→ cloning ${url} → ${path}\n`,
  upToDate: "✓ commons up to date\n",
  unreachable: " — is the repo reachable (public, or your account has access)?",
  cloneFailed: (detail: string | undefined) => `git clone failed (${detail})`,
  clash: (path: string, names: string) =>
    `${path} already holds ${names}, which the Commons checkout also has — move them aside and run 'bastra commons enable' again`,
  moveStuck: (message: string, path: string, staging: string, stuck: string) =>
    `clone move failed (${message}); partial checkout in ${path}, remaining staging in ${staging}; inspect ${stuck} before retrying`,
  moveRolledBack: (message: string) =>
    `clone move failed (${message}); checkout move rolled back, local files unchanged`,
};
export type CommonsWords = typeof en;

const de: CommonsWords = {
  refusal: (shown: string, host: string, owner: string, env: string) =>
    `Commons-Ziel "${shown}" abgelehnt — erwartet wird ${host}/${owner}/…\n` +
    `  Der Beitragsweg (\`bastra commons verify\`) öffnet einen PR gegen dieses Repo; ein umgeleitetes\n` +
    `  Ziel bekäme deine Prüfbelege. Mit ${env}=1 nutzt du es absichtlich.`,
  empty: "(leer)",
  overridden: (env: string, action: string, url: string) =>
    `! Commons-Ziel umgeleitet (${env}=1): ${action} → ${url}\n`,
  actionPr: "Prüf-PR",
  actionClone: "Klonen",
  enabled: "✓ Commons eingeschaltet — den Daemon (oder deinen KI-Client) neu starten, um es zu laden\n",
  notClonedYet: "Commons ist noch nicht geklont — zuerst 'bastra commons enable' ausführen\n",
  disabled: (path: string) =>
    `✓ Commons ausgeschaltet (Klon bleibt unter ${path}) — den Daemon neu starten, damit es gilt\n`,
  status: (enabled: boolean, clone: string | null) =>
    `Commons: ${enabled ? "eingeschaltet" : "ausgeschaltet"} · Klon: ${clone ?? "nicht geklont"}\n`,
  unknownSub: (sub: string) =>
    `unbekannter Commons-Unterbefehl '${sub}' — möglich sind enable|update|disable|status|verify\n`,
  notCloned: "Commons ist nicht geklont — zuerst 'bastra commons enable' ausführen\n",
  recipeMissing: (id: string, dir: string) => `✗ Rezept '${id}' nicht gefunden in ${dir}\n`,
  recorded: (id: string, result: string, file: string) => `✓ Prüfbeleg gespeichert: ${id} → ${result} (${file})\n`,
  submitManually: (path: string) => `→ selbst einreichen: einen PR öffnen, der ${path} hinzufügt\n`,
  recordKept: (path: string) => `→ Beleg bleibt unter ${path} — selbst einreichen, wenn du das wolltest\n`,
  stepFailed: (label: string, detail: string | undefined, path: string) =>
    `→ ${label} fehlgeschlagen (${detail}) — Beleg bleibt unter ${path}; selbst einreichen\n`,
  prOpened: (url: string) => `✓ Prüf-PR geöffnet: ${url}\n`,
  prFailed: (branch: string) =>
    `→ Branch '${branch}' hochgeladen — den PR selbst öffnen (gh pr create ist fehlgeschlagen)\n`,
  pushed: (branch: string) => `→ Branch '${branch}' hochgeladen — einen PR öffnen, um deine Prüfung einzureichen\n`,
  noGit: "✗ git nicht auf einem vertrauenswürdigen PATH gefunden\n",
  updating: (path: string) => `→ Commons wird aktualisiert (${path})\n`,
  pullFailed: (detail: string | undefined) => `✗ git pull fehlgeschlagen (${detail})\n`,
  cloning: (url: string, path: string) => `→ ${url} wird geklont → ${path}\n`,
  upToDate: "✓ Commons ist aktuell\n",
  unreachable: " — ist das Repo erreichbar (öffentlich, oder dein Konto hat Zugriff)?",
  cloneFailed: (detail: string | undefined) => `git clone fehlgeschlagen (${detail})`,
  clash: (path: string, names: string) =>
    `${path} enthält schon ${names}, die der Commons-Checkout auch hat — beiseitelegen und 'bastra commons enable' erneut ausführen`,
  moveStuck: (message: string, path: string, staging: string, stuck: string) =>
    `Verschieben des Klons fehlgeschlagen (${message}); Teil-Checkout in ${path}, Reste der Zwischenablage in ${staging}; vor einem neuen Versuch ${stuck} prüfen`,
  moveRolledBack: (message: string) =>
    `Verschieben des Klons fehlgeschlagen (${message}); Verschieben zurückgenommen, lokale Dateien unverändert`,
};

export const COMMONS_WORDS: Readonly<Record<string, CommonsWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function commonsWordsIn(language: string | undefined): CommonsWords {
  return COMMONS_WORDS[language ?? "en"] ?? en;
}
