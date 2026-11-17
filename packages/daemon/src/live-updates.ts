/**
 * Live updates (#216, #234) — a lossless event log of vault activity, fed by
 * the vault watcher (+ the load path for "read"), polled by the map
 * (`GET /ui/updates?since=<seq>`). The universe view turns "add" entries into
 * supernovae; every kind lands as a notice card + session history.
 *
 * Deliberately a poll, not a push: one tiny JSON answer every few seconds beats
 * a standing event-stream connection for exactly one consumer, and the buffer
 * is bounded so an import burst can't grow memory.
 *
 * Two guarantees (#234):
 *   1. Coalescing — rapid events on the SAME memory (an agent re-reading it, a
 *      save → enrich → reindex burst) collapse into ONE entry that finalizes
 *      after DEBOUNCE_MS of quiet for that id, carrying a `count` (×N).
 *      DIFFERENT memories never collapse together — each keeps its own timer.
 *      MAX_WAIT_MS caps how long that window may be re-armed: a memory an
 *      enricher touches faster than the window used to be held back FOREVER —
 *      no notice, no supernova, and the topbar counter (webui bumpCounter)
 *      stopped following the vault. The cap keeps the ×N guarantee and only
 *      bounds the delay.
 *   2. Lossless delivery — every finalized entry gets a monotone `seq`; the
 *      client polls with the last seq it saw and receives every entry with a
 *      higher seq. The ring buffer is large and never age-drops undelivered
 *      entries; if it truly overflows, the smallest surviving seq jumps past
 *      the client's cursor, which the client detects (minSeq > since + 1) and
 *      surfaces honestly as "+N older changes" instead of silently dropping.
 *
 * Kinds (hottest wins while coalescing): delete > add > change > read.
 *   - add     — new memory (→ supernova). Survives a following enrich burst.
 *   - change  — edited memory.
 *   - delete  — removed memory; title/cluster from the last known snapshot.
 *   - read    — load_memory touched it. Weakest; never masks a hotter kind.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { clusterKeyFor, groupKeyFor, subKeyFor, type Memory, type Vault } from "@bastra-recall/core";
import { sendJsonPlain } from "./webui.js";
import { getUiEnabled } from "./settings.js";
import { envInt } from "./env.js";
import type { RecallBand } from "./telemetry.js";
import { hiddenFromCaller } from "./private-access.js";

export type LiveUpdateKind = "add" | "change" | "delete" | "read";

export interface LiveUpdate {
  id: string;
  kind: LiveUpdateKind;
  title: string;
  type: string;
  scope: string;
  cluster: string;
  /**
   * #307: the FULL grouping coordinate, not just the cluster.
   *
   * The map fetches the graph projection (buildGraph) once at load, and every
   * node in it carries cluster + group + sub. A live entry used to carry the
   * cluster alone, so a memory adopted from the live path was filed under the
   * fallbacks "other"/"general" — wrong building block, wrong sub-area, and no
   * way for the client to place a grouping that did not exist yet. Same
   * derivation as buildGraph, so a live node and a reloaded node agree.
   */
  group: string;
  sub: string;
  summary: string;
  at: number; // ms epoch when the entry finalized
  seq: number; // monotone delivery cursor (#234); assigned on finalize
  count: number; // events coalesced into this entry (×N), ≥ 1
  /** #217 Valenz: der Newborn soll sofort mit Emotionsfarbe glühen — die Map
   *  adoptiert ihn als echten Node, ohne auf den Graph-Reload zu warten. */
  salience?: number;
  emotion?: string;
  /** #221: bei einer recall-getriebenen "read"-Notice das Band, in dem der
   *  Treffer serviert wurde (`required` | `optional`). Fehlt bei load_memory
   *  und bei allen Vault-Ereignissen. */
  band?: RecallBand;
}

/** Ring buffer size PER VISIBILITY — lossless within realistic poll gaps.
 *  #1605: private and public entries each get their own share, so a burst of
 *  private activity can never push out entries a caller without private
 *  access has not fetched yet. */
