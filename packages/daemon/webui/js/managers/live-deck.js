/** Live-notice deck (#217) — the presentation half of the notice lane.
 *  managers/live-updates.js owns WHAT is announced; this owns how the pile
 *  looks. It never creates or removes a card, it only reacts to the ones that
 *  are there.
 *
 *  Three rules the deck follows:
 *    1. The newest card covers AT MOST two others. Beyond that a pile stops
 *       reading as a pile and starts reading as clutter, and a busy minute
 *       would bury the map it is reporting on.
 *    2. Everything past those three is counted, not drawn — one small bar
 *       saying how many are still down there.
 *    3. Scrolling is shown by tick marks on the left, not by a scrollbar. The
 *       native one is suppressed: a full-height bar next to a 280px lane is
 *       visually louder than the notices themselves, and the ticks double as a
 *       density readout — you can see at a glance whether three things or
 *       thirty happened.
 *
 *  @param {object} deps
 *  @param {HTMLElement} deps.cardsEl  the card container (scroll owner) */

import { KIND_META } from "./live-kinds.js";

const $ = (sel) => document.querySelector(sel);

/** Cards the collapsed deck shows: the top one plus the two it covers. */
const DECK_VISIBLE = 3;

/** Order the hidden-kind breakdown is read in — loudest event first, so a
 *  deletion never hides behind a pile of reads. */
import { createTickRail } from "../components/tick-rail.js";

const KIND_ORDER = ["delete", "add", "change", "read"];

/** A card's kind, read back off the class live-updates.js gave it.
 *
 *  The deck deliberately owns no state about the cards — it reads what is in
 *  the DOM, so it cannot drift out of sync with the manager that creates them.
 *  Summary cards ("+N older changes") carry no kind class and return null:
 *  they are counted in the total but have nothing to tally. */
function kindOf(card) {
  for (const cls of card.classList) {
    if (cls.startsWith("kind-")) return cls.slice("kind-".length);
  }
  return null;
}

