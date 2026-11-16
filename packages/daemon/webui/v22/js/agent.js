// Agent window (Recall) and the agent pod in the footer.
// Free build: text only — no microphone and no LIVE/realtime button (Pro).
import { h, s, clear, setVars } from "./dom.js";
import { t, numberFmt, LANG } from "./i18n.js";
import { state, setState } from "./state.js";
import { data, chat } from "./data.js";
import { getArea, VAULT_VIEWS } from "./areas.js";
import { pickVaultView } from "./views/pro-views.js";
import { mountJarvis } from "../vendor/jarvis-v13.js";
import { vault, typeClass, inWindow, timeWindow } from "./views/vault-data.js";
import { TC, INK } from "./views/chrome.js";
import { assistantName } from "./sections/settings-model.js";
import { loadingInline, setBusy } from "./sections/loading.js";
import { showInView, openMemoryBrowser, markdown } from "./views/memory-browser.js";

const STATE_COLOR = {
  idle: "var(--muted)",
  listening: "var(--accent)",
  thinking: "var(--amber)",
  speaking: "var(--accent)",
};
// Vault suggestions; areas bring their own via registerArea({ presetKeys }).
const VAULT_PRESETS = ["agent.sug.ring", "agent.sug.week", "agent.sug.unwritten"];

let panel,
  stateEl,
  histBtn,
  faceCanvas,
  jarvis,
  qBox,
  convBox,
  caption,
  srcBox,
  msgBox,
  sugBox,
  inBox,
  input,
  pod,
  podOrb,
  podState,
  nameEl,
  podLine,
  podChev;
// conv: id of the stored conversation (daemon, recall.db); seq drops answers
// that arrive after the user switched to another conversation.
const chatState = { msgs: [], shown: null, typed: "", question: "", history: [], conv: null, seq: 0 };
// List of stored conversations: null = closed, else { items, loading, error }.
let convs = null;
let typeTimer = 0;

// The name the user gave the assistant; the product name until one is set.
export const agentName = () => assistantName() ?? t("agent.name");

function syncName() {
  const name = agentName();
  nameEl.textContent = name;
  panel.setAttribute("aria-label", name);
  faceCanvas.title = name;
}

export function mountAgent(app) {
  stateEl = h("span.agent__state", null, h("span.dot"), h("span"));
  faceCanvas = h("canvas", { title: agentName() });
  qBox = h("div.msg.msg--you");
  caption = h("div.agent__caption.agent__md");
  srcBox = h("div.agent__srcs");
  msgBox = h("div");
  convBox = h("div.agent__convs", { hidden: true });
  sugBox = h("div.agent__sugs");
  input = h("input", {
    placeholder: t("agent.ask"),
    "aria-label": t("agent.askLong"),
    on: {
      input: () => syncInput(),
      keydown: (e) => {
        if (e.key === "Enter" && input.value.trim()) send();
        if (e.key === "Escape") input.blur();
      },
      focus: () => {
        inBox.classList.add("is-focus");
        syncInput();
      },
      blur: () =>
        setTimeout(() => {
          inBox.classList.remove("is-focus");
          syncInput();
        }, 160),
    },
  });
  inBox = h(
    "div.agent__in",
    null,
    input,
    h(
      "button.agent__send",
      { "aria-label": t("agent.send"), on: { click: send } },
      s("svg", { viewBox: "0 0 24 24" }, s("path", { d: "M5 12h14M13 6l6 6-6 6" }))
    )
  );
  panel = h(
    "section.agent",
    { "aria-label": agentName() },
    h(
      "div.agent__head",
      null,
      (nameEl = h("span.agent__name", { text: agentName() })),
      h("span.agent__role", { text: t("agent.role") }),
      stateEl,
      (histBtn = h(
        "button.agent__hbtn",
        { type: "button", title: t("agent.history"), "aria-label": t("agent.history"), on: { click: toggleConvs } },
        s("svg", { viewBox: "0 0 24 24" }, s("path", { d: "M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4M12 8v4l3 2" }))
      )),
      h(
        "button.agent__hbtn",
        { type: "button", title: t("agent.new"), "aria-label": t("agent.new"), on: { click: newConversation } },
        s("svg", { viewBox: "0 0 24 24" }, s("path", { d: "M12 5v14M5 12h14" }))
      )
    ),
    h("div.agent__face", null, faceCanvas),
    h("div.agent__body", null, convBox, qBox, caption, srcBox, msgBox, sugBox),
    h("div.agent__foot", null, inBox)
  );

  podOrb = h("span.orb", null, h("span.orb__ring"), h("span.orb__rim"), h("span.orb__core"));
  podState = h("span.pod__state");
  podLine = h("span.pod__line");
  podChev = h("span.pod__chev");
  pod = h(
    "button.pod",
    { on: { click: () => setState({ jOpen: !state.jOpen }) } },
    h("span.pod__orb", null, podOrb),
    h("span.pod__txt", null, podState, podLine),
    podChev
  );

  app.append(panel, pod);
  jarvis = mountJarvis(faceCanvas, { scale: 0.27 });
  syncInput();
  // The conversation open before a reload comes back (stored in recall.db).
  const last = storedConv();
  if (last) openConversation(last, null, true);
}

