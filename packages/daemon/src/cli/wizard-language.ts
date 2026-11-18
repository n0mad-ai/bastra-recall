/**
 * The language step of the guided `bastra install` (#1602): English is the
 * default, German is offered from the start. The choice is `language.primary`
 * — the language of the CLI's help and messages, of the web UI and of new
 * memories. A language already stored (by `config set`, onboarding or an
 * earlier setup) stands and is not asked again. Like every wizard answer it is
 * written only when the setup executes, never on a cancel.
 */
import * as p from "@clack/prompts";
import { getPrimaryLanguage, setPrimaryLanguage } from "../settings.js";
import { HELP_LANGUAGES, type HelpLanguage } from "./help-text.js";

export interface SetupLanguage {
  language: string;
  /** False when the language was already stored: nothing to write. */
  save: boolean;
}

/** The preselection: the system locale's language when the CLI has its texts, English otherwise. */
export function systemLanguage(locale: string = Intl.DateTimeFormat().resolvedOptions().locale): HelpLanguage {
  const code = locale.split(/[-_.]/)[0]?.toLowerCase();
  return HELP_LANGUAGES.find((language) => language === code) ?? "en";
}

/** The stored language, or the user's pick (a cancel symbol when cancelled). */
export async function askSetupLanguage(locale?: string): Promise<SetupLanguage | symbol> {
  const stored = await getPrimaryLanguage().catch(() => undefined);
  if (stored) return { language: stored, save: false };
  const choice = await p.select({
    message: "Language / Sprache",
    options: [
      { value: "en", label: "English", hint: "help, messages and new memories in English" },
      { value: "de", label: "Deutsch", hint: "Hilfe, Meldungen und neue Memories auf Deutsch" },
    ],
    initialValue: systemLanguage(locale),
  });
  if (p.isCancel(choice)) return choice;
  return { language: choice, save: true };
}

/** Writes the pick at execute time; a language that was already stored stays as it is. */
export async function saveSetupLanguage(choice: SetupLanguage): Promise<void> {
  if (choice.save) await setPrimaryLanguage(choice.language);
}
