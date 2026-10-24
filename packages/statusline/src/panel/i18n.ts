/** UI strings of the status panels. German is only the renderer fallback; the CLI picks the language (see lang-setting.ts). */
export type PanelLang = 'de' | 'en';
export const DEFAULT_LANG: PanelLang = 'de';

/** Case-insensitive 'en' selects English; anything else stays German. */
export function resolveLang(v?: string | null): PanelLang {
  return v?.trim().toLowerCase() === 'en' ? 'en' : 'de';
}

/** Locale for number formatting. */
export const LOCALE: Record<PanelLang, string> = { de: 'de-DE', en: 'en-US' };

const STRINGS = {
  // Recall stages and counters
  'recall.memories': { de: 'Erinnerungen', en: 'memories' },
  'recall.found': { de: 'gefunden', en: 'found' },
  'recall.loaded': { de: 'geladen', en: 'loaded' },
  'recall.inVault': { de: 'im Vault', en: 'in the vault' },
  'recall.sinceLast': { de: 'seit deiner letzten Nachricht', en: 'since your last message' },
  'recall.searches': { de: 'Suchen', en: 'searches' },
  'recall.saved': { de: 'gespeichert', en: 'saved' },
  'recall.errors': { de: 'Fehler', en: 'errors' },
  'recall.noLiveMeasure': { de: 'keine Live-Messung', en: 'not measured live' },
  // Header mode
  'mode.demo': { de: 'Demo mit Beispieldaten', en: 'Demo with sample data' },
  // Context and limits
  'label.context': { de: 'Kontext', en: 'Context' },
  'label.5h': { de: '5 Std', en: '5 h' },
  'label.7d': { de: '7 Tage', en: '7 days' },
  'context.used': { de: '% Kontext belegt', en: '% context used' },
  'context.free': { de: '{free} frei', en: '{free} free' },
  'context.of': { de: 'von {total}', en: 'of {total}' },
  'reset.prefix': { de: 'Reset', en: 'Reset' },
  // Narrow view (< 90 columns)
  'narrow.context': { de: 'Kontext {context} %, {free} frei', en: 'Context {context} %, {free} free' },
  'narrow.limits': { de: '5 Std {usage5h} %, 7 Tage {usage} %, {reset}', en: '5 h {usage5h} %, 7 days {usage} %, {reset}' },
  'narrow.recall': { de: '{vault} Erinnerungen, {hits} gefunden, {loads} geladen', en: '{vault} memories, {hits} found, {loads} loaded' },
  'narrow.counts': { de: '{searches} Suchen, {saves} gespeichert', en: '{searches} searches, {saves} saved' },
  // Session and cost row
  'session.session': { de: 'Session', en: 'Session' },
  'session.api': { de: 'davon API', en: 'of which API' },
  'session.lines': { de: 'Zeilen', en: 'Lines' },
  'session.cost': { de: 'Kosten', en: 'Cost' },
  'session.cache': { de: 'Cache', en: 'Cache' },
  'session.cachedInput': { de: 'Cache-Eingabe', en: 'Cached input' },
  'session.total': { de: 'Gesamt', en: 'Total' },
  'session.tokens': { de: '{n} Tokens', en: '{n} tokens' },
  'session.million': { de: '{n} Mio.', en: '{n}M' },
  // Demo data
  'demo.stage': { de: 'Semantik abgleichen', en: 'Matching semantics' },
  'demo.title1': { de: 'Beispiel: Deploy-Kette lokal', en: 'Example: local deploy chain' },
  'demo.title2': { de: 'Beispiel: klare Borders statt Box-in-Box', en: 'Example: clear borders instead of box-in-box' },
  'demo.title3': { de: 'Beispiel: Statusline-Mechanik', en: 'Example: statusline mechanics' },
  // Live stage line (claude-data.ts, codex-data.ts, follower in recall-panel.ts)
  'stage.raw': { de: '{text}', en: '{text}' },
  'stage.tool': { de: '{tool}', en: '{tool}' },
  'stage.waitingNative': { de: 'Warte auf native Sitzungsdaten', en: 'Waiting for native session data' },
  'stage.nativeStale': { de: 'Native Daten veraltet', en: 'Native data is stale' },
  'stage.transcriptUnreachable': { de: 'Transcript nicht erreichbar', en: 'Transcript unreachable' },
  'stage.failedCalls': { de: '{n} fehlgeschlagene Aufrufe', en: '{n} failed calls' },
  'stage.ready': { de: 'Recall bereit', en: 'Recall ready' },
  'stage.recent': { de: 'Zuletzt: {tool}', en: 'Last: {tool}' },
  'stage.recentError': { de: 'Zuletzt: {tool} · Fehler', en: 'Last: {tool} · error' },
  'stage.recentActivity': { de: 'Zuletzt: Recall-Aktivität', en: 'Last: Recall activity' },
  'stage.claudeTool': { de: 'Claude aktiv · {tool}', en: 'Claude active · {tool}' },
  'stage.claudeWorking': { de: 'Claude arbeitet · Recall bereit', en: 'Claude working · Recall ready' },
  'stage.codexActive': { de: 'Codex aktiv · Recall bereit', en: 'Codex active · Recall ready' },
  'stage.codexUnavailable': { de: 'Codex-Transcript nicht verfügbar', en: 'Codex transcript unavailable' },
  'stage.codexNotFound': { de: 'Codex-Transcript nicht gefunden', en: 'Codex transcript not found' },
  'stage.noAgent': { de: 'In diesem Tab läuft weder Claude noch Codex', en: 'Neither Claude nor Codex is running in this tab' },
  'tool.recall': { de: 'Erinnerungen suchen', en: 'Search memories' },
  'tool.load_memory': { de: 'Erinnerung laden', en: 'Load memory' },
  'tool.read_document': { de: 'Dokument laden', en: 'Load document' },
  'tool.save_memory': { de: 'Erinnerung speichern', en: 'Save memory' },
  'tool.edit_memory': { de: 'Erinnerung bearbeiten', en: 'Edit memory' },
  // Context warnings (context-level.ts)
  'ctx.caution': { de: 'Qualität lässt nach', en: 'Quality is degrading' },
  'ctx.warning': { de: 'Bald neue Sitzung starten', en: 'Start a new session soon' },
  'ctx.critical': { de: 'Context Rot: neu starten', en: 'Context rot: restart' },
  // Reset countdown (reset-time.ts)
  'reset.due': { de: 'RESET FÄLLIG', en: 'RESET DUE' },
  // Git and timing (details.ts)
  'git.changed': { de: 'geändert', en: 'changed' },
  'git.new': { de: 'neu', en: 'new' },
  'git.conflicts': { de: 'Konflikte', en: 'conflicts' },
  'git.clean': { de: 'sauber', en: 'clean' },
  'timing.client': { de: 'Client', en: 'Client' },
  'timing.tool': { de: 'Toolzeit', en: 'Tool time' },
  // Shared rows (render-base.ts, also used by Ember)
  'base.lastLoaded': { de: 'Zuletzt geladen', en: 'Last loaded' },
  'base.nothingSince': { de: 'Noch nichts seit deiner letzten Nachricht', en: 'Nothing yet since your last message' },
  'base.loadedPrefix': { de: 'Geladen: ', en: 'Loaded: ' },
  'base.nothingYet': { de: 'noch nichts', en: 'nothing yet' },
  'base.waiting': { de: 'wartet auf Daten', en: 'waiting for data' },
  'base.quota': { de: 'Kontext {context} % · 5 Std {usage5h} % · 7 Tage {usage} %', en: 'Context {context} % · 5 h {usage5h} % · 7 days {usage} %' },
  'base.counters': { de: '{searches} Suchen · {hits} Treffer · {loads} geladen · {saves} gespeichert', en: '{searches} searches · {hits} hits · {loads} loaded · {saves} saved' },
} as const satisfies Record<string, Record<PanelLang, string>>;

