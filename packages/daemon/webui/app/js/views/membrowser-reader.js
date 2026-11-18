// Memory-browser reader (prototype MEMORY BROWSER › reader): the selected
// memory's head, summary or RECALL WHEN box, text, stats, 30-day heat, links,
// facts, actions, the editor (membrowser-edit.js) and the vault care block
// (membrowser-care.js). The browser (memory-browser.js) owns the selection
// and the list; it mounts one reader per browser window.
//
// Reader text, topic and source come from GET /ui/graph/node?id= (cached per
// generation, membrowser-detail.js); a refresh of the same memory redraws at
// the same scroll position (#1449).
import { h, clear } from "../dom.js";
import { t, numberFmt } from "../i18n.js";
import { state } from "../state.js";
import { loadGraph } from "../data.js";
import { vault, areaCol } from "./vault-data.js";
import { careBlock } from "./membrowser-care.js";
import { readerKey, readerPlan } from "./membrowser-detail.js";
import { readerEdit, archiveNotice, editing } from "./membrowser-edit.js";
import { nextSelection } from "./membrowser-edit-model.js";
import { markdown } from "./markdown.js";
import { extras, heat, daysAgo, NO_DAYS } from "./membrowser-heat.js";

const str = (v) => (typeof v === "string" ? v : "");

/**
 * The reader in `reader` (inside the browser window `root`). Returns
 * `renderReader(force)`: draw the selected memory, keep it, or refresh it.
 *
 * `host` — the browser around it:
 *   M             the browser state (sel, reader; selection changes write it)
 *   details       the node-detail cache (membrowser-detail.js)
 *   alive()       false once the browser is unmounted
 *   order()       the list's memory ids in display order
 *   showArea(a)   narrow the list to area `a`
 *   follow(id)    select a linked memory
 *   hide(after)   close the browser, then run `after`
 *   scheduleReveal()  bring the selected row into view
 *   showMemory    focus a memory in the vault view (optional)
 *   care()        the vault care deps for careBlock (membrowser-care.js)
 *   ask(q)        ask the agent
 *   look          { TC, INK, ACC, MUT, dateStr } from chrome.js
 * `ask` and `look` are handed in: importing agent.js or chrome.js here would
 * close an import cycle through memory-browser.js.
 */
