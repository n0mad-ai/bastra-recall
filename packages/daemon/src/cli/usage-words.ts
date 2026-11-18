/**
 * The one-line usage errors of CLI commands by language.primary (#1602):
 * English is the default and the fallback (byte-identical to before), German
 * complete. Text the product writes — never matched against user text.
 */
import { taskCliLanguage } from "./task-cli-words.js";

const en = {
  drafts: "usage: bastra drafts [list|purge|undo <id>|reject <id>...] [--json] [--vault <path>] [--force]\n",
  embeddings: "usage: bastra embeddings <on|off|status>\n",
  config: "usage: bastra config get <key> | bastra config set <key> <value>\n",
  modelsSet: "usage: bastra models set <ollama-model-tag>   (e.g. gemma4:12b)\n",
  models: "usage: bastra models [status | recommend | set <tag> | switch <id> <model> | later <id> | dismiss <id>]\n",
  suggestions:
    'usage: bastra suggestions reject <proposal_id> user-directed "explicit user rejection" | reset <proposal_id> user-directed\n',
  commons: 'usage: bastra commons verify <recipe-id> <works|fails> ["environment note"]\n',
  bridgesLive: "  usage: bastra bridges live <on|off> — switch on only after 'bastra bridges verify' passes a bridge\n",
  rulesProposals: "usage: bastra rules proposals",
  rulesDecide:
    "usage: bastra rules confirm|reject <id> <revision> user-directed — only after the user's explicit decision on the displayed proposal",
  recall: 'usage: bastra recall "<question>" [--limit N] [--scope S] [--type T] [--json]',
  save: "usage: bastra save --title T --type T --scope S [--summary S] [--recall-when W]... [--tag X]... [--topic a/b] [text | stdin] [--dry-run] [--json]",
};
export type UsageWords = typeof en;

const de: UsageWords = {
  drafts: "Aufruf: bastra drafts [list|purge|undo <id>|reject <id>...] [--json] [--vault <pfad>] [--force]\n",
  embeddings: "Aufruf: bastra embeddings <on|off|status>\n",
  config: "Aufruf: bastra config get <schlüssel> | bastra config set <schlüssel> <wert>\n",
  modelsSet: "Aufruf: bastra models set <ollama-modell-tag>   (z. B. gemma4:12b)\n",
  models: "Aufruf: bastra models [status | recommend | set <tag> | switch <id> <modell> | later <id> | dismiss <id>]\n",
  suggestions:
    'Aufruf: bastra suggestions reject <proposal_id> user-directed "ausdrückliche Ablehnung des Nutzers" | reset <proposal_id> user-directed\n',
  commons: 'Aufruf: bastra commons verify <recipe-id> <works|fails> ["Hinweis zur Umgebung"]\n',
  bridgesLive:
    "  Aufruf: bastra bridges live <on|off> — erst einschalten, wenn 'bastra bridges verify' eine Brücke bestanden hat\n",
  rulesProposals: "Aufruf: bastra rules proposals",
  rulesDecide:
    "Aufruf: bastra rules confirm|reject <id> <revision> user-directed — erst nach der ausdrücklichen Entscheidung des Nutzers zum angezeigten Vorschlag",
  recall: 'Aufruf: bastra recall "<frage>" [--limit N] [--scope S] [--type T] [--json]',
  save: "Aufruf: bastra save --title T --type T --scope S [--summary S] [--recall-when W]... [--tag X]... [--topic a/b] [text | stdin] [--dry-run] [--json]",
};

export const USAGE_WORDS: Readonly<Record<string, UsageWords>> = { en, de };
/** The usage lines in `language`; English for an unset or unlisted one. */
export function usageWordsIn(language: string | undefined): UsageWords {
  return USAGE_WORDS[language ?? "en"] ?? en;
}
/** The usage lines in language.primary (English when unset or unreadable). */
export async function usageWords(): Promise<UsageWords> {
  return usageWordsIn(await taskCliLanguage().catch(() => "en"));
}