export type PanelKey = keyof typeof STRINGS;
export { STRINGS };

/** Looks up `key` and fills `{name}` placeholders from `vars`; unknown placeholders stay as written. */
export function t(lang: PanelLang, key: PanelKey, vars?: Record<string, string | number>): string {
  const text: string = STRINGS[key][lang];
  return vars ? text.replace(/\{(\w+)\}/g, (match, name: string) => name in vars ? String(vars[name]) : match) : text;
}

/** True for a key of the table; snapshots are external data, so their keys need this check. */
export const isPanelKey = (key: unknown): key is PanelKey => typeof key === 'string' && Object.hasOwn(STRINGS, key);

/** A text in language-neutral form: its key, plain values, and values that are keys themselves (translated too). */
export interface PanelText { key: PanelKey; vars?: Record<string, string | number>; keys?: Record<string, PanelKey> }

/** Renders a PanelText; null when it carries an unknown key. */
export function render(lang: PanelLang, text: PanelText): string | null {
  const keys = Object.entries(text.keys ?? {});
  if (!isPanelKey(text.key) || !keys.every(([, key]) => isPanelKey(key))) return null;
  return t(lang, text.key, { ...text.vars, ...Object.fromEntries(keys.map(([name, key]) => [name, t(lang, key)])) });
}

/** The stage fields of NeuralData: German `stage` for every design, `stageText` for designs that translate. */
export function stageFields(text: PanelText): { stage: string; stageText: PanelText } {
  return { stage: render('de', text)!, stageText: text };
}

/** A tool's label key, or the raw tool name. */
export function toolLabel(labels: Record<string, PanelKey>, name: string): Pick<PanelText, 'vars' | 'keys'> {
  return Object.hasOwn(labels, name) ? { keys: { tool: labels[name]! } } : { vars: { tool: name } };
}
