// Settings › Appearance › Background image: picker grid under the row
// (prototype isBackdrop: presets + uploads as 16:9 tiles, then "+ UPLOAD").
// Choosing a tile applies and saves at once (settings-model.js INSTANT).
import { t } from "../i18n.js";
import { h, clear, setVars } from "../dom.js";
import { PRESETS, backdrop, onBackdrop, lookOf, uploadBackdrop } from "../backdrop.js";

export function backdropCtl(e, { shown, setValue }) {
  const grid = h("div.bd-pick");
  const err = h("div.bd-err", { hidden: true });
  const input = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp" });
  const upBox = h("span.bd-up__box", { text: t("bd.upload") });
  const up = h("label.bd-up", null, input, upBox, h("span.bd-up__cap", { text: t("bd.upload.cap") }));
  let tiles = [];

  input.addEventListener("change", async () => {
    const f = input.files && input.files[0];
    input.value = "";
    if (!f) return;
    err.hidden = true;
    up.classList.add("is-busy"); upBox.textContent = t("bd.upload.busy");
    try { setValue(e.key, await uploadBackdrop(f)); }
    catch (x) { err.textContent = x.code === "fail" ? t("bd.err.fail", { err: x.message }) : t(`bd.err.${x.code}`); err.hidden = false; }
    up.classList.remove("is-busy"); upBox.textContent = t("bd.upload");
  });

  const options = () => [
    ...PRESETS.map((id) => ({ id, name: t(`bd.p.${id}`), tag: id === "none" ? "" : t("bd.tag.preset") })),
    ...backdrop.uploads.map((u) => ({ id: u.id, name: u.name, tag: t("bd.tag.upload") })),
  ];

  const draw = () => {
    tiles = options().map((o) => {
      const look = lookOf(o.id);
      const pic = h("span.bd-opt__pic", { cls: look?.cls }, h("span.bd-opt__shade"));
      if (look?.vars) setVars(pic, look.vars);
      const ok = h("span.bd-opt__ok", { text: "✓", hidden: true });
      pic.append(ok);
      const btn = h("button.bd-opt", { type: "button", title: o.name, cls: o.id === "none" ? "bd-opt--none" : "", on: { click: () => setValue(e.key, o.id) } },
        pic, h("span.bd-opt__cap", null, h("span.bd-opt__name", { text: o.name }), h("span.bd-opt__tag", { text: o.tag })));
      return { id: o.id, btn, ok };
    });
    clear(grid).append(...tiles.map((x) => x.btn), up, err);
    sync();
  };

  const sync = () => {
    const v = shown(e);
    for (const x of tiles) { const on = x.id === v; x.btn.classList.toggle("is-on", on); x.btn.setAttribute("aria-pressed", String(on)); x.ok.hidden = !on; }
  };

  // Uploads arrive after boot (GET /ui/backdrop) or from the input above.
  // A rebuilt or left settings page drops this grid; its listener goes with it.
  let count = backdrop.uploads.length;
  const off = onBackdrop(() => {
    if (!grid.isConnected) { off(); return; }
    if (backdrop.uploads.length !== count) { count = backdrop.uploads.length; draw(); } else sync();
  });
  draw();
  return { nodes: [], below: grid, sync };
}