// The other footer variants (mirror, drawer, island) show the same agent
// status as the pod; they read it here and re-render on every change.
const podListeners = new Set();
let podText = "";
export function onPodChange(fn) {
  podListeners.add(fn);
}
export function podInfo() {
  const ag = state.agent;
  return {
    state: `${agentName().toUpperCase()} · ${t(`agent.state.${ag}`)}`,
    color: STATE_COLOR[ag],
    busy: ag !== "idle",
    text: podText,
  };
}

function syncInput() {
  const active = document.activeElement === input || !!input.value;
  inBox.classList.toggle("is-active", active);
  input.placeholder = active ? t("agent.askLong") : t("agent.ask");
}

function greeting() {
  const area = getArea(state.view);
  if (area?.greetingKey) return t(area.greetingKey);
  return data.newMemories ? t("agent.greetingNew", { n: data.newMemories }) : t("agent.greeting");
}

export function ask(q) {
  q = (q || "").trim();
  if (!q) return;
  clearInterval(typeTimer);
  if (chatState.shown)
    chatState.msgs.push(
      { role: "you", text: chatState.shown.q },
      { role: "recall", text: chatState.shown.a, sources: chatState.shown.sources }
    );
  chatState.shown = null;
  chatState.typed = "";
  chatState.question = q;
  convs = null;
  const seq = ++chatState.seq;
  setState({ jOpen: true, focus: null, agent: "thinking", hits: [] });
  render();
  const history = chatState.history.slice(-6);
  chat(q, history, chatState.conv, state.view, LANG)
    .then(async ({ ok, status, body }) => {
      if (seq !== chatState.seq) return;
      let answer,
        sources = [];
      if (ok && typeof body.reply === "string") {
        answer = body.reply;
        if (typeof body.navigate === "string") {
          if (VAULT_VIEWS.includes(body.navigate)) pickVaultView(body.navigate);
          else if (getArea(body.navigate)?.kind === "view") setState({ view: body.navigate, hover: null });
        }
        if (typeof body.conversation_id === "string") {
          chatState.conv = body.conversation_id;
          storeConv(chatState.conv);
        }
        sources = Array.isArray(body.hits)
          ? body.hits
              .filter((x) => x && typeof x.title === "string")
              .slice(0, 3)
              .map((x) => [x.title, String(x.type || ""), typeof x.id === "string" ? x.id : ""])
          : [];
      } else if (status === 503) {
        answer = t("agent.noModel");
        try {
          const r = await fetch(`/ui/search?q=${encodeURIComponent(q)}`);
          const b = await r.json();
          sources = (Array.isArray(b.hits) ? b.hits : [])
            .filter((x) => x && typeof x.title === "string")
            .slice(0, 3)
            .map((x) => [x.title, String(x.type || ""), typeof x.id === "string" ? x.id : ""]);
        } catch {
          /* none */
        }
      } else answer = t("agent.error");
      if (seq !== chatState.seq) return;
      chatState.history.push({ role: "user", content: q }, { role: "assistant", content: answer });
      typeOut({ q, a: answer, sources });
    })
    .catch(() => {
      if (seq === chatState.seq) typeOut({ q, a: t("agent.error"), sources: [] });
    });
}