const MAX_ENTRIES = 500;
const DEBOUNCE_MS = 600; // quiet window per memory id before an entry finalizes
/**
 * Hard ceiling on the quiet window, measured from an entry's FIRST event.
 *
 * Without it the window re-armed on every follow-up event with no bound, so a
 * memory under steady write load (an enricher, a reindexer) never finalized at
 * all — no notice, no supernova, and the topbar counter silently stopped
 * following the vault. Distinct from REANNOUNCE_MS below: that one throttles
 * how often the SAME id may be announced again, this one bounds how long ONE
 * announcement may be held back. Events arriving after the cap open a fresh
 * window, so the ×N coalescing guarantee is unharmed.
 */
const MAX_WAIT_MS = 1500;
/**
 * #221: Wiederankündigungs-Sperre pro id. Recall ist der mit Abstand
 * häufigste Pfad — dieselbe Memory taucht über eine Arbeitssitzung dutzendfach
 * in den Top-Treffern auf. Die Debounce-Fenster fangen das NICHT: sie
 * kollabieren nur Bursts innerhalb von Sekunden, während Recalls minutenlang
 * auseinander liegen und so jedes Mal eine neue Karte erzeugen würden. Ein
 * Vault-Ereignis (add/change/delete) ist davon nie betroffen — was der Nutzer
 * tatsächlich ändert, wird immer angekündigt.
 *
 * 180s ist gesetzt, nicht gemessen — die ehrliche Zahl wäre der Median-Abstand
 * zwischen zwei Surfacings derselben id, den die Telemetrie beantworten kann.
 * Bis dahin env-tunbar wie die übrigen Fenster, damit die Vorgabe kein Dogma
 * ist. Die Notices selbst sind bewusst DEFAULT AN: ein Feature, das man erst
 * einschalten muss, wird nie eingeschaltet.
 */
const REANNOUNCE_MS = envInt("BASTRA_REANNOUNCE_MS", 180_000);

// hotness rank for coalescing — a hotter kind seen in the window wins the entry
const KIND_RANK: Record<LiveUpdateKind, number> = { read: 0, change: 1, add: 2, delete: 3 };

interface PendingEntry {
  update: LiveUpdate; // hottest kind so far + the latest event's data
  count: number;
  timer: ReturnType<typeof setTimeout>;
  firstAt: number; // when this window opened — the max-wait cap measures from here
  hidden: boolean; // any event in the window came from a private memory
}

