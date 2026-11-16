// Base personality controls, using the ordinary pending-settings workflow.
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { shown, setValue } from "./settings-model.js";

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
  const text = h("textarea.st-text.st-soul__text", {
    maxlength: 600,
    rows: 3,
    "aria-label": t("st.k.soul.text"),
    placeholder: t("st.k.soul.text.p"),
    on: {
      input: () => {
        count.textContent = t("st.soul.count", { n: text.value.length, max: 600 });
        setValue(e.key, text.value.trim() ? text.value : null);
      },
    },
  });
  return {
    nodes: [text, count],
    wide: true,
    sync() {
      if (document.activeElement !== text) text.value = shown(e) || "";
      count.textContent = t("st.soul.count", { n: text.value.length, max: 600 });
    },
  };
}
