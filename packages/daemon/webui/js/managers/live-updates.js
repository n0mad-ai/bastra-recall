/** Live updates (#216) — an on/off live mode for the map: the daemon buffers
 *  vault events (GET /ui/updates), this manager polls every few seconds and
 *  turns them into notices. "add" additionally becomes a supernova in the
 *  universe view + an adopted real sim node; "change" patches the node live,
 *  "delete" hides it, "read" is a pure notice.
 *
 *  Every notice also lands in the SESSION HISTORY — toggled via the topbar
 *  clock button (#live-history-toggle), so vanished cards stay reviewable.
 *
 *  Toggle lives in the topbar (#live-toggle), state persists in localStorage.
 *  Polling only runs while the toggle is on.
 *
 *  @param {object} deps
 *  @param {object} deps.orbitView          spawnBurst/focusBurst/renderBursts
 *  @param {object} deps.sim                simulation (nodes/byId, cluster anchors)
 *  @param {object} deps.renderer           overlay hook
 *  @param {() => string} deps.getView      current view key
 *  @param {(v: string) => void} deps.switchView  jump to the universe on card click
 *  @param {(id: string) => void} deps.openMemory open the memory in the inspector
 *  @param {(u: object) => void} deps.adoptNode   add the newborn as a real sim node */

import { drawBurstAt, BURST_LIFE } from "./orbit-view.js";
import { createLiveDeck } from "./live-deck.js";
import { createMemoryCounter } from "./memory-counter.js";
import { KIND_META } from "./live-kinds.js";
import { createTickRail } from "../components/tick-rail.js";

const $ = (sel) => document.querySelector(sel);
const LIVE_KEY = "bastra-vault-map-live";
// The poll is the second half of the live latency (the first is the quiet
// window in the daemon, live-updates.ts). At 5 s a fresh memory felt like it
// arrived ten seconds late — dead, for a display you watch out of the corner
// of your eye while working. A tiny JSON answer against localhost carries the
// shorter interval without trouble.
const POLL_MS = 1500;
const CARD_LIFE_MS = 120000; // matches the burst lifetime
const MAX_CARDS_PER_POLL = 4;
const HISTORY_MAX = 300;
const REPLAY_LIFE_MS = 3000; // history click: a short re-flare, not a new event