export function memoryReader(root, reader, host) {
  const { M, details, alive, order, look } = host;
  const { TC, INK, ACC, MUT, dateStr } = look;
  let readerFor = undefined, // readerKey of the drawn reader (membrowser-detail.js)
    keepTop = null; // { id, top }: reader scroll to restore once a refreshed reader is filled

  function renderReader(force) {
    const v = vault(),
      m = M.sel && v ? v.byId.get(M.sel) : null;
    const narrow = root.clientWidth > 0 && root.clientWidth < 760;
    root.classList.toggle("is-narrow", narrow);
    root.classList.toggle("is-reading", !!m && M.reader);
    const key = readerKey(m, v, narrow, details.gen);
    const plan = force ? "rebuild" : readerPlan(readerFor, key, readerBusy());
    if (plan === "keep") {
      updatePos();
      return;
    }
    if (plan === "refresh") return refreshReader(key);
    readerFor = key;
    clear(reader);
    reader.scrollTop = 0;
    if (!m) {
      const nosel = h("div.mb__nosel", null, t("mb.pick"), h("br"), t("mb.pickKeys"));
      reader.append(...[archiveNotice(M.sel, editDeps), nosel].filter(Boolean));
      return;
    }
    const ex = extras().get(m.id) || { lastAt: NaN, tags: [], scope: "", days: NO_DAYS };
    const text = h("div.mb-rd__text.is-wait", { text: t("mb.loading") });
    const facts = h("div.mb-rd__facts");
    const pos = h("span.mb-rd__pos");
    const box = h(
      "div.mb-rd__box",
      null,
      h("div.mb-rd__boxk", { text: t("mb.summary") }),
      h("div.mb-rd__boxv", { text: m.summary })
    );
    const reflex = h("span.mb-rd__flag", { text: "REFLEX", hidden: true });
    const title = h("h2.mb-rd__h", { text: m.title });
    const ed = readerEdit(m, { anchor: title, box, text, ...editDeps });
    const el = h(
      "div.mb-rd",
      null,
      archiveNotice(M.sel, editDeps),
      narrow
        ? h("button.mb-rd__back", {
            text: t("mb.back"),
            on: {
              click: () => {
                M.reader = false;
                renderReader(true);
                host.scheduleReveal();
              },
            },
          })
        : null,
      readerTop(m, ed, reflex, pos),
      title,
      m.summary ? box : null,
      text,
      readerStats(m, ex),
      h("div.mb-rd__hk", null, h("span", { text: t("mb.recalls30") }), h("span", { text: t("mb.todayK") })),
      heat(h("div.mb-heat.mb-rd__heat"), ex.days, ACC),
      readerLinks(m, v),
      facts,
      readerActs(m, ed),
      careBlock(m, host.care())
    );
    reader.append(el);
    const fill = (d) => {
      const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
      const mode = d ? (d.recall_mode === "reflex" ? t("mb.mode.reflex") : t("mb.mode.auto")) : "";
      clear(facts).append(
        ...[
          ["file", str(d?.file)],
          ["created", Number.isFinite(m.created) ? dateStr(m.created) : str(d?.created)],
          ["updated", Number.isFinite(m.at) ? dateStr(m.at) : str(d?.updated)],
          ["mode", mode],
          ["id", m.id],
          ["type", m.type],
          ["scope", str(d?.scope) || ex.scope],
          ["topic", list(d?.topic_path).join(" / ")],
          ["tags", (d ? list(d.tags) : ex.tags).join(" · ")],
          ["source", str(d?.source)],
        ]
          .filter(([, val]) => val)
          .flatMap(([k, val]) => [h("span.mb-rd__fk", { text: t(`mb.f.${k}`) }), h("span.mb-rd__fv", { text: val })])
      );
    };
    fill(null);
    updatePos(pos);
    details.load(m.id).then((d) => {
      if (!alive() || readerFor !== key) return;
      fill(d);
      // RECALL WHEN (prototype box): the memory's own triggers
      const when = Array.isArray(d?.recall_when) ? d.recall_when.filter((x) => typeof x === "string" && x.trim()) : [];
      if (when.length) {
        clear(box).append(
          h("div.mb-rd__boxk", { text: t("mb.recallWhen") }),
          h("div.mb-rd__boxv", { text: when.join(" · ") })
        );
        if (!box.isConnected) el.insertBefore(box, text);
      }
      reflex.hidden = d?.recall_mode !== "reflex";
      const body = str(d?.body).trim();
      text.classList.remove("is-wait");
      if (body) clear(text).append(...markdown(body, host.follow));
      else if (d && box.firstChild?.textContent === t("mb.recallWhen") && m.summary) text.textContent = m.summary;
      else if (d) text.remove();
      else {
        text.classList.add("is-wait");
        text.textContent = t("mb.noBody");
      }
      ed.attach(d);
      restoreScroll(m.id);
    });
  }
  /** The head line: class chip, area (narrows the list to it), type, rule badge, REFLEX, position. */
  function readerTop(m, ed, reflex, pos) {
    return h(
      "div.mb-rd__top",
      null,
      h("span.mb-rd__chip", { text: t(`vv.cls.${m.cls}`), vars: { "--tc": TC[m.cls] || INK } }),
      h(
        "button.mb-rd__area",
        { on: { click: () => host.showArea(m.area) } },
        h("span.mb-rd__adot", { vars: { "--ac": areaCol(m.area) } }),
        m.area
      ),
      m.type ? h("span", { text: m.type }) : null,
      ed.badge,
      reflex,
      pos
    );
  }
  /** Recalled, acted on, use rate and the last load. */
  function readerStats(m, ex) {
    // last load: the newest day of the 30-day series, else the usage clock
    const lastBin = ex.days.findLastIndex((x) => x > 0);
    const last = lastBin >= 0 ? 29 - lastBin : Number.isFinite(ex.lastAt) ? daysAgo(ex.lastAt) : null;
    const stats = [
      [numberFmt.format(m.recalled), "recalled", INK],
      [numberFmt.format(m.acted), "acted", ACC],
      [m.recalled ? `${Math.round((m.acted / m.recalled) * 100)}%` : "—", "rate", m.recalled ? ACC : MUT],
      [last === null ? t("mb.never") : last <= 0 ? t("mb.today") : t("mb.dAgo", { n: last }), "last", INK],
    ];
    return h(
      "div.mb-rd__stats",
      null,
      stats.map(([val, k, col]) =>
        h(
          "div.mb-rd__stat",
          null,
          h("span.mb-rd__sv", { text: val, vars: { "--c": col } }),
          h("span.mb-rd__sk", { text: t(`mb.st.${k}`) })
        )
      )
    );
  }
  /** The linked memories that are in the vault, each one a click away; nothing without any. */
  function readerLinks(m, v) {
    const links = m.links.map((l) => ({ l, o: v.byId.get(l.id) })).filter((x) => x.o);
    if (!links.length) return null;
    return [
      h("div.mb-rd__k", { text: t("mb.linked", { n: links.length }) }),
      h(
        "div.mb-rd__links",
        null,
        links.map(({ l, o }) =>
          h(
            "button.mb-rd__link",
            { on: { click: () => host.follow(o.id) } },
            h("span.mb-rd__rel", {
              text: `${t(`mb.rel.${l.rel}`)} →`,
              vars: { "--rc": l.rel === "linked" ? ACC : MUT },
            }),
            h("span.mb-rd__lt", { text: o.title }),
            h("span.mb-rd__la", null, h("span.mb-rd__ladot", { vars: { "--ac": areaCol(o.area) } }), o.area)
          )
        )
      ),
    ];
  }
  /** Ask the agent, show the memory in the vault view, and the editor's buttons. */
  function readerActs(m, ed) {
    return h(
      "div.mb-rd__acts",
      null,
      h("button.mb-btn.is-primary", {
        text: t("mb.ask"),
        on: { click: () => host.ask(t("mb.askQ", { m: m.title })) },
      }),
      host.showMemory
        ? h("button.mb-btn", {
            text: t(state.view === "ring" ? "mb.inRing" : "mb.inView"),
            on: {
              click: () => {
                const id = m.id;
                host.hide(() => host.showMemory(id));
              },
            },
          })
        : null,
      ed.acts
    );
  }
  /** After a refresh: back to where the reader stood (#1449). */
  function restoreScroll(id) {
    if (keepTop?.id !== id) return;
    reader.scrollTop = keepTop.top;
    keepTop = null;
  }
  /** An open editor or a field the user types in: a refresh waits for it. */
  function readerBusy() {
    const f = document.activeElement;
    return editing(M.sel) || (reader.contains(f) && /^(TEXTAREA|INPUT|SELECT)$/.test(f.tagName));
  }
  /** Same memory, newer data (#1449): fetch first, then redraw at the same
   *  scroll position — no flash of "loading", the selection stays. */
  function refreshReader(key) {
    readerFor = key;
    details.load(key.id).then(() => {
      if (!alive() || readerFor !== key) return;
      // a refresh that overtook another keeps the position from before both
      if (keepTop?.id !== key.id) keepTop = { id: key.id, top: reader.scrollTop };
      renderReader(true);
    });
  }
  function updatePos(el = reader.querySelector(".mb-rd__pos")) {
    if (!el) return;
    const ids = order();
    const i = ids.indexOf(M.sel);
    el.textContent = i >= 0 ? `${i + 1} / ${ids.length}` : "";
  }

  // Editing in the reader (membrowser-edit.js): after a write the graph and
  // this reader reload; an archived memory hands the selection to its neighbour.
  function afterWrite() {
    details.invalidate();
    // the new graph redraws list, counts and reader (onData); without one, the reader alone
    loadGraph().finally(() => {
      if (alive()) renderReader();
    });
  }
  const editDeps = {
    refresh: afterWrite,
    rerender: () => renderReader(),
    reload: (id) => {
      details.invalidate();
      return details.load(id);
    },
    archived: (id) => {
      M.sel = nextSelection(order(), id);
      M.reader = !!M.sel;
      afterWrite();
      return M.sel;
    },
    restored: (id) => {
      Object.assign(M, { sel: id, reader: true, focus: true });
      afterWrite();
    },
  };

  return renderReader;
}
