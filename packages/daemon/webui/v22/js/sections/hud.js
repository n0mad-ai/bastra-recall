// Shared building blocks of the normal areas (SCREENS.md › Gemeinsame Muster):
// HUD head box, figure tiles, compact head with pills, chips and buttons.
// Values are the prototype's inline styles; the CSS lives in css/sections.css.
//
// How a new area is built (Dashboard, Telemetry, Tasks, Settings, …):
//   1. js/sections/<name>.js — registerArea({ id, …, section, greetingKey,
//      presetKeys, tabs, mount }) (field reference: js/areas.js) and import it
//      from js/sections/index.js. Registering an existing id replaces it.
//   2. css/<name>.css — area styles, linked in index.html after sections.css.
//      No style attributes (CSP style-src 'self'): dynamic values go through
//      setVars()/vars: {"--x": …} and are read in CSS.
//   3. js/i18n/<name>-en.js + <name>-de.js — every visible text; merged with
//      addStrings(en, de) from js/i18n.js at the top of <name>.js.
//
// Example (mount gets the stage frame's content element):
//   mount: (el) => { el.append(
//     hud({ kicker: t("st.kicker"), title: t("st.title"), text: t("st.text"),
//           side: [hudRow(hudChip("daemon v1.1.8", { dot: "var(--accent)" })), hudButton(t("st.ask"), onAsk)] }),
//     hudTiles([{ k: "vault", v: "530", sub: "21 areas" }])); }
//
// Compact head (Tasks, Documents tree): hud({ compact: true, kicker, title, side: [hudPills(tiles), hudButton(…)] }).
import { h } from "../dom.js";

/**
 * HUD head box.
 * @param {{ kicker: string, title?: string, text?: string|Node|(string|Node)[],
 *           side?: (Node|null)[], compact?: boolean, cls?: string }} o
 *   side — right column (full) or right-aligned action group (compact).
 */
export function hud({ kicker, title, text, side, compact = false, cls = "" }) {
  if (compact) {
    return h(
      "div.hud.hud--compact",
      { cls },
      h("span.hud__corners"),
      h(
        "div.hud__main",
        null,
        h("span.hud__kicker", { text: kicker }),
        title ? h("span.hud__title", { text: title }) : null
      ),
      side?.length ? h("div.hud__acts", null, side) : null
    );
  }
  return h(
    "div.hud",
    { cls },
    h("span.hud__corners"),
    h(
      "div.hud__main",
      null,
      h("span.hud__kicker", { text: kicker }),
      title ? h("h1.hud__title", { text: title }) : null,
      text ? h("p.hud__text", null, text) : null
    ),
    side?.length ? h("div.hud__side", null, side) : null
  );
}

/** Row of chips in the HUD side column. */
export function hudRow(...nodes) {
  return h("div.hud__row", null, nodes);
}

/**
 * Small status chip. dot: CSS colour of the leading dot; on: accent state
 * (Telemetry window chip); onClick turns it into a button.
 */
export function hudChip(text, { dot, on = false, onClick } = {}) {
  const props = { cls: on ? "is-on" : "", vars: dot ? { "--c": dot } : null, on: onClick ? { click: onClick } : null };
  return h(onClick ? "button.hud-chip" : "span.hud-chip", props, dot ? h("span.hud-chip__dot") : null, text);
}

/** Accent action button ("GO THROUGH IT WITH RECALL ↗", "NEUE AUFGABE +"). */
export function hudButton(text, onClick) {
  return h("button.hud-btn", { text, on: onClick ? { click: onClick } : null });
}

/** Mono note under the chips (Telemetry window note). */
export function hudNote(text) {
  return h("span.hud-note", { text });
}

/**
 * Figure tiles under the head box.
 * @param {{ k: string, v: string|number, sub?: string, color?: string, tick?: string }[]} tiles
 *   color — value colour (default ink); tick — top tick colour (default muted line).
 * @param {{ large?: boolean, cls?: string }} [o] large: 30px values (Telemetry) instead of 24px.
 */
export function hudTiles(tiles, { large = false, cls = "" } = {}) {
  return h(
    "div.hud-tiles",
    { cls: [large ? "hud-tiles--lg" : "", cls].join(" ") },
    tiles.map((o) =>
      h(
        "div.hud-tile",
        { vars: { "--c": o.color || "var(--ink)", "--tick": o.tick || "var(--line-45)" } },
        h("span.hud-tile__tick"),
        h("span.hud-tile__k", { text: o.k }),
        h("span.hud-tile__v", { text: String(o.v) }),
        o.sub ? h("span.hud-tile__sub", { text: o.sub }) : null
      )
    )
  );
}

/** The same figures as pills for the compact head (title attribute = sub line). */
export function hudPills(tiles) {
  return tiles.map((o) =>
    h(
      "span.hud-pill",
      { title: o.sub || null, vars: { "--c": o.color || "var(--ink)", "--tick": o.tick || "var(--line-45)" } },
      h("span.hud-pill__tick"),
      o.k,
      h("span.hud-pill__v", { text: String(o.v) })
    )
  );
}
