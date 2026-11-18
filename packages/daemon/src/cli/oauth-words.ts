/**
 * The words `bastra oauth` prints for people, by language.primary (#1602):
 * English is the default and the fallback (byte-identical to before), German
 * complete. `--json` stays as it is. Text the product writes — never matched
 * against user text.
 */
import { taskCliLanguage } from "./task-cli-words.js";

const en = {
  none: "no OAuth clients registered.\n",
  redirect: (hosts: string) => `  redirect: ${hosts}\n`,
  registered: (at: string, grants: number) => `  registered ${at}, ${grants} grant(s)`,
  lastToken: (at: string | null) => (at ? `, last token ${at}` : ", never approved"),
  needsId: "error: 'bastra oauth revoke' needs a client_id (see 'bastra oauth list') or 'all'\n",
  noClient: (id: string) => `error: no OAuth client with id '${id}'\n`,
  revoked: (n: number) => `revoked ${n} client(s) — their tokens stop working on the next request.\n`,
  unknownSub: (sub: string) =>
    `error: unknown 'oauth' subcommand '${sub}' — use 'bastra oauth list' or 'bastra oauth revoke <client_id|all>'\n`,
};
export type OAuthWords = typeof en;

const de: OAuthWords = {
  none: "keine OAuth-Clients registriert.\n",
  redirect: (hosts) => `  Weiterleitung: ${hosts}\n`,
  registered: (at, grants) => `  registriert ${at}, ${grants} Freigabe(n)`,
  lastToken: (at) => (at ? `, letztes Token ${at}` : ", nie bestätigt"),
  needsId: "Fehler: 'bastra oauth revoke' braucht eine client_id (siehe 'bastra oauth list') oder 'all'\n",
  noClient: (id) => `Fehler: kein OAuth-Client mit der ID '${id}'\n`,
  revoked: (n) => `${n} Client(s) widerrufen — ihre Tokens gelten ab der nächsten Anfrage nicht mehr.\n`,
  unknownSub: (sub) =>
    `Fehler: unbekannter 'oauth'-Unterbefehl '${sub}' — 'bastra oauth list' oder 'bastra oauth revoke <client_id|all>' verwenden\n`,
};

export const OAUTH_WORDS: Readonly<Record<string, OAuthWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function oauthWordsIn(language: string | undefined): OAuthWords {
  return OAUTH_WORDS[language ?? "en"] ?? en;
}
/** The words in language.primary, read once per command (English when unset or unreadable). */
export async function oauthWords(): Promise<OAuthWords> {
  return oauthWordsIn(await taskCliLanguage().catch(() => "en"));
}
