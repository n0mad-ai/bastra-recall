/**
 * The words `bastra token` prints for people, by language.primary (#1602):
 * English is the default and the fallback (byte-identical to before), German
 * complete. The token itself and `--json` stay as they are. Text the product
 * writes — never matched against user text.
 */
import { taskCliLanguage } from "./task-cli-words.js";

const en = {
  unknownSub: (sub: string) =>
    `error: unknown 'token' subcommand '${sub}' — use 'bastra token', 'bastra token rotate', or 'bastra token clear'\n`,
  cleared: "✗ token cleared — browser/REST clients are now locked out.\n",
  restartToDrop: "Restart the daemon so it drops the token (the next recall respawns it): bastra update\n",
  noneSet: "no token was set — nothing to clear.\n",
  rotated: "↻ rotated — the previous token no longer works.\n",
  allowedOrigin: (origin: string) => `✓ allowed origin ${origin} for the browser bridge.\n`,
  paste:
    "Paste into bastra.io → Settings → Recall, then restart the daemon so it\n" +
    "loads the token (the next recall respawns it): bastra update\n",
};
export type TokenWords = typeof en;

const de: TokenWords = {
  unknownSub: (sub) =>
    `Fehler: unbekannter 'token'-Unterbefehl '${sub}' — 'bastra token', 'bastra token rotate' oder 'bastra token clear' verwenden\n`,
  cleared: "✗ Token entfernt — Browser- und REST-Clients sind jetzt ausgesperrt.\n",
  restartToDrop:
    "Den Daemon neu starten, damit er das Token vergisst (der nächste Recall startet ihn wieder): bastra update\n",
  noneSet: "es war kein Token gesetzt — nichts zu entfernen.\n",
  rotated: "↻ erneuert — das bisherige Token gilt nicht mehr.\n",
  allowedOrigin: (origin) => `✓ Herkunft ${origin} für die Browser-Brücke erlaubt.\n`,
  paste:
    "In bastra.io → Einstellungen → Recall einfügen, dann den Daemon neu starten, damit er\n" +
    "das Token lädt (der nächste Recall startet ihn wieder): bastra update\n",
};

export const TOKEN_WORDS: Readonly<Record<string, TokenWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function tokenWordsIn(language: string | undefined): TokenWords {
  return TOKEN_WORDS[language ?? "en"] ?? en;
}
/** The words in language.primary, read once per command (English when unset or unreadable). */
export async function tokenWords(): Promise<TokenWords> {
  return tokenWordsIn(await taskCliLanguage().catch(() => "en"));
}
