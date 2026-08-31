/**
 * Scope-Identität — die EINE Stelle, die entscheidet, ob zwei Scope-Strings
 * (oder ein Scope gegen einen Projektnamen) dasselbe meinen (#360-Folgefund).
 *
 * Der Hintergrund: `detectProject()` (topics.ts) liefert das Verzeichnis-
 * segment in seiner ECHTEN Schreibweise (`~/Projekte/CarNexus` → "CarNexus"),
 * Vault-Scopes sind konventionell klein geschrieben ("carnexus"). Überall, wo
 * ein aus dem DATEISYSTEM abgeleiteter Name gegen einen im VAULT geschriebenen
 * Namen geprüft wird, treffen zwei Schreibkonventionen aufeinander — jede
 * ungefaltete `===`- oder `startsWith`-Prüfung an so einer Stelle ist ein
 * Bug, der wie "nichts gefunden" aussieht statt wie ein Fehler.
 *
 * Bestandsdaten bleiben unangetastet: Frontmatter-Scopes werden NIE
 * umgeschrieben, nur beim Vergleich gefaltet.
 */

/** Scopes, die in JEDEM Projekt-Kontext relevant sein können — global im
 *  Sinn von "gilt unabhängig vom erkannten Projekt". */
export const GLOBAL_SCOPES = new Set(["all-projects", "user-preference", "taxonomy", "commons"]);

/** Kanonischer Vergleichsschlüssel für einen Scope-String. Die einzige
 *  Stelle, die die Schreibweise faltet — alles andere ruft diese Funktion
 *  (direkt oder über {@link scopeEquals}/{@link isScopeCompatible}) statt
 *  selbst `.toLowerCase()` zu duplizieren. */
export function normalizeScopeKey(scope: string): string {
  // NFC vor der Faltung: macOS legt Dateinamen in NFD ab (`Cafe` + combining
  // acute), während dieselbe Eingabe aus einem Editor als NFC (`Café`) kommt.
  // Ungefaltet sind das zwei verschiedene Scopes, und der Unterschied ist
  // unsichtbar — dieselbe Klasse wie der Groß-/Kleinschreibungs-Fehler aus
  // #360, nur eine Ebene tiefer (Codex-Gegenreview, P2).
  return scope.normalize("NFC").toLowerCase();
}

/** Exakter Scope-Vergleich, gefaltet über {@link normalizeScopeKey}. Für
 *  Stellen, die "genau dieser Scope" meinen — Recall-Scope-Filter,
 *  `list_memorys`, Floor-Lookup, Save-Quality-Kollisionspool. */
export function scopeEquals(a: string, b: string): boolean {
  return normalizeScopeKey(a) === normalizeScopeKey(b);
}

/**
 * Scope-Kompatibilität für Recall-Hints (#107/#110, gefaltet seit #360):
 * bei erkanntem Projekt gelten als kompatibel:
 *   - globale Scopes ({@link GLOBAL_SCOPES}),
 *   - der Projekt-Scope selbst (exakt, gefaltet),
 *   - die Scope-FAMILIE über ein Präfix-Verhältnis ("bastra" deckt
 *     "bastra-recall", aber "bastra-io" und "bastra-recall" bleiben
 *     getrennte Geschwister).
 *
 * Verschoben aus `packages/daemon/src/hook-skip.ts` (dort erstmals gefaltet,
 * #360) — zentral hier, damit jede Vergleichsstelle dieselbe Semantik nutzt
 * statt eigener Kopien, die auseinanderdriften können.
 */
export function isScopeCompatible(scope: string, project: string | null): boolean {
  if (!project || !scope) return true;
  const s = normalizeScopeKey(scope);
  const p = normalizeScopeKey(project);
  if (GLOBAL_SCOPES.has(s)) return true;
  if (s === p) return true;
  return p.startsWith(s + "-") || s.startsWith(p + "-");
}
