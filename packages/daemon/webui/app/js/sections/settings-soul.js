// Base personality controls, using the ordinary pending-settings workflow.
import { h, growTextarea } from "../dom.js";
import { t } from "../i18n.js";
import { shown, setValue } from "./settings-model.js";

// Protective limit of the daemon (src/soul.ts SOUL_TEXT_MAX); the counter shows
// from 90 % of it.
const SOUL_TEXT_MAX = 8000;
const SOUL_COUNT_FROM = 7200;

export function soulControl(e) {
  if (e.key === "soul.direction") {
    const select = h(
      "select.st-select",
      { "aria-label": t("st.k.soul.direction") },
      e.choices.map((value) => h("option", { value, text: t(`st.soul.${value}`) }))
    );
    const description = h("span.st-soul__hint");
    select.addEventListener("change", () => setValue(e.key, select.value === "balanced" ? null : select.value));
    return {
      nodes: [h("span.st-selw", null, select), description],
      wide: true,
      sync() {
        const value = shown(e) || "balanced";
        select.value = value;
        description.textContent = t(`st.soul.${value}.d`);
      },
    };
  }
  const count = h("span.st-soul__count", { "aria-live": "polite" });
  // No cap while typing; the counter appears near the protective limit and the
  // field is flagged above it. The text is never cut.
  const showCount = () => {
    const n = text.value.length;
    count.hidden = n < SOUL_COUNT_FROM;
    count.textContent = t(n > SOUL_TEXT_MAX ? "st.soul.over" : "st.soul.count", { n, max: SOUL_TEXT_MAX });
    text.classList.toggle("is-bad", n > SOUL_TEXT_MAX);
  };
  const text = h("textarea.st-text.st-soul__text", {
    rows: 3,
    "aria-label": t("st.k.soul.text"),
    placeholder: t("st.k.soul.text.p"),
    on: {
      input: () => {
        growTextarea(text);
        showCount();
        setValue(e.key, text.value.trim() ? text.value : null);
      },
    },
  });
  return {
    nodes: [text, count],
    wide: true,
    sync() {
      if (document.activeElement !== text) text.value = shown(e) || "";
      growTextarea(text);
      showCount();
    },
  };
}