export function createLiveUpdates(
  vault: Vault,
  opts: {
    debounceMs?: number;
    maxEntries?: number;
    reannounceMs?: number;
    maxWaitMs?: number;
  } = {}
): {
  handleUiUpdates: (
    req: IncomingMessage,
    res: ServerResponse,
    settingsPath?: string,
    showPrivate?: boolean
  ) => Promise<void>;
  notifyRead: (id: string, band?: RecallBand) => void;
  stop: () => void;
} {
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  const reannounceMs = opts.reannounceMs ?? REANNOUNCE_MS;
  const maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS;

  const recent: LiveUpdate[] = []; // finalized entries, ascending seq
  const pending = new Map<string, PendingEntry>();
  /** id → ms epoch der letzten finalisierten Notice (Sperre für "read"). */
  const announcedAt = new Map<string, number>();
  let seq = 0;
  let hiddenCount = 0;
  /** Highest seq ever dropped from the buffer — the owner's gap signal. */
  let droppedSeq = 0;
  // A caller who may not see private entries gets its own cursor, counted over
  // the visible entries alone, so a gap in `seq` never reveals that private
  // activity happened (contributor audit). The proven owner keeps `seq`.
  let publicSeq = 0;
  const publicSeqOf = new WeakMap<LiveUpdate, number>();
  // Private memories reach only a caller whose account was proven, like the
  // graph (`privateGraph`). Seeded from the index so a later delete of a memory
  // that was never announced still knows it was private.
  const privateIds = new Set(
    vault
      .list()
      .filter((m) => hiddenFromCaller(undefined, m.fm))
      .map((m) => m.fm.id)
  );
  const hiddenEntries = new WeakSet<LiveUpdate>();
  const hiddenMemory = (m: Memory): boolean => {
    const hidden = hiddenFromCaller(undefined, m.fm);
    if (hidden) privateIds.add(m.fm.id);
    else privateIds.delete(m.fm.id);
    return hidden;
  };

  const baseFields = (m: Memory, kind: LiveUpdateKind): LiveUpdate => ({
    id: m.fm.id,
    kind,
    title: m.fm.title,
    type: m.fm.type,
    scope: m.fm.scope,
    cluster: clusterKeyFor(m, vault.root),
    group: groupKeyFor(m, vault.root),
    sub: subKeyFor(m, vault.root),
    summary: m.fm.summary,
    at: Date.now(),
    seq: 0, // assigned on finalize
    count: 1, // accumulated on finalize
    ...(typeof m.fm.salience === "number" ? { salience: m.fm.salience } : {}),
    ...(m.fm.emotion ? { emotion: m.fm.emotion } : {}),
  });

  const finalize = (id: string): void => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    const entry = { ...p.update, seq: ++seq, count: p.count };
    if (p.hidden) hiddenEntries.add(entry);
    else publicSeqOf.set(entry, ++publicSeq);
    recent.push(entry);
    if (p.hidden) hiddenCount += 1;
    const share = p.hidden ? hiddenCount : recent.length - hiddenCount;
    if (share > maxEntries) dropOldest(p.hidden);
    // Sperrfenster startet erst beim Finalisieren — die Karte ist ab JETZT
    // sichtbar, also läuft die Ruhe ab jetzt und nicht ab dem ersten Ereignis.
    const now = Date.now();
    announcedAt.set(id, now);
    // Der Vault ist endlich, die Map also ohnehin klein; trotzdem nie
    // unbegrenzt wachsen lassen (Importe legen tausende ids an).
    if (announcedAt.size > maxEntries * 4) {
      for (const [key, at] of announcedAt) {
        if (now - at > reannounceMs) announcedAt.delete(key);
      }
    }
  };

  /** Evicts the oldest entry of one visibility; the other share is untouched. */
  const dropOldest = (hidden: boolean): void => {
    const index = recent.findIndex((e) => hiddenEntries.has(e) === hidden);
    droppedSeq = Math.max(droppedSeq, recent[index].seq);
    if (hidden) hiddenCount -= 1;
    recent.splice(index, 1);
  };

  // Collapse an event into the pending entry for its id (or open one) and
  // (re)arm the quiet-window timer. Nothing is delivered until the window
  // elapses — that is what turns a burst into one finalized entry.
  const ingest = (next: LiveUpdate, hidden: boolean): void => {
    const cur = pending.get(next.id);
    if (cur) {
      clearTimeout(cur.timer);
      cur.hidden ||= hidden;
      // keep the hotter kind (newborn stays "add" through its enrich burst; a
      // delete always wins), take the rest of the data from the latest event
      const kind = KIND_RANK[next.kind] >= KIND_RANK[cur.update.kind] ? next.kind : cur.update.kind;
      cur.update = { ...next, kind };
      cur.count += 1;
      // Re-arming is what collapses a burst — but only up to maxWaitMs after
      // the FIRST event (see MAX_WAIT_MS). Past the ceiling the entry ships
      // immediately; anything after it opens a fresh window.
      const remaining = maxWaitMs - (Date.now() - cur.firstAt);
      if (remaining <= 0) {
        finalize(next.id);
        return;
      }
      cur.timer = setTimeout(() => finalize(next.id), Math.min(debounceMs, remaining));
    } else {
      pending.set(next.id, {
        update: next,
        count: 1,
        timer: setTimeout(() => finalize(next.id), debounceMs),
        firstAt: Date.now(),
        hidden,
      });
    }
  };

  /** A removed memory is gone from the index; its last known entry or the
   *  seeded private set still says whether it was private. */
  const removedWasPrivate = (id: string, prior: LiveUpdate | undefined): boolean => {
    const known = privateIds.delete(id);
    return known || pending.get(id)?.hidden === true || (prior !== undefined && hiddenEntries.has(prior));
  };

  const unsubscribe = vault.on((e) => {
    if (e.kind === "add") ingest(baseFields(e.memory, "add"), hiddenMemory(e.memory));
    else if (e.kind === "change") ingest(baseFields(e.memory, "change"), hiddenMemory(e.memory));
    else if (e.kind === "remove") {
      // das File ist weg — Titel/Cluster aus dem letzten bekannten Snapshot
      // (noch pending, sonst der jüngste finalisierte Eintrag der id)
      let prior = pending.get(e.id)?.update;
      for (let i = recent.length - 1; !prior && i >= 0; i--) {
        if (recent[i].id === e.id) prior = recent[i];
      }
      const hidden = removedWasPrivate(e.id, prior);
      ingest(
        {
          id: e.id,
          kind: "delete",
          title: prior?.title ?? e.id,
          type: prior?.type ?? "memory",
          scope: prior?.scope ?? "",
          cluster: prior?.cluster ?? "",
          group: prior?.group ?? "",
          sub: prior?.sub ?? "",
          summary: prior?.summary ?? "",
          at: Date.now(),
          seq: 0,
          count: 1,
        },
        hidden
      );
    }
  });

  /**
   * "read"-Notice vom load_memory-Pfad und — seit #221 — von jedem Recall,
   * dessen Treffer über dem Floor serviert wurde (`band`).
   *
   * Recall-Notices sind pro id gesperrt (REANNOUNCE_MS): dieselbe Memory
   * gehört über eine Sitzung hinweg immer wieder zu den Top-Treffern, und
   * ohne Sperre wäre die Karte eine Endlosschleife derselben drei Titel.
   * Läuft schon ein Fenster für die id, zählt das Ereignis dort als ×N mit —
   * das ist Coalescing, keine neue Karte, und wird deshalb nie gesperrt.
   */
  const notifyRead = (id: string, band?: RecallBand): void => {
    try {
      if (!pending.has(id)) {
        const last = announcedAt.get(id);
        if (last !== undefined && Date.now() - last < reannounceMs) return;
      }
      const m = vault.get(id);
      if (m) ingest({ ...baseFields(m, "read"), ...(band ? { band } : {}) }, hiddenMemory(m));
    } catch {
      /* Notices sind Telemetrie-of-Telemetrie — nie einen Load brechen */
    }
  };

  async function handleUiUpdates(
    req: IncomingMessage,
    res: ServerResponse,
    settingsPath?: string,
    showPrivate = false
  ): Promise<void> {
    if (!(await getUiEnabled(settingsPath))) {
      sendJsonPlain(res, 404, { error: "ui disabled" });
      return;
    }
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const sinceRaw = u.searchParams.get("since");
    const view = showPrivate ? ownerView() : publicView();
    if (sinceRaw === null) {
      // no cursor yet → baseline the client to the high-water mark without
      // replaying history (matches the old "only events after opening" contract)
      sendJsonPlain(res, 200, { updates: [], seq: view.seq, minSeq: view.minSeq });
      return;
    }
    const since = Number(sinceRaw) || 0;
    const updates = view.entries.filter((e) => e.seq > since);
    sendJsonPlain(res, 200, { updates, seq: view.seq, minSeq: view.minSeq });
  }

  /** Every entry under the full cursor. An eviction can leave a hole between
   *  surviving entries (#1605), so minSeq starts after the newest dropped seq:
   *  a cursor before it learns that changes were lost instead of missing them. */
  function ownerView(): { entries: LiveUpdate[]; seq: number; minSeq: number } {
    const oldest = recent.length > 0 ? recent[0].seq : seq;
    return { entries: recent, seq, minSeq: Math.max(oldest, droppedSeq + 1) };
  }

  /** Visible entries only, renumbered by their own cursor. */
  function publicView(): { entries: LiveUpdate[]; seq: number; minSeq: number } {
    const entries = recent.flatMap((e) => {
      const visibleSeq = publicSeqOf.get(e);
      return visibleSeq === undefined ? [] : [{ ...e, seq: visibleSeq }];
    });
    return { entries, seq: publicSeq, minSeq: entries.length > 0 ? entries[0].seq : publicSeq };
  }

  const stop = (): void => {
    unsubscribe();
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
  };

  return { handleUiUpdates, notifyRead, stop };
}
