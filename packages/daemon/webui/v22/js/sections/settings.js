// Settings area (SCREENS.md › Settings, prototype STAGE › isSettings).
// Stage: HUD head box, figure tiles, one section per group with the rows the
// daemon's settings registry knows, and the Apply bar across the full frame
// width (scrollbar included). Right panel: Find + Changes (settings-panel.js).
// Data, saving and restart: settings-model.js (same endpoints as the classic UI).
//
// Rows are built once per snapshot; edits only re-sync chips and controls, so
// a focused text field keeps its caret.
import { addStrings, t, numberFmt } from "../i18n.js";
import { registerArea, ICON } from "../areas.js";
import { data, onData } from "../data.js";
import { h, clear } from "../dom.js";
import { setState } from "../state.js";
import { hud, hudRow, hudChip, hudButton, hudTiles } from "./hud.js";
import { loadingBlock, loadingInline, setBusy } from "./loading.js";
import {
  SETTINGS_FILE,
  GROUPS,
  OPTIONS,
  metaOf,
  loadModels,
  store,
  onStore,
  emit,
  load,
  apply,
  discard,
  restart,
  revokeOauth,
  entry,
  groupKeys,
  locked,
  changed,
  pendingKeys,
  shown,
  setValue,
  revert,
  setInvalid,
  matches,
} from "./settings-model.js";
import { findTab, changesTab } from "./settings-panel.js";
import { backdropCtl } from "./settings-backdrop.js";
import { soulControl } from "./settings-soul.js";
import { assistantNameCtl } from "./settings-assistant.js";
import en from "../i18n/settings-en.js";
import de from "../i18n/settings-de.js";

addStrings(en, de);

const ASK_ALL = "agent.sug.settings";
const ASK_RECALL = "st.sug.recall";
const ASK_ENV = "st.sug.env";

/** t() with a fallback when the key is missing (server label for unknown keys). */
export function tx(key, fallback, vars) {
  const s = t(key, vars);
  return s === key ? fallback : s;
}
export const nameOf = (e) => tx(`st.k.${e.key}`, e.label || e.key);
export const descOf = (e) => tx(`st.k.${e.key}.d`, "");
export const groupTitle = (g) => t(`st.g.${g.id}`);

/** Display text of a value (Changes: old → new). */
export function fmt(e, v) {
  if (v === null || v === undefined) return t("st.v.default");
  if (e.secret) return "••••••••";
  if (typeof v === "boolean") return t(v ? "st.v.on" : "st.v.off");
  if (Array.isArray(v)) return v.length ? v.join(", ") : t("st.v.none");
  if (typeof v === "object") return JSON.stringify(v);
  return v === "" ? "—" : String(v);
}

function tiles() {
  const hl = data.health || {};
  const dash = "—";
  const eff = (k) => entry(k)?.effective;
  const mode = typeof hl.embedding_mode === "string" ? hl.embedding_mode : "";
  const provider =
    typeof eff("embedding.provider") === "string" ? eff("embedding.provider") : mode.split("-")[0] || dash;
  const gen =
    typeof eff("generation.model") === "string"
      ? eff("generation.model")
      : typeof hl.trigger_expand?.model === "string"
        ? hl.trigger_expand.model
        : dash;
  const envN = store.model ? store.model.entries.filter((e) => e.envOverride?.length).length : null;
  return [
    {
      k: t("st.t.daemon"),
      v: t("st.t.running"),
      sub: hl.version ? `v${hl.version}` : dash,
      color: "var(--accent)",
      tick: "var(--accent)",
    },
    {
      k: t("st.t.embeddings"),
      v: provider,
      sub: provider === "none" ? t("st.t.bm25") : mode.split("-").slice(1).join("-"),
    },
    { k: t("st.t.generation"), v: gen, sub: t("st.t.generationSub") },
    {
      k: t("st.t.vault"),
      v: Number.isFinite(hl.vault_size) ? numberFmt.format(hl.vault_size) : dash,
      sub: t("st.t.vaultSub", { n: data.clusters.length }),
    },
    {
      k: t("st.t.env"),
      v: envN === null ? dash : String(envN),
      sub: t("st.t.envSub"),
      color: envN ? "var(--amber)" : "var(--ink)",
      tick: envN ? "var(--amber)" : "var(--line-45)",
    },
  ];
}

