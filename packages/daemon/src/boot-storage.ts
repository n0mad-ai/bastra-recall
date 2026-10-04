/**
 * Start-up phase 1 (#1039): open the vault and its search index, publish the
 * live vault size for the statuslines, and load the read-only Commons index.
 *
 * Moved verbatim out of `main()` in `index.ts`; `main()` calls it right after
 * the #483 port probe, so nothing here runs on a process that is about to exit.
 */
import { Vault, SearchIndex } from "@bastra-recall/core";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { getCommonsEnabled } from "./settings.js";
import { commonsPath, loadVerificationCounts } from "./cli/commons.js";
import { writeSharedVaultSize } from "./statusline-session.js";

export async function openStorage(opts: { vaultPath: string }): Promise<{
  vault: Vault;
  search: SearchIndex;
  commonsSearch: SearchIndex | null;
  commonsVerifications: Map<string, { works: number; fails: number }> | null;
}> {
  const { vaultPath } = opts;

  const vault = new Vault(vaultPath);
  const { loaded, skipped } = await vault.init();
  console.error(
    `[bastra-recall] vault loaded: ${loaded} memorys` +
      (skipped.length ? `, ${skipped.length} skipped` : ""),
  );
  for (const s of skipped) {
    console.error(`[bastra-recall]   skipped ${s.path}: ${s.err}`);
  }
  vault.startWatching();

  // Publish the live vault size to a shared file so every session's statusline
  // — including idle ones that make no tool calls — shows the current memory
  // count. The per-session forwarder feed only refreshes on that session's own
  // calls, so without this an idle session shows a stale count after another
  // session (or an external write the watcher caught) changes the vault.
  // Debounced so a burst of watcher events collapses into one write.
  const publishVaultSize = (() => {
    let last = -1;
    let timer: ReturnType<typeof setTimeout> | null = null;
    return () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const size = vault.size();
        if (size !== last) {
          last = size;
          writeSharedVaultSize(size);
        }
      }, 300);
      timer.unref?.();
    };
  })();
  writeSharedVaultSize(vault.size()); // initial, before any event
  vault.on(() => publishVaultSize());

  const search = new SearchIndex(vault);
  search.start();

  // Bastra Commons: read-only Community-Rezept-Index. Bewusst BM25-only —
  // kein Embedding-Backfill, kein RelatedEnricher: in das git-synchronisierte
  // Verzeichnis wird NIE geschrieben (#104-Lektion: ein Schreiber weniger).
  let commonsSearch: SearchIndex | null = null;
  let commonsVerifications: Map<string, { works: number; fails: number }> | null = null;
  if (await getCommonsEnabled()) {
    const recipesDir = path.join(commonsPath(), "recipes");
    if (existsSync(recipesDir)) {
      try {
        const commonsVault = new Vault(recipesDir);
        await commonsVault.init();
        commonsSearch = new SearchIndex(commonsVault);
        commonsSearch.start();
        // verify-Loop: Records einlesen — Evidenz fließt ins Fusion-Ranking.
        commonsVerifications = loadVerificationCounts(commonsPath());
        const verified = [...commonsVerifications.values()].reduce((s, v) => s + v.works + v.fails, 0);
        console.error(`[bastra-recall] commons: enabled (${commonsVault.size()} recipes, ${verified} verification records from ${recipesDir})`);
      } catch (err) {
        console.error(`[bastra-recall] commons: failed to load (${(err as Error).message}) — continuing without`);
        commonsSearch = null;
      }
    } else {
      console.error(`[bastra-recall] commons: enabled but not cloned — run 'bastra commons enable'`);
    }
  }

  return { vault, search, commonsSearch, commonsVerifications };
}
