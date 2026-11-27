// Areas, Import and Onboarding dialogs (SCREENS.md › „Import, Areas-Dialog,
// Onboarding: echt, nur Look anpassen“). Same endpoints and behaviour as the
// classic UI (webui/js/managers/areas-manager.js, import-dialog.js,
// onboarding-dialog.js); only the look is web UI (pop-over rules,
// DESIGN-SYSTEM.md § 1.8 and § 5).
//   Areas      GET/POST /ui/areas          create · rename · delete (→ vault trash)
//   Import     POST /ui/import             stage a pasted list for review
//              POST /ui/import-vault       import a whole folder (isolated set)
//              GET  /ui/fs?path=           folder picker (directories only)
//              GET  /ui/import-count       open candidates → nav badge
//   Onboarding GET/POST /ui/onboarding     auto-opens on a fresh vault
import { addStrings, t } from "../i18n.js";
import { registerArea, ICON } from "../areas.js";
import { loadGraph } from "../data.js";
import { h, clear } from "../dom.js";
import { cover } from "../cover.js";
import { loadingInline, setBusy, touched } from "./loading.js";
import en from "../i18n/dialogs-en.js";
import de from "../i18n/dialogs-de.js";

addStrings(en, de);

async function call(url, body) {
  const r = await fetch(
    url,
    body === undefined
      ? { credentials: "same-origin" }
      : {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
  );
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof d?.error === "string" ? d.error : `${url} → ${r.status}`);
  return d;
}

// ── dialog frame ──────────────────────────────────────────────────────────
let openDlg = null;

/** Opens a modal pop-over; returns { box, body, close }. onClose runs once. */
export function dialog({ kicker, title, cls = "", onClose, canClose = () => true }) {
  openDlg?.close();
  const body = h("div.dlg__body");
  const box = h(
    "div.dlg__box",
    { cls, role: "dialog", "aria-modal": "true", "aria-label": title },
    h(
      "div.dlg__head",
      null,
      h("div.dlg__hl", null, h("span.dlg__kicker", { text: kicker }), h("h2.dlg__title", { text: title })),
      h("button.dlg__x", {
        title: t("dlg.close"),
        "aria-label": t("dlg.close"),
        text: "×",
        on: { click: () => close() },
      })
    ),
    body
  );
  const veil = h(
    "div.dlg",
    {
      on: {
        pointerdown: (e) => {
          if (e.target === veil) close();
        },
      },
    },
    box
  );
  const onKey = (e) => {
    if (e.key === "Escape" && canClose()) {
      e.stopPropagation();
      close();
    }
  };
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    veil.remove();
    if (openDlg?.veil === veil) {
      openDlg = null;
      cover("dlg", false);
    }
    onClose?.();
  }
  document.addEventListener("keydown", onKey);
  document.body.append(veil);
  openDlg = { veil, close };
  cover("dlg", true); // the view under the veil stands still (js/cover.js)
  return { box, body, close };
}

export const btn = (text, onClick, cls = "") => h("button.dlg-btn", { cls, text, on: { click: onClick } });
export const status = () => h("span.dlg__status");
export function setStatus(el, text, kind = "") {
  el.className = `dlg__status${kind ? " is-" + kind : ""}`;
  // busy: the request is on its way (run indicator, js/sections/loading.js)
  if (kind === "busy") clear(el).append(loadingInline(text));
  else el.textContent = text;
}