// ── controls ─────────────────────────────────────────────────────────────
function chip(text, cls) {
  return h(`span.st-chip.${cls}`, { text });
}

function toggleCtl(e) {
  const label = h("span.st-sw__t"),
    sw = h(
      "button.st-sw",
      { type: "button", "aria-label": nameOf(e), on: { click: () => setValue(e.key, !shown(e)) } },
      h("span.st-sw__k")
    );
  return {
    nodes: [label, sw],
    sync: () => {
      const on = shown(e) === true;
      label.textContent = t(on ? "st.v.ON" : "st.v.OFF");
      label.classList.toggle("is-on", on);
      sw.classList.toggle("is-on", on);
      sw.setAttribute("aria-pressed", String(on));
    },
  };
}

function segCtl(e) {
  const btns = e.choices.map((o) =>
    h("button.st-seg__o", {
      type: "button",
      text: tx(`st.o.${e.key}.${o}`, o),
      on: { click: () => setValue(e.key, o) },
    })
  );
  return {
    nodes: [h("div.st-seg", null, btns)],
    sync: () => {
      const v = shown(e);
      btns.forEach((b, i) => b.classList.toggle("is-on", e.choices[i] === v));
    },
  };
}

/** Pick list: typical values, the default marked, "Custom value …" reveals a text field (also for a stored value outside the list). */
function selectCtl(e) {
  const spec = OPTIONS[e.key],
    m = metaOf(e),
    isNum = e.kind === "number",
    unit = m.unit ? t(`st.unit.${m.unit}`) : "";
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const installed = spec.models ? store.models : [];
  const vals = spec.models
    ? [...installed.map((v) => ({ v })), ...spec.vals.filter((o) => !installed.includes(o.v))]
    : spec.vals;
  const opts = vals.map((o) => {
    const std = same(o.v, e.default);
    let text = tx(
      `st.o.${spec.pre || e.key}.${o.k ?? o.v}`,
      o.v === null ? t("st.o.none") : isNum && unit ? `${o.v} ${unit}` : String(o.v)
    );
    if (spec.models && installed.length)
      text += ` · ${t(installed.includes(o.v) ? "st.o.installed" : "st.o.notInstalled")}`;
    return { v: o.v, std, text: std ? `${text} · ${t("st.v.default")}` : text };
  });
  let customMode = false;
  const sel = h("select.st-select", { "aria-label": nameOf(e) });
  const custom = h("input.st-text", {
    type: "text",
    autocomplete: "off",
    spellcheck: "false",
    hidden: true,
    placeholder: t(isNum ? "st.custom.num" : "st.custom.ph"),
    "aria-label": `${nameOf(e)} – ${t("st.custom")}`,
  });
  const draw = () => {
    clear(sel).append(
      ...opts.map((o, i) => h("option", { value: String(i), text: o.text })),
      spec.custom ? h("option", { value: "custom", text: t("st.custom") }) : null
    );
  };
  draw();
  sel.addEventListener("change", () => {
    if (sel.value === "custom") {
      customMode = true;
      custom.hidden = false;
      custom.focus();
      return;
    }
    customMode = false;
    custom.hidden = true;
    custom.classList.remove("is-bad");
    const o = opts[Number(sel.value)];
    setValue(e.key, o.std ? null : o.v);
  });
  custom.addEventListener("input", () => {
    const raw = custom.value.trim(),
      n = Number(raw);
    custom.classList.remove("is-bad");
    if (raw === "") {
      setValue(e.key, null);
      return;
    }
    if (isNum && (!Number.isFinite(n) || n < (m.min ?? -Infinity) || n > (m.max ?? Infinity))) {
      custom.classList.add("is-bad");
      return;
    }
    setValue(e.key, isNum ? n : raw);
  });
  return {
    nodes: [h("span.st-selw", null, sel), custom],
    wide: true,
    sync: () => {
      const v = shown(e),
        cur = v === undefined || v === null ? e.default : v;
      const i = opts.findIndex((o) => same(o.v, cur));
      if (i < 0 && !spec.custom) {
        opts.push({ v: cur, std: false, text: String(cur) });
        draw();
      }
      const idx = i < 0 && !spec.custom ? opts.length - 1 : i;
      if (idx < 0) customMode = true;
      sel.value = customMode || idx < 0 ? "custom" : String(idx);
      custom.hidden = sel.value !== "custom";
      if (!custom.hidden && document.activeElement !== custom)
        custom.value = v === undefined || v === null ? "" : String(v);
    },
  };
}

