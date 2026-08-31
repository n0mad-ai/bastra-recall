import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename, relative, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import matter from "gray-matter";
import { isMarkdownFile } from "./markdown-file.js";
import { type Memory, parseMemoryWith, NotAMemoryFile } from "./schema.js";

/**
 * A file could not be READ (ENOENT, EIO, EACCES, an unmaterialised cloud
 * placeholder, a write in flight). Deliberately distinct from a content
 * failure: an operational error must never evict the last-known-good node,
 * a content failure must.
 */
export class VaultIOError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly cause: Error,
  ) {
    super(`could not read ${filePath}: ${cause.message}`);
    this.name = "VaultIOError";
  }
}

export type VaultEvent =
  | { kind: "add"; memory: Memory }
  | { kind: "change"; memory: Memory }
  | { kind: "remove"; id: string; filePath: string };

export type VaultListener = (e: VaultEvent) => void;

/**
 * A vault is a directory tree of .md files. Files with valid memory
 * frontmatter (recognized `type:` field) are loaded; everything else
 * (e.g. plain Obsidian notes living in the same folders) is silently
 * skipped. Sub-directories are walked recursively, dotfolders and
 * `node_modules` are excluded.
 *
 * This means the user can point the app at an Obsidian vault root and
 * organize memorys into nested topic folders if they want, without
 * giving up the ability to keep regular notes alongside.
 */
export class Vault {
  private memorys = new Map<string, Memory>(); // id → memory
  private filePathToId = new Map<string, string>(); // absolute path → id
  // per indexed file, remembered at read time — reconcile() compares against
  // these to spot in-place edits the cloud-mount watcher never reported (#199)
  private fileStats = new Map<string, { mtimeMs: number; size: number }>();
  private listeners = new Set<VaultListener>();
  private watcher?: FSWatcher;
  /** Paths we already reported as a duplicate-id skip, so reconcile's 60s
   *  retry does not reprint the same warning. Cleared when the path leaves
   *  the tree — a leftover copy must be free to claim the id if the winner
   *  is gone. */
  private duplicateSkipLogged = new Set<string>();
  /**
   * id → Pfade, die diese id ebenfalls tragen, aber NICHT im Index stehen
   * (#240/A2.3-Quarantäne). Der Vault erkannte sie längst und meldete sie
   * beim Start — er behielt die Information nur nicht abfragbar, und
   * `get(id)` gab weiter den Gewinner zurück, als wäre er der einzige.
   *
   * Genau daran hing ein Loch im Save-Pfad (Codex-Gegenreview): Der
   * `vaultLocator` konnte `ambiguous` nie melden, weil er nur `get()` fragte
   * — ein Save lief durch und ließ das Duplikat bestehen. Zwei Dateien mit
   * einer id sind aber kein Randfall, sondern ein Zustand, in dem jede
   * Schreibentscheidung geraten wäre: Welche der beiden ist gemeint?
   */
  private duplicatePaths = new Map<string, Set<string>>();
  /**
   * Verzeichnisse, die der letzte Scan nicht öffnen konnte. Der Index ist
   * dann nachweislich unvollständig, und jeder besitzverändernde Writer muss
   * das erfahren — `pathsFor()` allein kann es nicht ausdrücken.
   */
  private unreadablePaths: string[] = [];
  /**
   * Einzelne Dateien, die nicht GELESEN werden konnten — dieselbe Auskunft wie
   * `unreadablePaths`, nur eine Ebene tiefer.
   *
   * Codex-Gegenreview: Eine beim Start unlesbare Markdown-Datei landete zwar im
   * `skipped`-Report, aber nicht in den blinden Flecken. Der Index war damit
   * nachweislich unvollständig und meldete trotzdem keinen — und ein Writer,
   * der `scanBlindSpots()` fragt, um fail-closed zu reagieren, bekam grünes
   * Licht. Ein Verzeichnis, das man nicht öffnen kann, und eine Datei, die man
   * nicht lesen kann, verbergen beide eine id.
   */
  private unreadableFiles = new Set<string>();

  constructor(public readonly root: string) {}

