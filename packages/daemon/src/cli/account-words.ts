/**
 * The words `bastra account` and `bastra ui remote` print for people, by
 * language.primary (#1198, #1602): English is the default and the fallback,
 * German complete. Text the product writes — never matched against user text.
 * Nothing here ever receives a password.
 */
import { taskCliLanguage } from "./task-cli-words.js";

const en = {
  noTerminal: (cmd: string) =>
    `error: 'bastra ${cmd}' asks for a password and needs an interactive terminal. Run it in a terminal window; the password is never taken from arguments, environment or pipes.\n`,
  cancelled: "cancelled — nothing was changed.\n",
  accountExists:
    "error: an account already exists — 'bastra account setup' never overwrites it. To set a new password: 'bastra account reset-password'.\n",
  accountDamaged:
    "error: the account record is damaged and the web UI stays locked. Repair it with 'bastra account reset-password'.\n",
  noAccount: "error: there is no account yet — create it with 'bastra account setup'.\n",
  usernamePrompt: "User name: ",
  passwordPrompt: "Password (hidden): ",
  passwordAgain: "Password again (hidden): ",
  passwordNew: "New password (hidden): ",
  usernameProblem: (problem: string) => {
    const text: Record<string, string> = {
      "username-empty": "the user name is empty",
      "username-too-long": "the user name is too long (at most 64 characters)",
      "username-invalid": "the user name must not contain control characters or start or end with white space",
    };
    return `error: ${text[problem] ?? "the user name is not valid"}.\n`;
  },
  passwordProblem: (problem: string) => {
    const text: Record<string, string> = {
      "too-short": "the password is too short (at least 15 characters)",
      "too-long": "the password is too long (at most 1024 bytes)",
      "not-text": "the password is not valid text",
    };
    return `error: ${text[problem] ?? "the password is not valid"}.\n`;
  },
  mismatch: "error: the two entries differ — nothing was changed.\n",
  failed: (cmd: string) => `error: 'bastra ${cmd}' failed — nothing was changed. Is the database in use or damaged?\n`,
  created: (name: string) =>
    `account '${name}' created. Sign in at the web UI (bastra map). Remote access stays off until 'bastra ui remote on <https-address>'.\n`,
  passwordSet: (ended: number) =>
    `password set; ${ended} session(s) ended — every browser and device has to sign in again.\n`,
  statusAccount: (state: string, name: string | null) =>
    state === "present"
      ? `account:        present (user name: ${name})\n`
      : state === "none"
        ? "account:        none — create it with 'bastra account setup'\n"
        : "account:        DAMAGED — the web UI stays locked; repair with 'bastra account reset-password'\n",
  statusSessions: (total: number, local: number, pub: number) =>
    `sessions:       ${total} active (local ${local}, public ${pub})\n`,
  statusLocks: (locks: string[]) =>
    locks.length === 0
      ? "locks:          none\n"
      : `locks:          ${locks.length} active\n${locks.map((l) => `  ${l}\n`).join("")}`,
  lockLine: (bucket: string, until: string, failures: number) =>
    `${bucket} locked until ${until} (${failures} failed attempt(s) counted)`,
  statusCounters: (n: number) => `failed-attempt counters: ${n}\n`,
  statusRemoteOn: (origin: string) => `remote access:  on — ${origin}\n`,
  statusRemoteOff: "remote access:  off\n",
  devicesNone: "no active sessions.\n",
  devicesHeader:
    "handle                                kind     origin  last active           expires               name\n",
  deviceKind: (kind: string): string => (kind === "device" ? "device" : "browser"),
  revokeNeedsId: "error: 'bastra account revoke' needs a handle (see 'bastra account devices').\n",
  revokeNone: (id: string) => `error: no active session with handle '${id}'.\n`,
  revokeAmbiguous: (id: string) => `error: '${id}' matches several sessions — use more characters of the handle.\n`,
  revoked: (id: string) => `session ${id} ended.\n`,
  loggedOutAll: (n: number) => `${n} session(s) ended.\n`,
  unlocked: (n: number) => `locks and failed-attempt counters cleared (${n} entr${n === 1 ? "y" : "ies"}).\n`,
  unknownSub: (sub: string) =>
    `error: unknown 'account' subcommand '${sub}' — use setup, status, reset-password, devices, revoke <handle>, logout-all or unlock\n`,
  remoteUnknownSub: (sub: string) =>
    `error: unknown 'ui' subcommand '${sub}' — use 'bastra ui' (open the map) or 'bastra ui remote <on <https-address>|off|status>'\n`,
  remoteNeedsOrigin:
    "error: 'bastra ui remote on' needs the public address, e.g. 'bastra ui remote on https://recall.example.com'.\n",
  remoteBadOrigin: (value: string) =>
    `error: '${value}' is not a usable address — only https:// with a host and no path, user name, query or fragment (e.g. https://recall.example.com).\n`,
  remoteOn: (origin: string, hasAccount: boolean) =>
    `remote access on: ${origin}\n` +
    "  The tunnel must let '/ui' through (e.g. ingress path ^/ui(/|$)); nothing else is opened.\n" +
    (hasAccount
      ? "  Sign-in with the account is the only protection from outside.\n"
      : "  There is no account yet, so nobody can get in from outside. Create one with 'bastra account setup'.\n") +
    "  Takes effect at once, no restart. Switch off again: 'bastra ui remote off'.\n",
  remoteOff: (ended: number) => `remote access off. ${ended} public session(s) ended; takes effect at once.\n`,
};
export type AccountWords = typeof en;

