// Weather place picker — one building block for every place the UI lets the
// user choose where the weather comes from (Mindspace View tab, Dashboard
// weather widget). Search (open-meteo geocoding) and GPS, always together,
// from the classic UI's weather manager (webui/js/managers/weather.js): same
// rounding, same storage key, nothing requested until a place is chosen.
// After every change the header reading (data.js › loadWeather) follows.
// Styles: css/engine.css (.vt__wx…).
import { h, clear } from "./dom.js";
import { t } from "./i18n.js";
import { loadWeather } from "./data.js";
import { createWeather } from "../../js/managers/weather.js";

let shared = null;
const listeners = new Set();

/** The one weather manager of the UI (Dashboard widget, Mindspace backdrop
 *  in js/views/engine-host.js). Created on first use. */
export function placeWeather() {
  if (!shared) shared = createWeather(() => { for (const fn of listeners) fn(); });
  return shared;
}
export function onPlaceWeather(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Picker for a weather manager `w`; redraw() runs after the place changed. */
export function weatherPicker(w, redraw) {
  if (!w) return h("span.vt__s", { text: "–" });
  const done = () => { loadWeather(); redraw(); };
  const msg = h("span.vt__msg");
  const list = h("div.vt__wxl");
  const place = w.getPlace();
  const r = w.readout();
  const head = place
    ? h("div.vt__wxh", null, h("span.vt__wxp", { text: [place.name, r && Number.isFinite(r.temp) ? `${Math.round(r.temp)}°` : "", r?.label || ""].filter(Boolean).join(" · ") }),
      h("button.vt__btn", { type: "button", text: t("ev.off"), on: { click: () => { void w.clear().then(done); } } }))
    : h("span.vt__s", { text: t("ev.wxOff") });
  let timer = 0;
  const input = h("input.vt__in", { type: "search", placeholder: t("ev.wxSearch"), "aria-label": t("ev.wxSearch"), on: { input: () => {
    clearTimeout(timer);
    const q = input.value;
    timer = setTimeout(async () => {
      const found = await w.search(q);
      clear(list).append(...found.map((p) => h("button.vt__wxo", { type: "button", text: [p.name, p.detail].filter(Boolean).join(", "), on: { click: () => { void w.setPlace(p).then(done); } } })));
      msg.textContent = q.trim().length >= 2 && !found.length ? t("ev.wxNone") : "";
    }, 350);
  } } });
  const gps = h("button.vt__btn", { type: "button", text: t("ev.wxGps"), title: t("ev.wxGpsTitle"), on: { click: () => { msg.textContent = t("ev.wxLocating"); w.useGps().then(done).catch((err) => { msg.textContent = err?.message || String(err); }); } } });
  return h("div.vt__wx", null, head, h("div.vt__wxs", null, input, gps), list, msg);
}