function numberCtl(e) {
  const m = metaOf(e),
    step = m.step || 1;
  const val = h("span.st-num__v"),
    unit = h("span.st-num__u", { text: m.unit ? t(`st.unit.${m.unit}`) : "" });
  const bump = (d) => {
    const cur = Number(shown(e));
    const base = Number.isFinite(cur) ? cur : (m.min ?? 0);
    setValue(e.key, Math.min(m.max ?? 1e9, Math.max(m.min ?? -1e9, base + d)));
  };
  const range = m.max !== undefined ? h("span.st-num__r", { text: `${m.min}–${m.max}` }) : null;
  return {
    nodes: [
      range,
      h(
        "div.st-num",
        null,
        h("button.st-num__b", {
          type: "button",
          "aria-label": t("st.dec"),
          text: "−",
          on: { click: () => bump(-step) },
        }),
        h("span.st-num__in", null, val, unit),
        h("button.st-num__b.st-num__b--r", {
          type: "button",
          "aria-label": t("st.inc"),
          text: "+",
          on: { click: () => bump(step) },
        })
      ),
    ],
    sync: () => {
      const v = shown(e);
      val.textContent = v === null || v === undefined ? "—" : String(v);
    },
  };
}

function textCtl(e) {
  const input = h("input.st-text", {
    type: "text",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: tx(`st.k.${e.key}.p`, e.default != null ? String(e.default) : ""),
    on: { input: () => setValue(e.key, input.value.trim() === "" ? null : input.value.trim()) },
  });
  return {
    nodes: [input],
    wide: true,
    sync: () => {
      if (document.activeElement !== input) {
        const v = shown(e);
        input.value = v === null || v === undefined ? "" : String(v);
      }
    },
  };
}

function listCtl(e) {
  const items = h("div.st-list__items");
  const cur = () => (Array.isArray(shown(e)) ? shown(e) : []);
  const add = h("input.st-list__add", {
    type: "text",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: tx(`st.k.${e.key}.p`, t("st.list.add")),
    on: {
      keydown: (ev) => {
        if (ev.key !== "Enter" || !add.value.trim()) return;
        const v = add.value.trim();
        add.value = "";
        if (!cur().includes(v)) setValue(e.key, [...cur(), v]);
      },
    },
  });
  return {
    nodes: [h("div.st-list", null, items, add)],
    wide: true,
    sync: () =>
      clear(items).append(
        ...cur().map((it) =>
          h(
            "span.st-list__it",
            null,
            h("span.st-list__t", { text: it, title: it }),
            h("button.st-list__x", {
              type: "button",
              "aria-label": t("st.list.remove"),
              text: "×",
              on: {
                click: () =>
                  setValue(
                    e.key,
                    cur().filter((x) => x !== it)
                  ),
              },
            })
          )
        )
      ),
  };
}

/** Secret: the daemon never sends it back; a new value replaces it on Apply. */
function secretCtl(e) {
  const mask = h("span.st-secret");
  const input = h("input.st-text.st-text--secret", {
    type: "password",
    autocomplete: "new-password",
    placeholder: t("st.secret.new"),
    on: {
      input: () => {
        const raw = input.value.trim();
        setInvalid(e.key, null);
        if (!raw) {
          revert(e.key);
          return;
        }
        if (e.kind !== "json") {
          store.changes.set(e.key, raw);
          emit("value");
          return;
        }
        try {
          store.changes.set(e.key, JSON.parse(raw));
        } catch {
          // The visible text is what Apply must save; until it parses, Apply stays blocked.
          setInvalid(e.key, input.value);
        }
        emit("value");
      },
    },
  });
  return {
    nodes: [mask, input],
    wide: true,
    focus: () => input.focus(),
    sync: () => {
      const draft = store.invalid.get(e.key);
      input.classList.toggle("is-bad", draft !== undefined);
      if (draft !== undefined) {
        if (document.activeElement !== input) input.value = draft;
        mask.textContent = t("st.json.invalidShort");
        return;
      }
      mask.textContent = changed(e.key) ? t("st.secret.pending") : e.isSet ? "••••••••••••" : t("st.secret.unset");
      if (!changed(e.key) && document.activeElement !== input) input.value = "";
    },
  };
}