// ── Areas ─────────────────────────────────────────────────────────────────
function openAreas() {
  let busy = false,
    mutated = false,
    armed = null;
  const list = h("ul.dlg-list");
  const count = h("span.dlg__count");
  const st = status();
  const nameIn = h("input.dlg-in", {
    type: "text",
    spellcheck: "false",
    placeholder: t("ar.placeholder"),
    on: {
      keydown: (e) => {
        if (e.key === "Enter") create();
      },
    },
  });
  const { body } = dialog({
    kicker: t("ar.kicker"),
    title: t("ar.title"),
    cls: "dlg--areas",
    canClose: () => !list.querySelector(".dlg-rename"),
    onClose: () => {
      if (mutated) loadGraph();
    },
  });
  body.append(
    h("p.dlg__text", { text: t("ar.help") }),
    count,
    list,
    h("div.dlg__row", null, nameIn, btn(t("ar.create"), create, "is-primary")),
    st
  );
  nameIn.focus();

  async function mutate(payload, okText) {
    if (busy) return false;
    busy = true;
    setStatus(st, t("dlg.working"), "busy");
    const el = touched();
    setBusy(el, true);
    try {
      await call("/ui/areas", payload);
      mutated = true;
      setStatus(st, okText, "ok");
      await render();
      return true;
    } catch (err) {
      setStatus(st, err.message, "err");
      return false;
    } finally {
      busy = false;
      setBusy(el, false);
    }
  }
  async function create() {
    const name = nameIn.value.trim();
    if (!name) return;
    if (await mutate({ action: "create", name }, t("ar.created", { name }))) nameIn.value = "";
  }
  function row(a) {
    const name = h("span.dlg-list__name", { text: a.name });
    const li = h(
      "li.dlg-list__row",
      null,
      name,
      h("span.dlg-list__kind", { text: a.kind === "project" ? t("ar.project") : t("ar.folder") }),
      h("span.dlg-list__n", { text: String(a.count) })
    );
    if (a.reserved) {
      li.append(h("span.dlg-list__lock", { text: t("ar.system") }));
      return li;
    }
    const del = btn(
      t("ar.delete"),
      async () => {
        const key = `${a.kind}:${a.name}`;
        if (armed !== key) {
          armed = key;
          del.textContent = t("ar.sure");
          del.classList.add("is-armed");
          setStatus(st, t("ar.armed", { name: a.name }));
          return;
        }
        armed = null;
        await mutate({ action: "delete", kind: a.kind, name: a.name }, t("ar.deleted", { name: a.name }));
      },
      "is-sm is-danger"
    );
    const ren = btn(
      t("ar.rename"),
      () => {
        // Inline rename: Enter commits, Esc or blur cancels.
        const input = h("input.dlg-in.dlg-rename", { type: "text", value: a.name });
        name.replaceWith(input);
        input.focus();
        input.select();
        const done = () => {
          if (input.isConnected) input.replaceWith(name);
        };
        input.addEventListener("keydown", async (e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            done();
            return;
          }
          if (e.key !== "Enter") return;
          const to = input.value.trim();
          if (!to || to === a.name) {
            done();
            return;
          }
          await mutate(
            { action: "rename", kind: a.kind, name: a.name, newName: to },
            t("ar.renamed", { from: a.name, to })
          );
        });
        input.addEventListener("blur", done);
      },
      "is-sm"
    );
    li.append(h("span.dlg-list__acts", null, ren, del));
    return li;
  }
  async function render() {
    armed = null;
    let areas;
    if (!list.children.length) list.append(h("li.dlg-list__empty", null, loadingInline(t("dlg.working"))));
    try {
      const d = await call("/ui/areas");
      areas = Array.isArray(d.areas) ? d.areas.filter((a) => a && typeof a.name === "string") : [];
    } catch (err) {
      setStatus(st, err.message, "err");
      return;
    }
    count.textContent = t("ar.count", { n: areas.length });
    clear(list).append(...(areas.length ? areas.map(row) : [h("li.dlg-list__empty", { text: t("ar.empty") })]));
  }
  render();
}

// ── Import ────────────────────────────────────────────────────────────────
const SOURCES = [
  ["chatgpt", "ChatGPT"],
  ["claude", "Claude"],
  ["gemini", "Gemini"],
  ["text", null],
];
let importOpen = 0;

async function refreshImportCount() {
  try {
    const d = await call("/ui/import-count");
    const n = typeof d.open === "number" ? d.open : 0;
    if (n !== importOpen) {
      importOpen = n;
      document.dispatchEvent(new CustomEvent("recall:areas"));
    }
  } catch {
    /* daemon busy: next poll */
  }
}

