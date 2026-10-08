/** Completed in-memory vault word measure; maintained by the background watcher. */
import type { Vault } from "@bastra-recall/core";
import { memoryText, vaultWords } from "./harvest-vault-match.js";
import { tokens } from "./save-similarity.js";

export interface DraftVocabulary { count: number; df: ReadonlyMap<string, number> }
let current: DraftVocabulary = { count: 0, df: new Map() };
let active: Vault | undefined;
let unsubscribe: (() => void) | undefined;
export function draftVocabularySnapshot(): DraftVocabulary { return current; }

/** Called at daemon startup, never while rendering a hook or recall response. */
export function startDraftVocabulary(vault: Vault): void {
  if (active === vault) return;
  unsubscribe?.(); active = vault;
  const { sets, df } = vaultWords(vault);
  current = { count: sets.size, df };
  unsubscribe = vault.on(event => {
    const id = event.kind === "remove" ? event.id : event.memory.fm.id;
    for (const word of sets.get(id) ?? []) {
      const count = (df.get(word) ?? 1) - 1;
      if (count) df.set(word, count); else df.delete(word);
    }
    sets.delete(id);
    if (event.kind !== "remove") {
      const words = new Set(tokens(memoryText(event.memory))); sets.set(id, words);
      for (const word of words) df.set(word, (df.get(word) ?? 0) + 1);
    }
    current = { count: sets.size, df };
  });
}