/** Read-only value (registry readonly or pinned by env). */
function valueCtl(e) {
  const v = h("span.st-ro");
  return {
    nodes: [v],
    sync: () => {
      v.textContent = fmt({ ...e, secret: e.secret }, shown(e));
    },
  };
}

function controlFor(e) {
  if (e.readonly) return valueCtl(e);
  if (e.key === "assistant.name") return assistantNameCtl(e, textCtl(e));
  if (e.key === "soul.direction" || e.key === "soul.text") return soulControl(e);
  if (e.key === "ui.backdrop") return backdropCtl(e, { shown, setValue, revert, reload: load });
  if (e.secret) return e.envOverride?.length ? valueCtl(e) : secretCtl(e);
  if (e.kind === "boolean") return toggleCtl(e);
  if (e.choices) return segCtl(e);
  if (OPTIONS[e.key]) return selectCtl(e);
  if (e.kind === "number") return numberCtl(e);
  if (e.kind === "json") return listCtl(e);
  return textCtl(e);
}

// ── rows and sections ────────────────────────────────────────────────────
function row(e) {
  const meta = metaOf(e),
    isLocked = locked(e),
    env = e.envOverride || [];
  const ctl = controlFor(e);
  const mod = chip(t("st.chip.modified"), "st-chip--mod");
  const note = env.length
    ? h("div.st-row__env.is-set", { text: t("st.envSet", { env: env.map((x) => `${x.name}=${x.value}`).join(", ") }) })
    : e.readonly
      ? h("div.st-row__env", { text: tx(`st.readonly.${e.readonlyCode}`, t("st.readonly")) })
      : e.local
        ? h("div.st-row__env", { text: t("st.local") })
        : null;
  const el = h(
    "div.st-row",
    null,
    h(
      "div.st-row__main",
      null,
      h(
        "div.st-row__head",
        null,
        h("span.st-row__name", { text: nameOf(e) }),
        mod,
        e.restartRequired ? chip(t("st.chip.restart"), "st-chip--rs") : null,
        meta.experimental ? chip(t("st.chip.experimental"), "st-chip--exp") : null,
        env.length ? chip(t("st.chip.env"), "st-chip--env") : null
      ),
      h("div.st-row__key", { text: e.envName || (e.key === "autostart" ? "bastra autostart" : e.key) }),
      descOf(e) ? h("p.st-row__desc", { text: descOf(e) }) : null,
      note
    ),
    h("div.st-row__ctl", { cls: isLocked && !e.readonly ? "is-locked" : "" }, ctl.nodes)
  );
  if (ctl.wide) el.classList.add("st-row--wide");
  if (ctl.below) el.append(ctl.below);
  const text = [nameOf(e), descOf(e)];
  return {
    el,
    key: e.key,
    e,
    text,
    focus: ctl.focus,
    sync: () => {
      const c = changed(e.key);
      mod.hidden = !c;
      el.classList.toggle("is-changed", c);
      ctl.sync();
    },
  };
}

function oauthRows() {
  const clients = store.model?.oauthClients || [];
  if (!clients.length) return [];
  return [
    h(
      "div.st-row.st-row--sub",
      null,
      h(
        "div.st-row__main",
        null,
        h("div.st-row__head", null, h("span.st-row__name", { text: t("st.oauth") })),
        h("div.st-row__key", { text: "bastra oauth" }),
        h("p.st-row__desc", { text: t("st.oauth.d") })
      ),
      h("div.st-row__ctl", null, h("span.st-ro", { text: t("st.oauth.n", { n: clients.length }) }))
    ),
    ...clients.map((c) =>
      h(
        "div.st-row.st-row--client",
        null,
        h(
          "div.st-row__main",
          null,
          h("div.st-row__head", null, h("span.st-row__name", { text: String(c.name || c.id) })),
          h("div.st-row__key", {
            text: t("st.oauth.meta", {
              n: Number(c.grants) || 0,
              at: c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString() : "—",
            }),
          })
        ),
        h(
          "div.st-row__ctl",
          null,
          h("button.st-btn", {
            type: "button",
            text: t("st.oauth.revoke"),
            on: {
              click: (ev) => {
                ev.currentTarget.disabled = true;
                setBusy(ev.currentTarget, true);
                revokeOauth(c.id);
              },
            },
          })
        )
      )
    ),
  ];
}

