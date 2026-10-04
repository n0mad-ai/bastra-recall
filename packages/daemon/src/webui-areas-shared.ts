/**
 * Shared helpers of the area management (#216, split out in #680) — the
 * reserved-name check, the directory probe and the path boundaries that
 * create, rename and delete in webui-areas*.ts all go through.
 */
import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { assertInsideDir, assertInsideVault, isPathSafeComponent } from "@bastra-recall/core";
import { normalizeScopeKey } from "@bastra-recall/core/scope";

/** Folders under memories/ whose names the save-routing depends on. */
const RESERVED_TOP = new Set(["projects", "user", "all-projects", "taxonomy"]);

/**
 * Reserviert-Sein ist eine Frage der Scope-Identität, nicht der Schreibweise.
 *
 * Der Vergleich lief exakt gegen den Ordnernamen. Auf case-insensitivem APFS
 * zeigt `memories/Projects` aber auf genau denselben Ordner wie
 * `memories/projects`: über den Namen `Projects` ging das reservierte
 * Projekt-Regal als editierbarer Top-Bereich durch und ließ sich vollständig
 * umbenennen. Dieselbe zentrale Faltung wie überall sonst, statt einer
 * eigenen Kopie.
 */
export function isReservedTop(name: string): boolean {
  return RESERVED_TOP.has(normalizeScopeKey(name));
}

/**
 * Liegt dort ein Verzeichnis?
 *
 * Codex-Gegenreview: Jeder `stat`-Fehler galt als „nein". Ein Doku-Regal, das
 * nur nicht LESBAR war, sah damit aus wie ein nicht vorhandenes — der Rename
 * meldete Erfolg, das Projekt war umbenannt, die Dokumentation blieb unter dem
 * alten Namen; das Delete meldete Erfolg, die Memories lagen im Trash, die
 * Dokumentation blieb aktiv. Nur ENOENT/ENOTDIR beweisen Abwesenheit, alles
 * andere ist eine offene Frage und muss die Operation anhalten.
 */
export async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new Error(
      `cannot tell whether ${p} exists (${code ?? String(err)}) — refusing to continue: ` +
        `treating it as absent would leave the area half moved.`,
    );
  }
}

export function areaPath(vaultRoot: string, kind: "project" | "top", name: string): string {
  const memRoot = join(vaultRoot, "memories");
  const parent = kind === "project" ? join(memRoot, "projects") : memRoot;
  const p = join(parent, name);
  // Belt-and-suspenders containment — name is validated, but re-check the join.
  if (!resolve(p).startsWith(resolve(vaultRoot) + sep)) {
    throw new Error(`refusing to touch a path outside the vault: ${p}`);
  }
  // Codex-Gegenreview (P0): Die Prüfung war rein lexikalisch. Ein
  // Projektordner, der als Symlink nach außen zeigt, ging glatt durch — und
  // `renameArea()` schrieb dann in fremden Dateien außerhalb des Vaults die
  // Scopes um.
  //
  // Sicherheitsrunde: Die Grenze ist nicht der Vault, sondern das ELTERNREGAL.
  // Ein Projektordner als Symlink auf `memories/people` oder auf
  // `dokumentationen/` verlässt den Vault nicht — er verlässt aber den Bereich,
  // den diese Area besitzt, und ein Rename schrieb dort fremde Scopes um oder
  // schob ein fremdes Regal in den Trash.
  assertInsideVault(vaultRoot, parent, "touch an area");
  assertInsideDir(parent, p, "touch an area", `${kind === "project" ? "memories/projects" : "memories"}`);
  return p;
}

/**
 * Das Doku-Regal einer Area — mit derselben Grenze wie das Memory-Regal.
 *
 * Sicherheitsrunde: Diese beiden Pfade wurden bisher nur zusammengesetzt.
 * `dokumentationen/<name>` als Symlink auf ein anderes Regal ließ den Rename
 * dort fremde Dokumente umschreiben und das Delete sie in den Trash schieben —
 * gemeldet als „die Area ist umgezogen".
 */
export function docsShelfPath(vaultRoot: string, name: string): string {
  const parent = join(vaultRoot, "dokumentationen");
  const p = join(parent, name);
  assertInsideVault(vaultRoot, parent, "touch a docs shelf");
  assertInsideDir(parent, p, "touch a docs shelf", "dokumentationen");
  return p;
}

export function assertEditable(kind: "project" | "top", name: string): void {
  if (!isPathSafeComponent(name)) {
    throw new Error(`invalid area name: ${JSON.stringify(name)}`);
  }
  if (kind === "top" && isReservedTop(name)) {
    throw new Error(`"${name}" is a reserved system area and cannot be changed`);
  }
}
