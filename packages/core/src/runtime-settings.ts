/** Read-only settings access for thin clients. No schema setup or migration. */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

/** Undefined means no DB record yet; null means deleted or unavailable
 * authoritative settings. Never revive a legacy file after a database read
 * failure, and never import one here. */
export function readRuntimeSettingsRecord(legacyPath: string, databasePath?: string): string | null | undefined {
  const path = resolve(databasePath ?? process.env.BASTRA_DB_PATH ?? join(legacyPath, "..", "recall.db"));
  if (!existsSync(path)) return undefined;
  let db: DatabaseSync | undefined;
  const emitWarning = process.emitWarning;
  try {
    if (process.versions.node.startsWith("22.")) process.emitWarning = ((warning: string | Error,...args: unknown[]) => {
      if (typeof warning === "string" && warning.startsWith("SQLite is an experimental feature")) return;
      Reflect.apply(emitWarning,process,[warning,...args]);
    }) as typeof emitWarning;
    const SQLite = createRequire(import.meta.url)("node:sqlite").DatabaseSync as typeof DatabaseSync;
    db = new SQLite(path,{readOnly:true,allowExtension:false});
    db.exec("PRAGMA busy_timeout=0");
    const row=db.prepare("SELECT value FROM app_records WHERE namespace='settings' AND key=?").get(resolve(legacyPath));
    if (!row) return undefined;
    const envelope=JSON.parse(String(row.value));
    return typeof envelope?.text === "string" ? envelope.text : null;
  } catch { return null; }
  finally { db?.close();process.emitWarning=emitWarning; }
}