const de: AccountWords = {
  noTerminal: (cmd) =>
    `Fehler: 'bastra ${cmd}' fragt ein Passwort ab und braucht ein interaktives Terminal. Starte den Befehl in einem Terminalfenster; das Passwort wird nie aus Argumenten, Umgebung oder Pipes gelesen.\n`,
  cancelled: "abgebrochen — nichts wurde geändert.\n",
  accountExists:
    "Fehler: es gibt schon ein Konto — 'bastra account setup' überschreibt es nie. Für ein neues Passwort: 'bastra account reset-password'.\n",
  accountDamaged:
    "Fehler: die Kontoablage ist beschädigt, die Web-Oberfläche bleibt gesperrt. Reparatur mit 'bastra account reset-password'.\n",
  noAccount: "Fehler: es gibt noch kein Konto — lege es mit 'bastra account setup' an.\n",
  usernamePrompt: "Nutzername: ",
  passwordPrompt: "Passwort (verdeckt): ",
  passwordAgain: "Passwort wiederholen (verdeckt): ",
  passwordNew: "Neues Passwort (verdeckt): ",
  usernameProblem: (problem) => {
    const text: Record<string, string> = {
      "username-empty": "der Nutzername ist leer",
      "username-too-long": "der Nutzername ist zu lang (höchstens 64 Zeichen)",
      "username-invalid":
        "der Nutzername darf keine Steuerzeichen enthalten und nicht mit Leerraum beginnen oder enden",
    };
    return `Fehler: ${text[problem] ?? "der Nutzername ist ungültig"}.\n`;
  },
  passwordProblem: (problem) => {
    const text: Record<string, string> = {
      "too-short": "das Passwort ist zu kurz (mindestens 15 Zeichen)",
      "too-long": "das Passwort ist zu lang (höchstens 1024 Byte)",
      "not-text": "das Passwort ist kein gültiger Text",
    };
    return `Fehler: ${text[problem] ?? "das Passwort ist ungültig"}.\n`;
  },
  mismatch: "Fehler: die beiden Eingaben unterscheiden sich — nichts wurde geändert.\n",
  failed: (cmd) =>
    `Fehler: 'bastra ${cmd}' ist fehlgeschlagen — nichts wurde geändert. Ist die Datenbank belegt oder beschädigt?\n`,
  created: (name) =>
    `Konto '${name}' angelegt. Melde dich an der Web-Oberfläche an (bastra map). Der Fernzugriff bleibt aus, bis 'bastra ui remote on <https-adresse>' gesetzt ist.\n`,
  passwordSet: (ended) =>
    `Passwort gesetzt; ${ended} Sitzung(en) beendet — jeder Browser und jedes Gerät muss sich neu anmelden.\n`,
  statusAccount: (state, name) =>
    state === "present"
      ? `Konto:          vorhanden (Nutzername: ${name})\n`
      : state === "none"
        ? "Konto:          keines — lege es mit 'bastra account setup' an\n"
        : "Konto:          BESCHÄDIGT — die Web-Oberfläche bleibt gesperrt; Reparatur mit 'bastra account reset-password'\n",
  statusSessions: (total, local, pub) => `Sitzungen:      ${total} aktiv (lokal ${local}, öffentlich ${pub})\n`,
  statusLocks: (locks) =>
    locks.length === 0
      ? "Sperren:        keine\n"
      : `Sperren:        ${locks.length} aktiv\n${locks.map((l) => `  ${l}\n`).join("")}`,
  lockLine: (bucket, until, failures) => `${bucket} gesperrt bis ${until} (${failures} Fehlversuch(e) gezählt)`,
  statusCounters: (n) => `Fehlversuch-Zähler: ${n}\n`,
  statusRemoteOn: (origin) => `Fernzugriff:    an — ${origin}\n`,
  statusRemoteOff: "Fernzugriff:    aus\n",
  devicesNone: "keine aktiven Sitzungen.\n",
  devicesHeader:
    "Griff                                 Art      Herkunft  zuletzt aktiv         läuft ab              Name\n",
  deviceKind: (kind) => (kind === "device" ? "Gerät" : "Browser"),
  revokeNeedsId: "Fehler: 'bastra account revoke' braucht einen Griff (siehe 'bastra account devices').\n",
  revokeNone: (id) => `Fehler: keine aktive Sitzung mit dem Griff '${id}'.\n`,
  revokeAmbiguous: (id) => `Fehler: '${id}' passt auf mehrere Sitzungen — gib mehr Zeichen des Griffs an.\n`,
  revoked: (id) => `Sitzung ${id} beendet.\n`,
  loggedOutAll: (n) => `${n} Sitzung(en) beendet.\n`,
  unlocked: (n) => `Sperren und Fehlversuch-Zähler gelöscht (${n} Eintrag/Einträge).\n`,
  unknownSub: (sub) =>
    `Fehler: unbekannter 'account'-Unterbefehl '${sub}' — setup, status, reset-password, devices, revoke <griff>, logout-all oder unlock verwenden\n`,
  remoteUnknownSub: (sub) =>
    `Fehler: unbekannter 'ui'-Unterbefehl '${sub}' — 'bastra ui' (Karte öffnen) oder 'bastra ui remote <on <https-adresse>|off|status>' verwenden\n`,
  remoteNeedsOrigin:
    "Fehler: 'bastra ui remote on' braucht die öffentliche Adresse, z. B. 'bastra ui remote on https://recall.example.com'.\n",
  remoteBadOrigin: (value) =>
    `Fehler: '${value}' ist keine brauchbare Adresse — nur https:// mit Host und ohne Pfad, Nutzername, Query oder Fragment (z. B. https://recall.example.com).\n`,
  remoteOn: (origin, hasAccount) =>
    `Fernzugriff an: ${origin}\n` +
    "  Der Tunnel muss '/ui' durchlassen (z. B. Ingress-Pfad ^/ui(/|$)); sonst wird nichts geöffnet.\n" +
    (hasAccount
      ? "  Von außen schützt allein die Anmeldung mit dem Konto.\n"
      : "  Es gibt noch kein Konto, daher kommt niemand von außen hinein. Lege eines mit 'bastra account setup' an.\n") +
    "  Wirkt sofort, ohne Neustart. Wieder ausschalten: 'bastra ui remote off'.\n",
  remoteOff: (ended) => `Fernzugriff aus. ${ended} öffentliche Sitzung(en) beendet; wirkt sofort.\n`,
};

export const ACCOUNT_WORDS: Readonly<Record<string, AccountWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function accountWordsIn(language: string | undefined): AccountWords {
  return ACCOUNT_WORDS[language ?? "en"] ?? en;
}
/** The words in language.primary, read once per command (English when unset or unreadable). */
export async function accountWords(): Promise<AccountWords> {
  return accountWordsIn(await taskCliLanguage().catch(() => "en"));
}