function typeOut(p) {
  clearInterval(typeTimer);
  // Hit ids of the answer, numbered 1–3 on the vault views (js/views/).
  setState({ agent: "speaking", hits: p.sources.map((x) => x[2]).filter(Boolean) });
  let i = 0;
  const timer = (typeTimer = setInterval(() => {
    i += 4;
    chatState.typed = p.a.slice(0, i);
    render();
    if (i >= p.a.length) {
      clearInterval(timer);
      if (typeTimer === timer) typeTimer = 0;
      chatState.shown = p;
      chatState.typed = "";
      setState({ agent: "idle" });
      render();
    }
  }, 56));
}

/** Answer text as safe DOM (memory-browser's mini markdown: code, bold, lists,
 *  http(s) links in a new tab, [[memory]] links open the memory). */
function md(text, caret) {
  const nodes = markdown(String(text || ""), (id) => openSource(id, null));
  if (caret) {
    const last = nodes[nodes.length - 1];
    const host =
      last?.tagName === "UL" ? last.lastElementChild : last?.tagName === "P" || last?.tagName === "H3" ? last : null;
    if (host) host.append(h("span.agent__caret"));
    else nodes.push(h("span.agent__caret"));
  }
  return nodes;
}

const CONV_KEY = "recall-v22-agent-conv";
function storedConv() {
  try {
    return localStorage.getItem(CONV_KEY) || null;
  } catch {
    return null;
  }
}
function storeConv(id) {
  try {
    if (id) localStorage.setItem(CONV_KEY, id);
    else localStorage.removeItem(CONV_KEY);
  } catch {
    /* private mode */
  }
}

/** "vor 2 Std." / "2 h ago" from a timestamp. */
function agoText(ms) {
  const min = Math.max(1, (Date.now() - ms) / 60000);
  const [k, n] =
    min < 60
      ? ["min", min]
      : min < 1440
        ? ["h", min / 60]
        : min < 10080
          ? ["d", min / 1440]
          : min < 43200
            ? ["w", min / 10080]
            : ["mo", min / 43200];
  return t(`agent.ago.${k}`, { n: Math.round(n) });
}

function srcButtons(list) {
  return list.map(([title, type, id], i) => {
    const m = id ? vault()?.byId.get(id) : null;
    const doc = type === "doc" || m?.kind === "doc";
    return h(
      "button.agent__src",
      {
        type: "button",
        disabled: !id,
        title: id ? t("agent.srcOpen") : undefined,
        vars: { "--tc": TC[doc ? "reference" : typeClass(type)] || INK },
        on: { click: (e) => openSource(id, e.currentTarget) },
      },
      h("span.agent__src-n", { text: String(i + 1) }),
      h("span.agent__src-t", { text: title }),
      h("span.agent__src-k", { text: typeLabel(type, doc) })
    );
  });
}

// ── stored conversations (GET/DELETE /ui/chat/conversations, recall.db) ──
function stopTyping() {
  clearInterval(typeTimer);
  chatState.seq++;
  chatState.typed = "";
}

/** Empties the window; the next question starts a new stored conversation. */
function newConversation() {
  stopTyping();
  Object.assign(chatState, { msgs: [], shown: null, question: "", history: [], conv: null });
  storeConv(null);
  convs = null;
  setState({ agent: "idle", hits: [] });
  render();
  input?.focus();
}

