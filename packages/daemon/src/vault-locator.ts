/**
 * Der {@link MemoryLocator} auf Basis des bereits geladenen Vault-Index.
 *
 * `saveMemory` fragt für jede Identitätsentscheidung, wo ein Memory liegt.
 * Ohne Auskunft fällt es auf einen vaultweiten Dateiscan zurück — korrekt,
 * aber auf einem Vault mit tausend Memories je Save spürbar, und beim
 * Bulk-Import summiert sich das. Der Daemon hat die Antwort ohnehin im
 * Speicher: Der Index ist nach effektiver id aufgebaut, also derselben
 * Identität, die der Locator meint.
 *
 * `ambiguous` beantwortet `Vault.pathsFor()`: Der Index hält je id genau einen
 * Eintrag, kennt aber die Dateien, die er wegen derselben id quarantäniert hat
 * (#240/A2.3). Ohne diese zweite Quelle konnte der Locator nie `ambiguous`
 * melden — ein Save lief durch und ließ das Duplikat bestehen, obwohl jede
 * Schreibentscheidung dort geraten wäre: Welche der beiden Dateien ist
 * gemeint?
 */
import type { Located, MemoryLocator } from "@bastra-recall/core";

export function vaultLocator(vault: {
  get(id: string): { filePath: string } | undefined;
  pathsFor?(id: string): string[];
  scanBlindSpots?(): string[];
}): MemoryLocator {
  return {
    locate(id: string): Located {
      // Codex-Gegenreview (P0): Der Index konnte nicht ausdrücken, dass sein
      // Scan unvollständig war — ein unlesbarer Teilbaum sah aus wie ein
      // leerer, und `none` war dann eine Behauptung ohne Deckung. Hinter dem
      // Ordner, den der Vault nicht öffnen konnte, kann genau diese id liegen.
      const blind = vault.scanBlindSpots?.() ?? [];
      if (blind.length > 0) return { kind: "incomplete", unreadable: blind };
      // `pathsFor` kennt auch die quarantänisierten Dateien — `get()` allein
      // verschwieg, dass es eine zweite gibt, und der Locator konnte
      // `ambiguous` nie melden. Ein Save lief dann durch und ließ das Duplikat
      // bestehen (Codex-Gegenreview).
      const paths = vault.pathsFor?.(id) ?? (vault.get(id) ? [vault.get(id)!.filePath] : []);
      if (paths.length === 0) return { kind: "none" };
      if (paths.length === 1) return { kind: "unique", filePath: paths[0] };
      return { kind: "ambiguous", filePaths: paths };
    },
  };
}