function openImport() {
  let source = "chatgpt",
    busy = false;
  const { body } = dialog({ kicker: t("im.kicker"), title: t("im.title"), cls: "dlg--import" });
  const hint = h("p.dlg__hint", { text: t("im.hint.chatgpt") });
  const seg = h(
    "div.dlg-seg",
    null,
    SOURCES.map(([id, label]) =>
      h("button", {
        cls: id === source ? "is-on" : "",
        "data-source": id,
        text: label || t("im.src.text"),
        on: { click: () => pick(id) },
      })
    )
  );
  function pick(id) {
    source = id;
    hint.textContent = t(`im.hint.${id}`);
    for (const b of seg.children) b.classList.toggle("is-on", b.dataset.source === id);
  }
  const text = h("textarea.dlg-ta", { rows: 9, spellcheck: "false", placeholder: t("im.placeholder") });
  const file = h("input", { type: "file", accept: ".txt,.md,.json", hidden: true });
  const st = status();
  const next = h("p.dlg__next", { hidden: true, text: t("im.next") });
  const waiting = importOpen > 0 ? h("p.dlg__next", { text: t("im.waiting", { n: importOpen }) }) : null;
  const stage = btn(
    t("im.stage"),
    async () => {
      const v = text.value.trim();
      if (!v || busy) return;
      busy = true;
      stage.disabled = true;
      setBusy(stage, true);
      setStatus(st, t("im.staging"), "busy");
      try {
        const r = await call("/ui/import", { text: v, source });
        setStatus(
          st,
          t("im.staged", { n: r.staged }) +
            (r.skipped_duplicates > 0 ? t("im.dupes", { n: r.skipped_duplicates }) : "") +
            t("im.open", { n: r.open_total }),
          "ok"
        );
        next.hidden = false;
        waiting?.remove();
        text.value = "";
        refreshImportCount();
      } catch (err) {
        setStatus(st, err.message, "err");
      } finally {
        busy = false;
        stage.disabled = false;
        setBusy(stage, false);
      }
    },
    "is-primary"
  );
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    file.value = "";
    if (!f) return;
    // bastra's own vault files are never import sources (the server checks too).
    if (/^(import-review|vault-care|report)\.md$/i.test(f.name)) {
      setStatus(st, t("im.own", { name: f.name }), "err");
      return;
    }
    text.value = await f.text();
    const n = f.name.toLowerCase();
    const hinted = /chatgpt|openai/.test(n)
      ? "chatgpt"
      : /claude|anthropic/.test(n)
        ? "claude"
        : /gemini|takeout/.test(n)
          ? "gemini"
          : null;
    if (hinted) pick(hinted);
    setStatus(st, t("im.loaded", { name: f.name }));
  });

  body.append(
    ...[
      h("p.dlg__text", { text: t("im.help") }),
      waiting,
      seg,
      hint,
      text,
      h(
        "div.dlg__row",
        null,
        file,
        btn(t("im.choose"), () => file.click()),
        st
      ),
      h(
        "div.dlg__foot",
        null,
        btn(t("dlg.close"), () => openDlg?.close()),
        stage
      ),
      next,
      folderImport(),
    ].filter(Boolean)
  );
  text.focus();
}