function toggleConvs() {
  if (convs) {
    convs = null;
    render();
    return;
  }
  convs = { items: [], loading: true, error: false };
  render();
  fetch("/ui/chat/conversations", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((b) => {
      if (convs) Object.assign(convs, { items: Array.isArray(b.conversations) ? b.conversations : [], loading: false });
    })
    .catch(() => {
      if (convs) Object.assign(convs, { loading: false, error: true });
    })
    .finally(() => render());
}

const toSources = (list) =>
  (Array.isArray(list) ? list : [])
    .filter((x) => x && typeof x.title === "string")
    .slice(0, 3)
    .map((x) => [x.title, String(x.type || ""), typeof x.id === "string" ? x.id : ""]);

async function openConversation(id, row, quiet) {
  setBusy(row, true);
  try {
    const r = await fetch(`/ui/chat/conversations/${encodeURIComponent(id)}`, { credentials: "same-origin" });
    if (r.status === 404) {
      if (storedConv() === id) storeConv(null);
      if (quiet) return;
    }
    if (!r.ok) throw new Error(String(r.status));
    const b = await r.json();
    // A reload restore never overrides a question asked in the meantime.
    if (quiet && (chatState.question || chatState.conv)) return;
    const ex = [];
    const list = Array.isArray(b.messages) ? b.messages : [];
    for (let i = 0; i + 1 < list.length; i++)
      if (list[i].role === "user" && list[i + 1].role === "assistant") {
        ex.push({ q: String(list[i].text), a: String(list[i + 1].text), sources: toSources(list[i + 1].sources) });
        i++;
      }
    stopTyping();
    const last = ex.pop() || null;
    Object.assign(chatState, {
      conv: id,
      shown: last,
      question: last ? last.q : "",
      msgs: ex.flatMap((e) => [
        { role: "you", text: e.q },
        { role: "recall", text: e.a, sources: e.sources },
      ]),
      history: [...ex, ...(last ? [last] : [])].flatMap((e) => [
        { role: "user", content: e.q },
        { role: "assistant", content: e.a },
      ]),
    });
    storeConv(id);
    convs = null;
    // A restored conversation on page load (quiet) shows no hit marks: without
    // the answer on screen a numbered mark on the map has no explanation.
    setState({ agent: "idle", hits: !quiet && last ? last.sources.map((x) => x[2]).filter(Boolean) : [] });
    render();
  } catch {
    if (quiet) return;
    if (convs) convs.error = true;
    render();
  } finally {
    setBusy(row, false);
  }
}

async function deleteConversation(id, btn) {
  setBusy(btn, true);
  try {
    const r = await fetch(`/ui/chat/conversations/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    });
    if (!r.ok && r.status !== 404) throw new Error(String(r.status));
    if (convs) convs.items = convs.items.filter((c) => c.id !== id);
    if (chatState.conv === id) {
      chatState.conv = null;
      storeConv(null);
    } // further questions start a new one
  } catch {
    if (convs) convs.error = true;
  }
  setBusy(btn, false);
  render();
}

function renderConvs() {
  const open = !!convs;
  convBox.hidden = !open;
  histBtn.classList.toggle("is-on", open);
  histBtn.setAttribute("aria-pressed", String(open));
  for (const el of [qBox, caption, srcBox, msgBox, sugBox]) el.classList.toggle("is-off", open);
  if (!open) {
    clear(convBox);
    return;
  }
  clear(convBox).append(h("span.agent__srcs-l", { text: t("agent.convs") }));
  if (convs.loading) {
    convBox.append(loadingInline(t("agent.convsLoading")));
    return;
  }
  if (convs.error) convBox.append(h("p.agent__convs-note", { text: t("agent.convsError") }));
  if (!convs.items.length && !convs.error) {
    convBox.append(h("p.agent__convs-note", { text: t("agent.convsEmpty") }));
    return;
  }
  convBox.append(
    ...convs.items.map((c) => {
      const row = h(
        "button.agent__conv-open",
        {
          type: "button",
          cls: c.id === chatState.conv ? "is-cur" : "",
          on: { click: () => openConversation(c.id, row) },
        },
        h("span.agent__conv-t", { text: c.title }),
        h("span.agent__conv-m", {
          text: `${c.count === 1 ? t("agent.convCount1") : t("agent.convCount", { n: c.count })} · ${Number.isFinite(c.updated) ? agoText(c.updated) : ""}`,
        })
      );
      const del = h("button.agent__conv-del", {
        type: "button",
        title: t("agent.convDelete"),
        "aria-label": t("agent.convDelete"),
        text: "×",
        on: { click: () => deleteConversation(c.id, del) },
      });
      return h("div.agent__conv", null, row, del);
    })
  );
}

/** Plain type name: reference/bookmark "Reference", a stored document "Document",
 *  otherwise the display class (decision, rule, convention, fact, note). */
function typeLabel(type, doc) {
  if (doc) return t("agent.type.doc");
  if (type === "reference" || type === "bookmark") return t("agent.type.reference");
  return t(`vv.cls.${typeClass(type)}`);
}

/** A source: focus it in the open vault view (glide + info card); without a
 *  vault view, or when it is outside the view's time window, the memory
 *  browser opens on it with the reader. */
function openSource(id, el) {
  if (!id) return;
  const m = vault()?.byId.get(id);
  if (m && inWindow(m, timeWindow()) && showInView(id)) return;
  openMemoryBrowser(m?.area || "all", id, el?.getBoundingClientRect());
}

function send() {
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  input.blur();
  syncInput();
  ask(q);
}

export function render(L) {
  syncName();
  if (L) {
    panel.classList.toggle("is-open", L.jOpen);
    jarvis?.setActive?.(L.jOpen);
    pod.title = L.pinAgent ? agentName() : L.jOpen ? t("pod.title.close") : t("pod.title.open");
    podChev.textContent = L.pinAgent ? "" : L.jOpen ? "◂" : "▸";
    pod.classList.toggle("is-lit", L.jOpen || state.agent !== "idle");
  }
  const ag = state.agent;
  jarvis?.set?.(ag);
  setVars(panel, { "--state-c": STATE_COLOR[ag] });
  setVars(pod, { "--state-c": STATE_COLOR[ag] });
  stateEl.lastChild.textContent = t(`agent.state.${ag}`);
  pod.classList.toggle("is-busy", ag !== "idle");
  podOrb.classList.toggle("is-fast", ag !== "idle");
  podState.textContent = podInfo().state;
  const total = numberFmt.format(data.health?.vault_size ?? 0);
  const cap =
    ag === "speaking"
      ? chatState.typed
      : ag === "thinking"
        ? t("agent.thinking", { n: total })
        : chatState.shown
          ? chatState.shown.a
          : greeting();
  clear(caption).append(...md(cap, ag === "speaking" || ag === "thinking"));
  // Short windows: with a question on screen the face steps back so that
  // question, the start of the answer and its sources fit without scrolling.
  panel.classList.toggle("is-compact", !!chatState.question && !convs && state.vh < 760);
  podLine.textContent =
    ag === "speaking"
      ? chatState.typed
      : ag === "thinking"
        ? t("agent.thinking", { n: total })
        : chatState.shown
          ? chatState.shown.sources.length === 1
            ? t("pod.answered1")
            : t("pod.answered", { n: chatState.shown.sources.length })
          : data.newMemories
            ? t("pod.newMemories", { n: data.newMemories })
            : t("pod.ready");
  podText = podLine.textContent;
  for (const fn of podListeners) fn();
  // The question being answered stands above its answer (Daniel, 13.11.2026).
  qBox.textContent = chatState.question;
  qBox.hidden = !chatState.question;
  clear(srcBox);
  if (chatState.shown && ag === "idle" && chatState.shown.sources.length)
    srcBox.append(h("span.agent__srcs-l", { text: t("agent.sources") }), ...srcButtons(chatState.shown.sources));
  // Earlier exchanges below, newest first, each question above its answer
  // and the answer's sources (clickable as above).
  const pairs = [];
  for (let i = 0; i + 1 < chatState.msgs.length; i += 2) pairs.unshift([chatState.msgs[i], chatState.msgs[i + 1]]);
  clear(msgBox).append(
    ...(pairs.length ? [h("span.agent__srcs-l", { text: t("agent.earlier") })] : []),
    ...pairs.flatMap(([you, rec]) => [
      h("div.msg.msg--you", { text: you.text }),
      h("div.msg.msg--recall.agent__md", null, ...md(rec.text)),
      ...(rec.sources?.length ? [h("div.agent__srcs.agent__srcs--old", null, ...srcButtons(rec.sources))] : []),
    ])
  );
  msgBox.className = pairs.length ? "agent__srcs agent__hist" : "";
  renderConvs();
  const keys = getArea(state.view)?.presetKeys || VAULT_PRESETS;
  const used = new Set([chatState.shown?.q, ...chatState.msgs.map((m) => m.text)]);
  clear(sugBox).append(
    ...keys
      .map((k) => t(k))
      .filter((q) => !used.has(q))
      .slice(0, state.vh < 760 ? 1 : 2)
      .map((q) => h("button.agent__sug", { on: { click: () => ask(q) } }, h("span", { text: "↳" }), q))
  );
}