export function createLiveDeck({ cardsEl }) {
  const ticksEl = $("#live-ticks");
  const moreEl = $("#live-more");
  const stackEl = $("#live-stack");
  const laneEl = $("#live-lane");
  // Die Leiste selbst lebt in components/tick-rail.js — dieselbe benutzt die
  // Live-Historie. Der Stapel gibt die Höhe vor, nicht die Kartenliste: die
  // Leiste hängt absolut an ihm (siehe live.css).
  const rail = createTickRail({ railEl: ticksEl, scrollEl: cardsEl, sizeEl: stackEl });

  const cards = () => [...cardsEl.children];

  function paintMore() {
    const hiddenCards = cards().slice(DECK_VISIBLE);
    moreEl.hidden = hiddenCards.length === 0;
    if (moreEl.hidden) return;

    const tally = new Map();
    for (const c of hiddenCards) {
      const k = kindOf(c);
      if (k) tally.set(k, (tally.get(k) ?? 0) + 1);
    }

    const total = document.createElement("span");
    total.className = "lm-total";
    total.textContent = `+${hiddenCards.length}`;

    const parts = KIND_ORDER.filter((k) => tally.has(k)).map((k) => {
      const meta = KIND_META[k];
      const chip = document.createElement("span");
      chip.className = `lm-kind kind-${k}`;
      chip.textContent = `${meta.icon} ${tally.get(k)} ${meta.short}`;
      return chip;
    });
    moreEl.replaceChildren(total, ...parts);
  }

  /** Stagger the fan-out from the TOP card downwards.
   *
   *  Cards are prepended, so the first child is the newest and sits on top of
   *  the pile. It leaves first, the card beneath follows, and the ones the deck
   *  was hiding come up last — the order the eye already reads the deck in.
   *  Going bottom-up instead made the oldest note lead the movement, which is
   *  backwards for a stack you read from the top.
   *
   *  FAN_LEAD is not decoration: it holds every card still until #live-more has
   *  finished collapsing (0.34s in live.css), so the pile slides down as one
   *  block before anything unfolds. Overlap the two and the gesture reads as
   *  two competing animations. */
  /** Resting overlap of the visible pile, from live.css — the distance those
   *  three cards travel is what sets the speed everything else matches. */
  const DECK_OVERLAP = 62;
  const OPEN_GAP = 10; // the gap cards settle into once fanned out
  const BASE_DUR = 0.26; // s for the visible cards' own travel
  const SPEED = (DECK_OVERLAP + OPEN_GAP) / BASE_DUR; // px per second

  /** Delays, durations and hide-depths for one opening and one closing.
   *
   *  Opening: #live-more collapses (FAN_LEAD), then the three on top unfold one
   *  at a time so each can be read, then the covered ones follow as a wave.
   *  Closing is the same gesture reversed — bottom card home first, top card
   *  last, and only then the bar returns.
   *
   *  Every card moves at the SAME SPEED rather than for the same duration. A
   *  covered card starts a full card-height down, so a shared duration would
   *  make it race while the ones above it drift. */
  function paintFanDelays() {
    const FAN_LEAD = 0.34; // s — matches #live-more's collapse in live.css
    const STACK_STEP = 0.14; // s between the visible cards, read one by one
    const TAIL_GAP = 0.1; // s of quiet before the covered ones start
    const TAIL_STEP = 0.05; // s between the covered ones
    const FOLD_STEP = 0.05; // s between cards on the way back
    const stackTail = FAN_LEAD + (DECK_VISIBLE - 1) * STACK_STEP + TAIL_GAP;
    const list = cards();
    let slowest = BASE_DUR;

    list.forEach((card, i) => {
      const covered = i >= DECK_VISIBLE;
      // A covered card hides behind exactly its own height: deeper would drag
      // the whole deck upward (it would contribute negative height), shallower
      // and it peeks out from under the pile.
      if (covered) card.style.setProperty("--self-hide", `-${card.offsetHeight}px`);
      const travel = (covered ? card.offsetHeight : DECK_OVERLAP) + OPEN_GAP;
      const dur = travel / SPEED;
      if (dur > slowest) slowest = dur;
      card.style.setProperty("--fan-dur", `${dur.toFixed(3)}s`);

      // opening: top first, the pile reads downward
      const open = covered ? stackTail + (i - DECK_VISIBLE) * TAIL_STEP : FAN_LEAD + Math.max(0, i - 1) * STACK_STEP;
      card.style.setProperty("--fan-delay", `${open.toFixed(3)}s`);

      // closing: the reverse — the last card folds home first
      const fold = (list.length - 1 - i) * FOLD_STEP;
      card.style.setProperty("--fold-delay", `${fold.toFixed(3)}s`);
    });

    // the bar may only come back once the last card has landed
    const foldTotal = (list.length - 1) * FOLD_STEP + slowest;
    laneEl.style.setProperty("--fold-total", `${foldTotal.toFixed(3)}s`);
  }

  /** Called by live-updates.js after any card was added or removed. */
  function sync() {
    rail.update(cards().length);
    paintMore();
    paintFanDelays();
  }

  // The deck changes height when it opens, so the rail's spacing has to be
  // recomputed — after the transition, not during it, or it measures a size
  // the deck is still moving through.
  laneEl.addEventListener("mouseenter", () => setTimeout(() => rail.paint(cards().length), 320));
  laneEl.addEventListener("mouseleave", () => setTimeout(() => rail.paint(cards().length), 320));

  cardsEl.addEventListener("scroll", () => {
    if (rail.sync(cards().length)) rail.paint(cards().length);
  });

  // The rail answers two questions at once: the lit mark says where the list is
  // scrolled, this one says which card the cursor is on. Delegated, so cards
  // arriving and expiring need no wiring of their own.
  cardsEl.addEventListener("pointerover", (ev) => {
    const card = ev.target.closest(".live-card");
    const list = cards();
    rail.setHover(card ? list.indexOf(card) : null, list.length);
  });
  cardsEl.addEventListener("pointerleave", () => rail.setHover(null, cards().length));

  return { sync };
}