  async init(): Promise<{ loaded: number; skipped: { path: string; err: string }[] }> {
    // Reihenfolge stabil halten: nach Pfad sortieren bevor wir parallel laden.
    // So bleibt die Map-Iterationsordnung deterministisch (Maps iterieren in
    // Insertion-Order; wir setzen die Ergebnisse in Pfad-Sortierreihenfolge).
    const scan = await this.listMarkdownFiles();
    const files = scan.files.slice().sort();
    this.unreadablePaths = scan.unreadable;
    const skipped: { path: string; err: string }[] = [];
    for (const dir of scan.unreadable) {
      const err = "directory could not be read — its memories are invisible to this index";
      console.warn(`[vault] init blind spot (${basename(dir)}): ${err}`);
      skipped.push({ path: dir, err });
    }
    const BATCH = 32;
    type Loaded = { kind: "ok"; file: string; memory: Memory };
    type Skipped = { kind: "skip" };
    type Failed = { kind: "fail"; file: string; err: string };
    const results: (Loaded | Skipped | Failed)[] = new Array(files.length);
    for (let i = 0; i < files.length; i += BATCH) {
      const chunk = files.slice(i, i + BATCH);
      const settled = await Promise.allSettled(
        chunk.map((f) => this.read(f)),
      );
      for (let j = 0; j < settled.length; j++) {
        const s = settled[j];
        const f = chunk[j];
        if (s.status === "fulfilled") {
          results[i + j] = { kind: "ok", file: f, memory: s.value };
        } else {
          const err = s.reason;
          if (err instanceof NotAMemoryFile) {
            results[i + j] = { kind: "skip" };
          } else {
            const msg = (err as Error).message ?? String(err);
            // Unlesbar ist ein blinder Fleck, kaputtes Frontmatter nicht: Die
            // eine Datei kann jede id tragen, die andere trägt nachweislich
            // keine.
            if (err instanceof VaultIOError) this.unreadableFiles.add(f);
            console.warn(`[vault] init skipped (${basename(f)}): ${msg}`);
            results[i + j] = { kind: "fail", file: f, err: msg };
          }
        }
      }
    }
    // Insertion in Pfad-Sortierreihenfolge → deterministische Map-Iteration.
    for (const r of results) {
      if (!r || r.kind !== "ok") {
        if (r && r.kind === "fail") skipped.push({ path: r.file, err: r.err });
        continue;
      }
      // #240/A2.3: two files carrying the same id must never both point at
      // one map entry. Cloud-sync conflict copies ("Alpha (1).md") are the
      // common source. Before, init silently kept whichever file sorted last
      // and reported `loaded: 1`; cleaning up the copy then took the winner
      // with it. First path wins deterministically, the rest are quarantined
      // out of the index and reported.
      const claimed = this.memorys.get(r.memory.fm.id);
      if (claimed) {
        skipped.push({
          path: r.file,
          err: duplicateIdSkipMessage(r.memory.fm.id, claimed.filePath),
        });
        this.rememberDuplicate(r.memory.fm.id, r.file);
        continue;
      }
      this.memorys.set(r.memory.fm.id, r.memory);
      this.filePathToId.set(r.file, r.memory.fm.id);
    }
    return { loaded: this.memorys.size, skipped };
  }