export function createLiveUpdates(deps) {
  const toggle = $("#live-toggle");
  const cardsEl = $("#live-cards");
  const historyBtn = $("#live-history-toggle");
  const historyEl = $("#live-history");
  const historyList = $("#live-history-list");
  const historyCount = $("#live-history-count");
  // Dieselbe Leiste wie am Notice-Deck (components/tick-rail.js), nur auf die
  // Historie angewandt: die native Scrollbar ist ausgeblendet, die Position
  // steht links als Marken. Gedeckelt, weil eine Session dreistellig viele
  // Zeilen bekommen kann und eine Marke pro Zeile eine Wand wäre.
  const historyRail = createTickRail({
    railEl: $("#live-history-ticks"),
    scrollEl: historyList,
    maxTicks: 24,
  });
  let on = (localStorage.getItem(LIVE_KEY) ?? "on") === "on";
  let sinceSeq = null; // last delivery seq we've seen; null → not yet baselined
  let pollTimer = 0;
  let inFlight = false; // one poll at a time — see the note in poll()
  const history = []; // session-scope, newest first
  let cardDepth = 0; // rising z-index so the newest card tops the deck
  // deck presentation (overlap limit, "+N", the left tick rail) lives apart —
  // this manager decides WHAT is announced, live-deck.js how the pile looks
  const deck = createLiveDeck({ cardsEl });

  function render() {
    toggle.classList.toggle("on", on);
    toggle.title = on
      ? "Live updates ON — new memories appear as supernovae. Click to turn off."
      : "Live updates OFF — click to watch new memories appear live.";
  }

  // ── session history ────────────────────────────────────────────────
  const timeOf = (ms) =>
    new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  function recordHistory(u) {
    history.unshift({ ...u, seenAt: Date.now() });
    if (history.length > HISTORY_MAX) history.pop();
    historyCount.textContent = String(history.length);
    historyCount.hidden = history.length === 0;
    if (!historyEl.hidden) renderHistory();
  }

  /** Bolt replay (#217): clicking an event fires the same flare, neighbour
   *  bolts included, once more. Used by BOTH surfaces that show an event — the
   *  notice card and the history row — so a click means the same thing in
   *  either place. A past event is then not just re-readable but findable
   *  again on the map: the row says WHAT happened, the bolt says WHERE.
   *
   *  Shorter than the original (REPLAY_LIFE_MS): this is a look-up, not a new
   *  event, and should not feel like one. If the node does not (or no longer)
   *  exist — deleted, or the history outlived a graph reload — nothing
   *  happens. */
  function replayFlash(h) {
    if (!deps.sim.byId.has(h.id)) return;
    // `add` deliberately carries no flash colour: on the live path a birth is
    // the supernova, not a flare. By look-up time that star has long burned
    // out, so the replay borrows the theme's accent instead.
    const color =
      KIND_META[h.kind]?.flash ??
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    deps.renderer.flashNode?.(h.id, color, REPLAY_LIFE_MS);
  }

  function renderHistory() {
    if (history.length === 0) {
      const empty = document.createElement("div");
      empty.className = "lh-empty";
      empty.textContent = "no live events this session yet";
      historyList.replaceChildren(empty);
      historyRail.update(0);
      return;
    }
    historyList.replaceChildren(
      ...history.map((h) => {
        const meta = KIND_META[h.kind] ?? KIND_META.add;
        const row = document.createElement("div");
        row.className = `lh-row kind-${h.kind}`;
        const icon = document.createElement("span");
        icon.className = "lh-kind-icon";
        icon.textContent = meta.icon;
        const label = document.createElement("span");
        label.className = "lh-kind";
        label.textContent = meta.label;
        const title = document.createElement("span");
        title.className = "lh-title";
        title.textContent = h.count > 1 ? `${h.title} ×${h.count}` : h.title;
        title.title = h.title;
        const time = document.createElement("span");
        time.className = "lh-time";
        time.textContent = timeOf(h.seenAt);
        row.append(icon, label, title, time);
        if (h.kind !== "delete") {
          row.addEventListener("click", () => {
            replayFlash(h);
            deps.openMemory?.(h.id, h);
          });
        }
        return row;
      }),
    );
    historyRail.update(history.length);
  }

  historyBtn.addEventListener("click", () => {
    historyEl.hidden = !historyEl.hidden;
    historyBtn.classList.toggle("open", !historyEl.hidden);
    if (!historyEl.hidden) {
      renderHistory();
      // Erst nach dem Einblenden hat die Liste eine Höhe — vorher misst die
      // Leiste ein Panel, das noch 0 hoch ist, und rechnet ihren Abstand falsch.
      requestAnimationFrame(() => historyRail.paint(history.length));
    }
  });

  historyList.addEventListener("scroll", () => {
    if (historyRail.sync(history.length)) historyRail.paint(history.length);
  });

  // Same as the deck: the rail marks the row under the cursor, not just the
  // scroll position. With a few hundred rows the marks are a scale, so several
  // rows share one — the rail component maps that.
  historyList.addEventListener("pointerover", (ev) => {
    const row = ev.target.closest(".lh-row");
    const rows = [...historyList.querySelectorAll(".lh-row")];
    historyRail.setHover(row ? rows.indexOf(row) : null, history.length);
  });
  historyList.addEventListener("pointerleave", () => historyRail.setHover(null, history.length));

  // ── notice cards ───────────────────────────────────────────────────
  function card(entry) {
    const meta = KIND_META[entry.kind] ?? KIND_META.add;
    const li = document.createElement("div");
    li.className = `live-card kind-${entry.kind}`;
    const head = document.createElement("div");
    head.className = "live-head";
    const star = document.createElement("span");
    star.className = "live-star";
    star.textContent = meta.icon;
    const label = document.createElement("span");
    label.className = "live-label";
    label.textContent = meta.label;
    const age = document.createElement("span");
    age.className = "live-age";
    age.dataset.born = String(Date.now());
    age.textContent = "0s";
    const close = document.createElement("button");
    close.className = "live-close";
    close.textContent = "×";
    close.addEventListener("click", (ev) => {
      ev.stopPropagation();
      li.remove();
    });
    head.append(star, label);
    if (entry.count > 1) {
      // burst collapsed into one entry — show how many events it stands for
      const count = document.createElement("span");
      count.className = "live-count";
      count.textContent = `×${entry.count}`;
      head.append(count);
    }
    head.append(age, close);
    const title = document.createElement("div");
    title.className = "live-title";
    title.textContent = entry.title;
    const meta2 = document.createElement("div");
    meta2.className = "live-meta";
    meta2.textContent = [entry.type, entry.cluster].filter(Boolean).join(" · ");
    li.append(head, title, meta2);
    if (entry.summary) {
      const summary = document.createElement("div");
      summary.className = "live-summary";
      summary.textContent = entry.summary;
      li.append(summary);
    }
    if (entry.kind !== "delete") {
      li.addEventListener("click", () => {
        if (entry.kind === "add") {
          const wasOrbit = deps.getView() === "orbit";
          if (!wasOrbit) deps.switchView("orbit");
          // after a view switch the flight needs a beat before refocusing —
          // and the bolt has to wait for the same beat, or it fires while the
          // old view is still on screen and is simply not seen
          setTimeout(() => {
            deps.orbitView.focusBurst(entry.id);
            replayFlash(entry);
            deps.openMemory?.(entry.id, entry);
          }, wasOrbit ? 0 : 1100);
        } else {
          // der Eintrag trägt `cluster` — openMemory adoptiert damit ein
          // Memory, das erst nach dem Seiten-Load entstanden ist, und fliegt
          // es an, statt nur den Inspector zu öffnen
          replayFlash(entry);
          deps.openMemory?.(entry.id, entry);
        }
      });
    }
    // The deck stacks newest-on-top (live.css). Cards are PREPENDED, so paint
    // order alone would put the oldest in front — a rising counter puts the
    // newest arrival above everything already on the pile.
    li.style.zIndex = String(++cardDepth);
    cardsEl.prepend(li);
    deck.sync();
    setTimeout(() => {
      li.classList.add("fade");
      setTimeout(() => {
        li.remove();
        deck.sync();
      }, 900);
    }, CARD_LIFE_MS);
  }

  // topbar memory counter: ±1 per birth/death for the immediate reaction, with
  // /health.vault_size as the authority behind it (#294). The arithmetic and
  // the reconcile cadence live in memory-counter.js; this is just the DOM.
  const counter = createMemoryCounter({
    read: () => {
      const el = $("#stat-count");
      if (!el) return null;
      const cur = parseInt(el.textContent, 10);
      return Number.isNaN(cur) ? null : cur;
    },
    write: (n) => {
      const el = $("#stat-count");
      if (!el) return;
      el.textContent = `${n} memories`;
      el.classList.remove("bump");
      void el.offsetWidth; // restart the animation
      el.classList.add("bump");
    },
    fetchSize: async () => {
      const res = await fetch("/ui/health");
      if (!res.ok) return null;
      const data = await res.json();
      return typeof data.vault_size === "number" ? data.vault_size : null;
    },
    // ~30 s at POLL_MS. Slow on purpose: this corrects drift, it does not
    // deliver the news — the deltas already do that within one poll.
    reconcileEveryPolls: Math.round(30000 / POLL_MS),
  });

  function summaryCard(count, older = false, text) {
    const li = document.createElement("div");
    li.className = "live-card";
    const title = document.createElement("div");
    title.className = "live-title";
    // `older`: entries the buffer dropped before we polled them (#234) —
    // honestly counted, not silently lost; otherwise a same-poll overflow.
    // `text` overrides both for losses that have no meaningful count.
    title.textContent = text ?? (older ? `+${count} older changes` : `+${count} more live events`);
    li.append(title);
    li.style.zIndex = String(++cardDepth);
    cardsEl.prepend(li);
    deck.sync();
    setTimeout(() => {
      li.remove();
      deck.sync();
    }, 20000);
  }

  // ── live sync into the running map ─────────────────────────────────
  function applyToSim(u) {
    if (u.kind === "add") {
      // erst als echten Node adoptieren (#217), dann den Stern darüber zünden
      deps.adoptNode?.(u);
      deps.orbitView.spawnBurst(u);
      return;
    }
    const n = deps.sim.byId.get(u.id);
    if (!n) return;
    // der Node leuchtet kurz in der Kind-Farbe auf — das Ereignis ist in der
    // Map verortbar, nicht nur als Card am Rand
    const flash = KIND_META[u.kind]?.flash;
    // #217: the flare's lifetime carries HOW MUCH happened there. The daemon
    // coalesces a burst of hits on the same memory into one entry with ×N — so
    // a node something touched five times should burn longer than one with a
    // single hit. Capped in the renderer.
    if (flash) deps.renderer.flashNode?.(n.id, flash, 5000 + Math.min(u.count - 1, 4) * 2500);
    if (u.kind === "change") {
      n.title = u.title;
      n.summary = u.summary;
      if (typeof u.salience === "number") n.salience = u.salience;
      else delete n.salience;
      if (u.emotion) n.emotion = u.emotion;
      else delete n.emotion;
    } else if (u.kind === "delete") {
      // rot aufflammen lassen, dann verschwinden (soft-remove: aus Draw/Pick
      // raus + nicht mehr adressierbar)
      deps.sim.byId.delete(u.id);
      setTimeout(() => {
        n.ringHidden = true;
      }, 1400);
    }
  }

  async function poll() {
    if (!on || inFlight) return;
    // One request at a time. The interval fires on a clock, not on completion,
    // so a slow answer (or a tab catching up on coalesced timers) used to leave
    // two polls in the air holding the SAME cursor: both then replayed the same
    // entries into cards, and whichever landed second could carry the LOWER seq
    // — which the restart check below reads as a new server and rewinds to, so
    // the next poll fetches those entries yet again. A pile of notices that
    // never drains and a "daemon restarted" every few seconds, from nothing but
    // overlapping requests.
    inFlight = true;
    try {
      const res = await fetch(sinceSeq === null ? "/ui/updates" : `/ui/updates?since=${sinceSeq}`);
      if (!res.ok) return;
      const data = await res.json();
      if (sinceSeq === null) {
        // baseline: adopt the high-water mark, don't replay what happened before
        sinceSeq = data.seq ?? 0;
        return;
      }
      // The seq counter lives in the daemon's memory, so a daemon restart puts
      // it back to 0 while our cursor sits far ahead. Every entry then looks
      // older than what we've "already seen": the poll comes back empty and the
      // next one silently adopts the server's low seq — the events in between
      // are gone. That loses the `add` of a newborn while its later `change`
      // notices still arrive, and those point at a node the map never adopted.
      // Treat the jump backwards for what it is: a new server, so rebaseline.
      if (typeof data.seq === "number" && data.seq < sinceSeq) {
        sinceSeq = data.seq;
        summaryCard(0, true, "daemon restarted — live feed resynced");
        // The events across the restart are gone; the counter must not keep
        // carrying a total that was computed from them (#294).
        void counter.reconcile();
        return;
      }
      // buffer overflowed past our cursor → be honest about the drop (#234)
      if (typeof data.minSeq === "number" && data.minSeq > sinceSeq + 1) {
        summaryCard(data.minSeq - sinceSeq - 1, true);
        // Those dropped entries never reach the delta — measure instead.
        void counter.reconcile();
      }
      const fresh = data.updates ?? [];
      sinceSeq = data.seq ?? sinceSeq; // server delivers each seq exactly once
      for (const u of fresh) {
        applyToSim(u);
        recordHistory(u);
      }
      for (const u of fresh.slice(0, MAX_CARDS_PER_POLL)) card(u);
      if (fresh.length > MAX_CARDS_PER_POLL) summaryCard(fresh.length - MAX_CARDS_PER_POLL);
      counter.bump(
        fresh.filter((u) => u.kind === "add").length - fresh.filter((u) => u.kind === "delete").length,
      );
      counter.afterPoll();
    } catch {
      // daemon briefly away — next poll retries
    } finally {
      inFlight = false;
    }
  }

  function arm() {
    clearInterval(pollTimer);
    if (on) pollTimer = setInterval(poll, POLL_MS);
  }

  toggle.addEventListener("click", () => {
    on = !on;
    localStorage.setItem(LIVE_KEY, on ? "on" : "off");
    if (on) sinceSeq = null; // rebaseline on next poll; don't backfill the off-time
    render();
    arm();
  });

  // live seconds counter on every visible card, once per second
  setInterval(() => {
    for (const el of cardsEl.querySelectorAll(".live-age")) {
      el.textContent = `${Math.floor((Date.now() - Number(el.dataset.born)) / 1000)}s`;
    }
  }, 1000);

  // ── the burst overlay: supernovae in EVERY view, drawn above the nodes.
  // Universe view projects the true 3D position; the flat views anchor the
  // burst on a node of the memory's area (its cloud/wedge), slightly above.
  deps.renderer.setOverlay((ctx, camera, theme, now) => {
    if (deps.getView() === "orbit") {
      deps.orbitView.renderBursts(ctx, camera, theme, now);
      return;
    }
    for (const b of deps.orbitView.listBursts()) {
      const age = (now - b.born) / 1000;
      if (age > BURST_LIFE) continue;
      const anchor = deps.sim.nodes.find(
        (n) => (n.baseCluster === b.cluster || n.cluster === b.cluster) && !n.ringHidden,
      );
      if (!anchor) continue;
      drawBurstAt(ctx, camera, theme, anchor.x, anchor.y - 16, 1, age);
    }
  });

  render();
  arm();
}
