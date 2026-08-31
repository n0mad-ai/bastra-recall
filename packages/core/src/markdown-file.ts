/**
 * Was im Vault als Markdown zählt — EINE Regel, für jeden Scanner.
 *
 * Codex-Befund 7: Der initiale Vault-Walk verlangte exakt `.md`
 * (`extname(name) === ".md"`), der Watcher daneben akzeptierte
 * case-insensitiv auch `.MD`. Nachgestellt: `UPPER.MD` wurde von
 * `vault.init()` nicht geladen, von einem expliziten `reindexFile()` schon,
 * und war nach dem Neustart wieder weg — dieselbe Datei war je nach
 * Eingangstür ein Memory oder gar nichts. Jede weitere lokale Kopie dieser
 * Regel wäre die nächste Gelegenheit dafür, deshalb steht sie hier einmal.
 *
 * Case-insensitiv ist die richtige Seite der Uneinigkeit: macOS-Dateisysteme
 * sind es ohnehin, und Obsidian öffnet `.MD` genauso wie `.md`.
 */
export function isMarkdownFile(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}
