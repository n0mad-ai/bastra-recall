import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bastraDataDir } from '@bastra-recall/core/platform-paths';
import type { PanelLang } from './i18n';

/** `language.primary` from the daemon's cli-settings.json (same path as its settingsFilePath()); undefined on any error. */
export function readPrimaryLanguage(home: string = homedir()): string | undefined {
  try {
    const primary = JSON.parse(readFileSync(join(bastraDataDir(home), 'cli-settings.json'), 'utf8'))?.language?.primary;
    return typeof primary === 'string' ? primary.trim().toLowerCase() : undefined;
  } catch { return undefined; }
}

/** An explicit --lang wins; otherwise German only when Recall's primary language is German, else English. */
export function panelLang(cliLang: PanelLang | undefined, home?: string): PanelLang {
  return cliLang ?? (readPrimaryLanguage(home) === 'de' ? 'de' : 'en');
}