function folderImport() {
  let busy = false,
    browsePath = null;
  const dir = h("input.dlg-in", { type: "text", spellcheck: "false", placeholder: t("im.dir") });
  const label = h("input.dlg-in.dlg-in--label", { type: "text", spellcheck: "false", placeholder: t("im.label") });
  const st = status();
  const bPath = h("div.dlg-fs__path"),
    bList = h("ul.dlg-fs__list");
  const browser = h(
    "div.dlg-fs",
    { hidden: true },
    bPath,
    bList,
    h(
      "div.dlg__foot",
      null,
      btn(t("im.use"), () => {
        if (browsePath) dir.value = browsePath;
        browser.hidden = true;
      })
    )
  );
  async function browse(path) {
    setBusy(bList, true);
    let d;
    try {
      d = await call(`/ui/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`);
    } finally {
      setBusy(bList, false);
    }
    browsePath = typeof d.path === "string" ? d.path : null;
    bPath.textContent = browsePath || "";
    const go = (p) => () => browse(p).catch((e) => setStatus(st, e.message, "err"));
    clear(bList);
    if (typeof d.parent === "string") bList.append(h("li.dlg-fs__up", { text: "..", on: { click: go(d.parent) } }));
    for (const x of Array.isArray(d.dirs) ? d.dirs : []) {
      if (!x || typeof x.name !== "string" || typeof x.path !== "string") continue;
      bList.append(
        h(
          "li",
          { on: { click: go(x.path) } },
          h("span.dlg-fs__name", { text: x.name }),
          x.md > 0 ? h("span.dlg-fs__n", { text: t("im.md", { n: x.md }) }) : null
        )
      );
    }
  }
  const run = btn(
    t("im.run"),
    async () => {
      const v = dir.value.trim();
      if (!v || busy) return;
      busy = true;
      run.disabled = true;
      setBusy(run, true);
      setStatus(st, t("im.importing"), "busy");
      try {
        const r = await call("/ui/import-vault", { dir: v, label: label.value.trim() || undefined });
        setStatus(
          st,
          t("im.imported", { n: r.imported, m: r.scanned, folder: r.folder }) +
            (r.skipped > 0 ? t("im.skipped", { n: r.skipped }) : "") +
            (r.orphaned > 0 ? t("im.orphaned", { n: r.orphaned }) : ""),
          "ok"
        );
        loadGraph();
      } catch (err) {
        setStatus(st, err.message, "err");
      } finally {
        busy = false;
        run.disabled = false;
        setBusy(run, false);
      }
    },
    "is-primary"
  );
  const content = h(
    "div.dlg-fold__in",
    { hidden: true },
    h("p.dlg__text", { text: t("im.folderHelp") }),
    h(
      "div.dlg__row",
      null,
      dir,
      btn(t("im.browse"), () => {
        if (!browser.hidden) {
          browser.hidden = true;
          return;
        }
        browser.hidden = false;
        browse(dir.value.trim() || null).catch(() => browse(null).catch((e) => setStatus(st, e.message, "err")));
      })
    ),
    h("div.dlg__row", null, label, run),
    browser,
    st
  );
  const toggle = h(
    "button.dlg-fold__t",
    {
      "aria-expanded": "false",
      on: {
        click: () => {
          content.hidden = !content.hidden;
          toggle.setAttribute("aria-expanded", String(!content.hidden));
          toggle.classList.toggle("is-open", !content.hidden);
        },
      },
    },
    h("span.dlg-fold__chev", { text: "›" }),
    t("im.folder")
  );
  return h("div.dlg-fold", null, toggle, content);
}

// ── Onboarding ────────────────────────────────────────────────────────────
const SNOOZE_KEY = "bastra-onboarding-later";