function mount(el, ctx) {
  const frame = el.closest(".sx"),
    scroller = el.parentElement;
  const head = h("div.st-headbox"),
    body = h("div.st-body"),
    noHits = h("div.st-nohits", { hidden: true });
  const bar = h("div.st-bar", { hidden: true });
  frame.append(bar);
  el.append(head, body, noHits, h("div.st-spacer"));
  let rows = [],
    sections = [];

  const drawHead = () => {
    const n = pendingKeys().length;
    clear(head).append(
      hud({
        cls: "st-hud",
        kicker: t("st.kicker", { file: SETTINGS_FILE }),
        title: t("st.title"),
        text: t("st.text"),
        side: [
          hudRow(
            hudChip(t("st.daemon", { v: data.health?.version || "—" }), { dot: "var(--accent)" }),
            hudChip(n ? t("st.unsaved", { n }) : t("st.allSaved"), {
              dot: n ? "var(--amber)" : "var(--ok)",
              onClick: () => setState({ tab: "changes", lensOpen: true }),
            })
          ),
          hudButton(t("st.askAll"), () => ctx.ask(t(ASK_ALL))),
        ],
      }),
      hudTiles(tiles())
    );
  };

  const build = () => {
    clear(body);
    rows = [];
    sections = [];
    if (!store.model && !store.error) {
      body.append(loadingBlock(t("st.loading")));
    }
    if (store.error && !store.model) {
      body.append(
        h(
          "div.st-state.is-err",
          null,
          h("span", { text: t("st.loadErr", { err: store.error }) }),
          h("button.st-btn", { type: "button", text: t("st.retry"), on: { click: () => load() } })
        )
      );
    }
    GROUPS.forEach((g) => {
      const keys = groupKeys(g);
      if (!keys.length && !(g.oauth && store.model?.oauthClients?.length)) return;
      const rs = keys.map((k) => row(entry(k)));
      rows.push(...rs);
      const n = String(sections.length + 1).padStart(2, "0");
      const sec = h(
        "section.st-sec",
        { id: `st-${g.id}` },
        h(
          "div.st-sec__head",
          null,
          h("span.st-sec__n", { text: n }),
          h("div.st-sec__t", null, h("h2", { text: groupTitle(g) }), h("span.st-sec__rule")),
          h("button.st-sec__ask", {
            type: "button",
            title: t("st.walkTitle"),
            text: t("st.walk"),
            on: { click: () => ctx.ask(t("st.walkQ", { title: groupTitle(g) })) },
          }),
          h("p.st-sec__q", { text: tx(`st.g.${g.id}.q`, "") })
        ),
        h(
          "div.st-sec__rows",
          null,
          rs.map((r) => r.el),
          g.oauth ? oauthRows() : null
        )
      );
      sections.push({ g, el: sec, rows: rs, n });
      body.append(sec);
    });
    store.sections = sections.map((s) => ({
      id: s.g.id,
      n: s.n,
      title: groupTitle(s.g),
      keys: s.rows.map((r) => r.key),
    }));
    filter();
    sync();
  };

  const filter = () => {
    const q = store.query.trim().toLowerCase();
    let any = false;
    for (const s of sections) {
      let hits = 0;
      for (const r of s.rows) {
        const hit = matches(r.e, r.text[0], r.text[1], q);
        r.el.hidden = !!q && !hit;
        r.el.classList.toggle("is-hit", !!q && hit);
        if (hit) hits++;
      }
      s.el.hidden = !!q && hits === 0;
      if (!s.el.hidden) any = true;
    }
    noHits.hidden = !q || any || !sections.length;
    noHits.textContent = t("st.noHits", { q: store.query.trim() });
  };

  const drawBar = () => {
    const keys = pendingKeys(),
      n = keys.length,
      rsN = keys.filter((k) => entry(k)?.restartRequired).length;
    const needRestart = !n && store.savedRestart;
    bar.hidden = !n && !needRestart && !store.restarting && !(store.error && store.model);
    if (bar.hidden) return;
    const acts = h("div.st-bar__acts");
    let txt;
    if (store.restarting) txt = h("span.st-bar__t", null, loadingInline(t("st.restarting")));
    else if (n) {
      txt = h(
        "span.st-bar__t",
        null,
        h("span.st-bar__n", { text: String(n) }),
        ` ${t("st.bar.unsaved", { n })} · `,
        h("span.st-bar__m", { text: rsN ? t("st.restartN", { n: rsN }) : t("st.noRestart") })
      );
      acts.append(
        h("button.st-btn", {
          type: "button",
          text: t("st.review"),
          on: { click: () => setState({ tab: "changes", lensOpen: true }) },
        }),
        h("button.st-btn.st-btn--mute", { type: "button", text: t("st.discard"), on: { click: discard } }),
        h("button.st-btn.st-btn--go", {
          type: "button",
          cls: store.busy ? "ld-on" : "",
          text: store.busy ? t("st.applying") : t("st.apply"),
          disabled: store.busy,
          on: { click: apply },
        })
      );
    } else if (needRestart) {
      txt = h("span.st-bar__t", null, t("st.savedRestart", { at: store.saved }));
      if (store.model?.restartAvailable)
        acts.append(
          h("button.st-btn.st-btn--go", {
            type: "button",
            text: t("st.restart"),
            on: {
              click: (ev) => {
                setBusy(ev.currentTarget, true);
                restart();
              },
            },
          })
        );
      acts.append(
        h("button.st-btn.st-btn--mute", {
          type: "button",
          text: t("st.later"),
          on: {
            click: () => {
              store.savedRestart = false;
              emit("bar");
            },
          },
        })
      );
    } else txt = h("span.st-bar__t");
    const err =
      store.error && store.model ? h("span.st-bar__err", { text: t("st.saveErr", { err: store.error }) }) : null;
    bar.classList.toggle("is-calm", !n);
    clear(bar).append(...[h("span.st-bar__dot"), txt, err, acts].filter(Boolean));
  };

  const sync = () => {
    for (const r of rows) r.sync();
    drawHead();
    drawBar();
  };

  // Scroll spy: the Find tab marks the group at the top of the stage.
  let raf = 0,
    mute = 0;
  const onScroll = () => {
    if (raf || Date.now() < mute) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const top = scroller.getBoundingClientRect().top;
      let cur = null;
      for (const s of sections) if (!s.el.hidden && s.el.getBoundingClientRect().top - top <= 90) cur = s.g.id;
      if (cur && cur !== store.sel) {
        store.sel = cur;
        emit("sel");
      }
    });
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });

  let flashT = 0;
  store.jump = (id) => {
    const s = sections.find((x) => x.g.id === id);
    if (!s) return;
    mute = Date.now() + 1000;
    store.sel = id;
    emit("sel");
    scroller.scrollTo({ top: s.el.offsetTop - 6, behavior: "smooth" });
    sections.forEach((x) => x.el.classList.remove("is-flash"));
    s.el.classList.add("is-flash");
    clearTimeout(flashT);
    flashT = setTimeout(() => s.el.classList.remove("is-flash"), 1800);
  };

  let count = pendingKeys().length;
  const offStore = onStore((what) => {
    // The Changes tab badge lives in the panel's tab row; rebuild it when the count moves.
    const nextCount = pendingKeys().length;
    if (nextCount !== count) {
      count = nextCount;
      ctx.refreshLens();
    }
    if (what === "invalid") {
      sync();
      const first = rows.find((r) => store.invalid.has(r.key));
      if (!first?.focus) return;
      if (first.el.hidden) {
        // A search hid the row: clear it so the field can be shown and focused.
        store.query = "";
        filter();
        ctx.refreshLens();
      }
      first.focus();
      return;
    }
    if (what === "value" || what === "bar" || what === "sel") {
      if (what !== "sel") sync();
      return;
    }
    if (what === "query") {
      filter();
      return;
    }
    build();
  });
  const offData = onData(drawHead);
  build();
  load().then(loadModels);
  return () => {
    offStore();
    offData();
    scroller.removeEventListener("scroll", onScroll);
    cancelAnimationFrame(raf);
    clearTimeout(flashT);
    bar.remove();
    store.jump = null;
  };
}

registerArea({
  id: "settings",
  group: "system",
  order: 1,
  labelKey: "nav.settings",
  icon: ICON.settings,
  pinAgent: true,
  section: { frame: true },
  greetingKey: "agent.greeting.settings",
  presetKeys: [ASK_ALL, ASK_RECALL, ASK_ENV],
  tabs: [
    { id: "areas", labelKey: "lens.find", render: findTab },
    { id: "changes", labelKey: "lens.changes", badge: () => pendingKeys().length, render: changesTab },
  ],
  mount,
});