  /** Start watching the vault tree (recursive). Emits add/change/remove. */
  startWatching(): void {
    if (this.watcher) return;
    // fsevents/kqueue do not fire reliably for files written *into* a
    // GoogleDrive/iCloud/Dropbox provider mount. Force polling on those.
    const isCloudMount = /(CloudStorage|Dropbox|iCloud)/i.test(this.root);
    // #242: watch the DIRECTORY, never a glob. chokidar removed glob support
    // in v4 — `${root}/**/*.md` is taken as a literal path, so the watcher
    // silently watches nothing and emits no events and no error. The .md
    // filter moved into the handlers on purpose: `ignored` also sees
    // directories, and filtering those by extension would stop the traversal.
    this.watcher = chokidar.watch(this.root, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      usePolling: isCloudMount,
      interval: isCloudMount ? 1500 : undefined,
      ignored: (p: string) => {
        // Skip dotfolders (.obsidian, .git, .trash, …) and node_modules —
        // but only ones the vault actually contains. #365: this used to split
        // the ABSOLUTE path, so a vault under ~/.local/share/bastra/vault or
        // ~/.bastra/vault matched on a PARENT segment it does not own and
        // chokidar ignored the whole tree: no events, no error, forever.
        // `init()` still looked healthy (walkDir starts inside the root and
        // never sees the parent), which is what made it silent.
        const rel = relative(this.root, p);
        // "" is the root itself; a leading ".." SEGMENT means outside the root
        // (a symlinked or realpath'd hand-back) — neither is ours to filter.
        // The segment boundary is the whole point: `..sync/hidden.md` is a
        // dot-CHILD of the vault, not an escape from it, and a bare
        // `startsWith("..")` would wave it past the dot filter below.
        if (rel === "" || /^\.\.([/\\]|$)/.test(rel)) return false;
        const segments = rel.split(/[/\\]/);
        return segments.some(
          (s) => (s.startsWith(".") && s.length > 1) || s === "node_modules",
        );
      },
    });
    this.watcher.on("add", (p) => {
      if (isMarkdownFile(p)) void this.handleAddOrChange(p, "add");
    });
    this.watcher.on("change", (p) => {
      if (isMarkdownFile(p)) void this.handleAddOrChange(p, "change");
    });
    this.watcher.on("unlink", (p) => {
      if (isMarkdownFile(p)) this.handleRemove(p);
    });
    // #242: FSWatcher is an EventEmitter — an unhandled "error" event kills
    // the process (no uncaughtException handler anywhere in core/daemon).
    // A watcher failure must degrade to the periodic reconcile, not take the
    // daemon down: EMFILE is reachable for a launchd-spawned daemon at the
    // macOS default of 256 descriptors.
    this.watcher.on("error", (err) => {
      console.error(
        `[vault] watcher error — falling back to periodic reconcile: ${(err as Error).message}`,
      );
    });
  }

  /**
   * Force re-read of a single file and emit an add/change event.
   * Use after a known write (e.g. save_memory) so callers don't have to
   * wait for the watcher — which is unreliable on cloud-storage mounts.
   */
  async reindexFile(filePath: string): Promise<void> {
    const existing = this.filePathToId.has(filePath);
    await this.handleAddOrChange(filePath, existing ? "change" : "add");
  }

  /**
   * Reconcile the in-memory index against what's actually on disk and return
   * the corrected count. Walks the tree (stat-level, cheap), *reads* files
   * that aren't indexed yet, drops index entries whose file vanished — and
   * re-reads indexed files whose mtime/size drifted from the values stamped
   * at index time (in-place edits by external processes, #199).
   *
   * Needed because the fs watcher is unreliable on cloud-storage mounts
   * (GoogleDrive/iCloud/Dropbox): adds, deletes/moves, and especially in-place
   * edits done by another process — the Mac app, Obsidian, a second machine —
   * get missed, so the index drifts from reality. Callers that need a
   * trustworthy state (e.g. the `bastra` status panel) call this on demand;
   * it is not on any hot path.
   */
  async reconcile(): Promise<number> {
    const BATCH = 32;
    const scan = await this.listMarkdownFiles();
    this.unreadablePaths = scan.unreadable;
    const onDisk = new Set(scan.files);
    // Drop index entries whose file is gone (missed unlink/move) — aber nur,
    // wenn der Scan überhaupt überall hinsehen konnte. Codex-Gegenreview (P0):
    // Wurde ein Unterordner nach dem Laden unlesbar, war er für den Walk leer,
    // und der Reconcile warf die dort liegenden Memories aus dem Index, obwohl
    // die Dateien unverändert existierten. Ein blinder Fleck darf nichts
    // löschen; er darf nur nichts Neues behaupten.
    if (scan.unreadable.length === 0) {
      for (const filePath of [...this.filePathToId.keys()]) {
        if (!onDisk.has(filePath)) this.handleRemove(filePath);
      }
    } else {
      // Was der Scan gesehen hat, gilt weiter: Nur Dateien, die NICHT unter
      // einem unlesbaren Teilbaum liegen, dürfen als verschwunden gelten.
      for (const filePath of [...this.filePathToId.keys()]) {
        if (onDisk.has(filePath)) continue;
        if (scan.unreadable.some((dir) => filePath.startsWith(dir + sep))) continue;
        this.handleRemove(filePath);
      }
    }
    // Read files not yet indexed (handleAddOrChange silently skips non-memory).
    const toAdd = [...onDisk].filter((p) => !this.filePathToId.has(p));
    for (let i = 0; i < toAdd.length; i += BATCH) {
      await Promise.all(
        toAdd.slice(i, i + BATCH).map((p) => this.handleAddOrChange(p, "add")),
      );
    }
    // Heal in-place edits: stat-compare every indexed file against the values
    // remembered at read time; on drift, re-read. Freshly added files above
    // were just stamped, so they cost one matching stat and nothing more.
    const indexed = [...this.filePathToId.keys()];
    for (let i = 0; i < indexed.length; i += BATCH) {
      await Promise.all(
        indexed.slice(i, i + BATCH).map(async (p) => {
          try {
            const st = await stat(p);
            const known = this.fileStats.get(p);
            if (!known || known.mtimeMs !== st.mtimeMs || known.size !== st.size) {
              await this.reindexFile(p);
            }
          } catch {
            /* vanished between walk and stat — the next reconcile drops it */
          }
        }),
      );
    }
    return this.memorys.size;
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = undefined;
  }

  on(listener: VaultListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Drop a file's index entry without touching disk — for callers that moved
   * or trashed the file themselves (e.g. a convention-driven re-file on save)
   * and can't wait for the cloud-unreliable watcher to notice the unlink.
   */
  forgetFile(filePath: string): void {
    this.handleRemove(filePath);
  }

  list(): Memory[] {
    return [...this.memorys.values()];
  }

  get(id: string): Memory | undefined {
    return this.memorys.get(id);
  }

  /**
   * Alle Pfade, die diese id tragen — der indexierte zuerst, dann die
   * quarantänisierten. Leer, wenn die id unbekannt ist.
   *
   * Wer schreiben will, muss das fragen können: `get()` allein verschweigt,
   * dass es eine zweite Datei gibt, und ein Save auf die eine lässt die
   * andere unverändert stehen (#240/A2.3).
   */
  /** Die blinden Flecken des letzten Scans. Leer heißt: der Index kennt den
   *  ganzen Baum. Nicht leer heißt: er kann für KEINE id `none` belegen. */
  scanBlindSpots(): string[] {
    return [...this.unreadablePaths, ...this.unreadableFiles];
  }

  pathsFor(id: string): string[] {
    const out: string[] = [];
    const indexed = this.memorys.get(id);
    if (indexed) out.push(indexed.filePath);
    for (const p of this.duplicatePaths.get(id) ?? []) {
      if (!out.includes(p)) out.push(p);
    }
    return out;
  }

  private rememberDuplicate(id: string, filePath: string): void {
    const set = this.duplicatePaths.get(id);
    if (set) set.add(filePath);
    else this.duplicatePaths.set(id, new Set([filePath]));
  }

  private forgetDuplicate(filePath: string): void {
    for (const [id, set] of this.duplicatePaths) {
      if (!set.delete(filePath)) continue;
      if (set.size === 0) this.duplicatePaths.delete(id);
      return;
    }
  }

  size(): number {
    return this.memorys.size;
  }

  // ─── internals ───────────────────────────────────────────────

  private async listMarkdownFiles(): Promise<{ files: string[]; unreadable: string[] }> {
    const files: string[] = [];
    const unreadable: string[] = [];
    await this.walkDir(this.root, files, unreadable);
    return { files, unreadable };
  }

  /**
   * Traversierung mit Buchführung über die blinden Flecken.
   *
   * Codex-Gegenreview (P0): Ein `readdir`-Fehler wurde geschluckt, und der
   * unlesbare Teilbaum sah damit exakt aus wie ein leerer. Zwei nachgestellte
   * Folgen: Ein vor `init()` unlesbar gemachtes Verzeichnis enthielt bereits
   * eine id — der Vault sah sie nicht und ließ ein zweites Memory mit
   * derselben id zu. Und wurde ein Ordner NACH dem Laden unlesbar, entfernte
   * `reconcile()` die dortigen Memories aus dem Index, obwohl die Dateien noch
   * existierten. „Nicht lesbar" ist keine Aussage über den Inhalt.
   */
  private async walkDir(dir: string, out: string[], unreadable: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      // Verschwunden ist kein blinder Fleck (paralleles Aufräumen); alles
      // andere — EACCES, EIO, ein hängender Cloud-Mount — schon.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") unreadable.push(dir);
      return;
    }
    for (const e of entries) {
      // Skip noise that almost never holds memorys
      if (e.name.startsWith(".") && e.name.length > 1) continue;
      if (e.name === "node_modules") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await this.walkDir(full, out, unreadable);
      } else if (e.isFile() && isMarkdownFile(e.name)) {
        out.push(full);
      }
    }
  }

  private async read(filePath: string): Promise<Memory> {
    // The I/O sits in its own try so callers can tell "the file says it is no
    // longer a memory" from "the file could not be read". Both used to arrive
    // as one anonymous error, and treating them alike made a transient
    // ENOENT/EIO evict a perfectly good memory from the index.
    let raw: string;
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      [raw, st] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
    } catch (err) {
      throw new VaultIOError(filePath, err as Error);
    }
    const m = parseMemoryWith(
      (input) => matter(input),
      raw,
      filePath,
      st.mtimeMs,
    );
    // only stamped for real memories (parse throws on plain notes) — the
    // drift check in reconcile() runs over indexed files exclusively
    this.fileStats.set(filePath, { mtimeMs: st.mtimeMs, size: st.size });
    return m;
  }

  private async handleAddOrChange(
    filePath: string,
    kind: "add" | "change",
  ): Promise<void> {
    try {
      const m = await this.read(filePath);
      // #240/A2.3 add-half: init quarantines a second path with the same id.
      // reconcile() treats "not in filePathToId" as new and used to emit add,
      // which overwrote the winner in the map and crashed MiniSearch
      // (`duplicate ID`) on every tick. A second path must not steal the
      // claim. If the winner is gone, handleRemove already dropped it, and
      // this path is free to take the id — that is how a leftover conflict
      // copy becomes the memory.
      const claimed = this.memorys.get(m.fm.id);
      if (claimed && claimed.filePath !== filePath) {
        // #355 follow-up: the skip fires before the A2.1 block below, so a
        // file this vault knew under ANOTHER id — and whose id was just
        // edited onto a claimed one — kept its old node in the map and in
        // BM25 with the pre-edit body, while the file on disk no longer
        // carried that id. Drop the file's old claim first (handleRemove
        // already knows whether this path owns it and emits the remove);
        // for a path that was never indexed this is a no-op.
        this.handleRemove(filePath);
        this.rememberDuplicate(m.fm.id, filePath);
        if (!this.duplicateSkipLogged.has(filePath)) {
          this.duplicateSkipLogged.add(filePath);
          console.warn(
            `[vault] ${kind} skipped (${basename(filePath)}): ` +
              duplicateIdSkipMessage(m.fm.id, claimed.filePath),
          );
        }
        return;
      }
      // #240/A2.1: If the id changed, the vault dropped the old mapping but
      // emitted only `change(new)` — so SearchIndex and EmbeddingIndex never
      // learned the old id must go. The stale entry outlived reconcile() and
      // recall kept returning an id that load_memory could no longer resolve.
      // Emit the removal first so every downstream index sees both halves.
      const oldId = this.filePathToId.get(filePath);
      if (oldId && oldId !== m.fm.id) {
        this.memorys.delete(oldId);
        this.emit({ kind: "remove", id: oldId, filePath });
      }
      // Codex-Gegenreview (P1): Eine Datei, die als Duplikat quarantänisiert
      // war und danach eine ANDERE id bekam, blieb mit ihrem alten Pfad im
      // Duplicate-Set stehen. Danach erschien sie unter beiden ids —
      // `pathsFor(alt)` nannte sie weiter, obwohl sie diese id nicht mehr
      // trägt, und blockierte damit jeden Save auf die alte id als
      // vermeintliches `ambiguous`. Wer erfolgreich indexiert wird, ist per
      // Definition kein quarantänisiertes Duplikat mehr.
      this.forgetDuplicate(filePath);
      this.unreadableFiles.delete(filePath);
      this.memorys.set(m.fm.id, m);
      this.filePathToId.set(filePath, m.fm.id);
      // A file this vault already knows under the same id is a CHANGE, whatever
      // the caller asked for. The save path indexes its own write immediately
      // (reindexFile — the watcher is unreliable on cloud mounts) and chokidar
      // then reports the very same file as a fresh "add"; passing that through
      // announced one new memory twice. The map's topbar counter follows add
      // events, so every save bumped it by +2 and only a reload corrected it.
      const settled = kind === "add" && oldId === m.fm.id ? "change" : kind;
      this.emit({ kind: settled, memory: m });
    } catch (err) {
      // An operational failure says nothing about the CONTENT — the file may
      // be perfectly valid and merely unreadable right now (cloud placeholder
      // not materialised, a write in flight, EACCES, EIO). Keep the
      // last-known-good node and let the watcher or the periodic reconcile
      // retry; a real deletion still arrives as `unlink` → handleRemove.
      if (err instanceof VaultIOError) {
        this.unreadableFiles.add(filePath);
        console.error(
          `[vault] ${kind} could not read ${basename(filePath)} (${err.cause.message}) — ` +
            `keeping the last indexed version, will retry`,
        );
        return;
      }
      // #240/A2.2: A file that stopped being a memory — turned into a plain
      // note, or its YAML broke during an Obsidian edit — used to leave the
      // LAST VALID node in the index forever. Recall then served pre-edit
      // content as current. Drop the node and say so; the file stays on disk
      // and is re-indexed as soon as it parses again. Reached only after a
      // SUCCESSFUL read, so the content really is the problem.
      const staleId = this.filePathToId.get(filePath);
      if (staleId) {
        this.memorys.delete(staleId);
        this.filePathToId.delete(filePath);
        this.fileStats.delete(filePath);
        this.emit({ kind: "remove", id: staleId, filePath });
        console.error(
          `[vault] ${basename(filePath)} no longer parses as a memory — ` +
            `dropped '${staleId}' from the index until it is valid again` +
            (err instanceof NotAMemoryFile ? "" : `: ${(err as Error).message}`),
        );
        return;
      }
      // Silent on plain notes; loud only on actual schema breakage.
      if (err instanceof NotAMemoryFile) return;
      console.error(
        `[vault] ${kind} skipped (${basename(filePath)}): ${(err as Error).message}`,
      );
    }
  }

  private handleRemove(filePath: string): void {
    this.fileStats.delete(filePath);
    this.unreadableFiles.delete(filePath);
    this.duplicateSkipLogged.delete(filePath);
    // Eine gelöschte Datei ist kein Duplikat mehr — sonst meldete der Locator
    // `ambiguous` für einen Zustand, den es nicht mehr gibt, und blockierte
    // jeden Save auf diese id.
    this.forgetDuplicate(filePath);
    const id = this.filePathToId.get(filePath);
    if (!id) return;
    this.filePathToId.delete(filePath);
    // #240/A2.3: only drop the memory if THIS path still owns the id. Two
    // files can carry the same id (cloud-sync conflict copies, a re-file
    // whose trash step failed). Removing the shadowed one used to delete the
    // winner from the index while its file sat untouched on disk — the
    // memory vanished from recall and only a daemon restart brought it back.
    const owner = this.memorys.get(id);
    if (owner && owner.filePath !== filePath) return;
    this.memorys.delete(id);
    this.emit({ kind: "remove", id, filePath });
  }

  private emit(e: VaultEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        console.error("[vault] listener error:", err);
      }
    }
  }
}

function duplicateIdSkipMessage(id: string, claimedBy: string): string {
  return (
    `duplicate id '${id}' — already claimed by ${claimedBy}. ` +
    `Not indexed. Give one of the two files a different id (a cloud-sync ` +
    `conflict copy is the usual cause).`
  );
}