function openOnboarding(catalog) {
  const personas = Array.isArray(catalog.personas) ? catalog.personas.filter((p) => p && typeof p.id === "string") : [];
  const questions = Array.isArray(catalog.questions)
    ? catalog.questions.filter((q) => q && typeof q.id === "string")
    : [];
  let persona = null,
    steps = [],
    idx = -1,
    busy = false;
  const answers = {};
  const { body, close } = dialog({ kicker: t("ob.kicker"), title: t("ob.title"), cls: "dlg--onboard" });
  const help = h("p.dlg__text", { text: t("ob.help") });
  const step = h("div.dlg-ob");
  const prog = h("span.dlg__status");
  const never = btn(t("ob.never"), async () => {
    if (busy) return;
    try {
      await call("/ui/onboarding", { skip: true });
    } catch {
      /* best effort: closing is what was asked */
    }
    close();
  });
  const later = btn(t("ob.later"), () => {
    try {
      sessionStorage.setItem(SNOOZE_KEY, "1");
    } catch {
      /* blocked */
    }
    close();
  });
  const back = btn(t("ob.back"), () => {
    if (busy) return;
    collect();
    if (idx <= 0) renderPersona();
    else renderQuestion(idx - 1);
  });
  const next = btn(t("ob.next"), onNext, "is-primary");
  body.append(help, step, prog, h("div.dlg__foot", null, never, later, h("span.dlg__sp"), back, next));

  function renderPersona() {
    idx = -1;
    clear(step).append(
      h(
        "div.dlg-ob__personas",
        null,
        personas.map((p) =>
          h("button.dlg-ob__p", {
            text: typeof p.label === "string" ? p.label : p.id,
            on: {
              click: () => {
                persona = p.id;
                steps = questions.filter((q) => !Array.isArray(q.personas) || q.personas.includes(p.id));
                if (steps.length) renderQuestion(0);
              },
            },
          })
        )
      )
    );
    prog.textContent = t("ob.persona");
    next.hidden = true;
    back.hidden = true;
  }
  function renderQuestion(i) {
    idx = i;
    const q = steps[i];
    const ta = h("textarea.dlg-ta", { rows: 3, placeholder: typeof q.hint === "string" ? q.hint : "" });
    ta.value = answers[q.id] ?? "";
    clear(step).append(h("div.dlg-ob__ask", { text: typeof q.ask === "string" ? q.ask : q.id }), ta);
    prog.textContent = t("ob.step", { i: i + 1, n: steps.length }) + (q.optional ? t("ob.optional") : "");
    back.hidden = false;
    next.hidden = false;
    next.textContent = i === steps.length - 1 ? t("ob.save") : t("ob.next");
    ta.focus();
  }
  function collect() {
    const ta = step.querySelector("textarea");
    if (ta && idx >= 0) answers[steps[idx].id] = ta.value;
  }
  let finished = false;
  async function onNext() {
    if (busy) return;
    if (finished) {
      close();
      return;
    }
    collect();
    if (idx < steps.length - 1) {
      renderQuestion(idx + 1);
      return;
    }
    busy = true;
    next.disabled = true;
    setBusy(next, true);
    next.textContent = t("ob.saving");
    try {
      const r = await call("/ui/onboarding", { persona, answers });
      finished = true;
      help.textContent = t("ob.saved", { n: r.saved });
      clear(step);
      prog.textContent = "";
      back.hidden = true;
      later.hidden = true;
      never.hidden = true;
      next.textContent = t("ob.done");
      loadGraph();
    } catch (err) {
      prog.textContent = err.message;
      next.textContent = t("ob.save");
    } finally {
      busy = false;
      next.disabled = false;
      setBusy(next, false);
    }
  }
  renderPersona();
}

// Auto-open on a fresh vault, unless snoozed for this browser session
// (same rule and key as the classic UI).
(async () => {
  let snoozed = false;
  try {
    snoozed = sessionStorage.getItem(SNOOZE_KEY) === "1";
  } catch {
    /* blocked */
  }
  if (snoozed) return;
  try {
    const c = await call("/ui/onboarding");
    if (c && c.needed === true) openOnboarding(c);
  } catch {
    /* ui disabled or daemon hiccup: never block the shell */
  }
})();

// ── navigation entries (replace the placeholders from js/areas.js) ────────
registerArea({
  id: "areas",
  group: "manage",
  order: 1,
  labelKey: "nav.areas",
  titleKey: "nav.areasTitle",
  icon: ICON.areas,
  kind: "action",
  onAction: openAreas,
});
registerArea({
  id: "import",
  group: "manage",
  order: 2,
  labelKey: "nav.import",
  titleKey: "nav.importTitle",
  icon: ICON.import,
  kind: "action",
  onAction: openImport,
  badge: () => importOpen,
});

refreshImportCount();
setInterval(() => {
  if (!document.hidden) refreshImportCount();
}, 30000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshImportCount();
});
