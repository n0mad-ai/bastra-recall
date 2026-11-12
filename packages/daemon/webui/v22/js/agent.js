// Agent window (Recall) and the agent pod in the footer.
// Free build: text only — no microphone and no LIVE/realtime button (Pro).
import { h, s, clear, setVars } from "./dom.js";
import { t, numberFmt } from "./i18n.js";
import { state, setState } from "./state.js";
import { data, chat } from "./data.js";
import { getArea } from "./areas.js";
import { mountJarvis } from "../vendor/jarvis-v13.js";

const STATE_COLOR = { idle: "var(--muted)", listening: "var(--accent)", thinking: "var(--amber)", speaking: "var(--accent)" };
// Vault suggestions; areas bring their own via registerArea({ presetKeys }).
const VAULT_PRESETS = ["agent.sug.ring", "agent.sug.week", "agent.sug.unwritten"];

let panel, stateEl, faceCanvas, jarvis, caption, srcBox, msgBox, sugBox, inBox, input, pod, podOrb, podState, podLine, podChev;
const chatState = { msgs: [], shown: null, typed: "", history: [] };
let typeTimer = 0;

export function mountAgent(app) {
  stateEl = h("span.agent__state", null, h("span.dot"), h("span"));
  faceCanvas = h("canvas", { title: t("agent.name") });
  caption = h("p.agent__caption");
  srcBox = h("div.agent__srcs");
  msgBox = h("div");
  sugBox = h("div.agent__sugs");
  input = h("input", { placeholder: t("agent.ask"), "aria-label": t("agent.askLong"), on: {
    input: () => syncInput(),
    keydown: (e) => { if (e.key === "Enter" && input.value.trim()) send(); if (e.key === "Escape") input.blur(); },
    focus: () => { inBox.classList.add("is-focus"); syncInput(); },
    blur: () => setTimeout(() => { inBox.classList.remove("is-focus"); syncInput(); }, 160),
  } });
  inBox = h("div.agent__in", null, input,
    h("button.agent__send", { "aria-label": t("agent.send"), on: { click: send } }, s("svg", { viewBox: "0 0 24 24" }, s("path", { d: "M5 12h14M13 6l6 6-6 6" }))));
  panel = h("section.agent", { "aria-label": t("agent.name") },
    h("div.agent__head", null, h("span.agent__name", { text: t("agent.name") }), h("span.agent__role", { text: t("agent.role") }), stateEl),
    h("div.agent__face", null, faceCanvas),
    h("div.agent__body", null, caption, srcBox, msgBox, sugBox),
    h("div.agent__foot", null, inBox));

  podOrb = h("span.orb", null, h("span.orb__ring"), h("span.orb__rim"), h("span.orb__core"));
  podState = h("span.pod__state"); podLine = h("span.pod__line"); podChev = h("span.pod__chev");
  pod = h("button.pod", { on: { click: () => setState({ jOpen: !state.jOpen }) } },
    h("span.pod__orb", null, podOrb), h("span.pod__txt", null, podState, podLine), podChev);

  app.append(panel, pod);
  jarvis = mountJarvis(faceCanvas, { scale: 0.27 });
  syncInput();
}

// The other footer variants (mirror, drawer, island) show the same agent
// status as the pod; they read it here and re-render on every change.
const podListeners = new Set();
let podText = "";
export function onPodChange(fn) { podListeners.add(fn); }
export function podInfo() {
  const ag = state.agent;
  return { state: `RECALL · ${t(`agent.state.${ag}`)}`, color: STATE_COLOR[ag], busy: ag !== "idle", text: podText };
}

function syncInput() {
  const active = document.activeElement === input || !!input.value;
  inBox.classList.toggle("is-active", active);
  input.placeholder = active ? t("agent.askLong") : t("agent.ask");
}

function greeting() {
  const area = getArea(state.view);
  if (area?.greetingKey) return t(area.greetingKey);
  return data.newSince ? t("agent.greetingNew", { n: data.newSince }) : t("agent.greeting");
}

export function ask(q) {
  q = (q || "").trim(); if (!q) return;
  clearInterval(typeTimer);
  if (chatState.shown) chatState.msgs.push({ role: "you", text: chatState.shown.q }, { role: "recall", text: chatState.shown.a });
  chatState.shown = null; chatState.typed = "";
  setState({ jOpen: true, focus: null, agent: "thinking", hits: [] });
  render();
  const history = chatState.history.slice(-6);
  chat(q, history).then(async ({ ok, status, body }) => {
    let answer, sources = [];
    if (ok && typeof body.reply === "string") {
      answer = body.reply;
      sources = Array.isArray(body.hits) ? body.hits.filter((x) => x && typeof x.title === "string").slice(0, 3).map((x) => [x.title, String(x.type || ""), typeof x.id === "string" ? x.id : ""]) : [];
    } else if (status === 503) {
      answer = t("agent.noModel");
      try { const r = await fetch(`/ui/search?q=${encodeURIComponent(q)}`); const b = await r.json(); sources = (Array.isArray(b.hits) ? b.hits : []).filter((x) => x && typeof x.title === "string").slice(0, 3).map((x) => [x.title, String(x.type || ""), typeof x.id === "string" ? x.id : ""]); } catch { /* none */ }
    } else answer = t("agent.error");
    chatState.history.push({ role: "user", content: q }, { role: "assistant", content: answer });
    typeOut({ q, a: answer, sources });
  }).catch(() => typeOut({ q, a: t("agent.error"), sources: [] }));
}

function typeOut(p) {
  // Hit ids of the answer, numbered 1–3 on the vault views (js/views/).
  setState({ agent: "speaking", hits: p.sources.map((x) => x[2]).filter(Boolean) });
  let i = 0;
  typeTimer = setInterval(() => {
    i += 4; chatState.typed = p.a.slice(0, i); render();
    if (i >= p.a.length) { clearInterval(typeTimer); chatState.shown = p; chatState.typed = ""; setState({ agent: "idle" }); render(); }
  }, 56);
}

function send() { const q = input.value.trim(); if (!q) return; input.value = ""; input.blur(); syncInput(); ask(q); }

export function render(L) {
  if (L) {
    panel.classList.toggle("is-open", L.jOpen);
    jarvis?.setActive?.(L.jOpen);
    pod.title = L.pinAgent ? t("agent.name") : L.jOpen ? t("pod.title.close") : t("pod.title.open");
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
  podState.textContent = `RECALL · ${t(`agent.state.${ag}`)}`;
  const total = numberFmt.format(data.health?.vault_size ?? 0);
  const cap = ag === "speaking" ? chatState.typed : ag === "thinking" ? t("agent.thinking", { n: total }) : chatState.shown ? chatState.shown.a : greeting();
  clear(caption).append(cap, ag === "speaking" || ag === "thinking" ? h("span.agent__caret") : "");
  podLine.textContent = ag === "speaking" ? chatState.typed : ag === "thinking" ? t("agent.thinking", { n: total }) : chatState.shown ? t("pod.answered", { n: chatState.shown.sources.length }) : data.newSince ? t("pod.newMemories", { n: data.newSince }) : t("pod.ready");
  podText = podLine.textContent;
  for (const fn of podListeners) fn();
  clear(srcBox);
  if (chatState.shown && ag === "idle" && chatState.shown.sources.length) {
    srcBox.append(h("span.agent__srcs-l", { text: t("agent.sources") }), ...chatState.shown.sources.map(([title, type], i) =>
      h("div.agent__src", null, h("span.agent__src-n", { text: String(i + 1) }), h("span.agent__src-t", { text: title }), h("span.agent__src-k", { text: type }))));
  }
  clear(msgBox).append(...chatState.msgs.slice(-4).map((m) => h(`div.msg.msg--${m.role}`, { text: m.text })));
  msgBox.className = chatState.msgs.length ? "agent__srcs" : "";
  const keys = getArea(state.view)?.presetKeys || VAULT_PRESETS;
  const used = new Set([chatState.shown?.q, ...chatState.msgs.map((m) => m.text)]);
  clear(sugBox).append(...keys.map((k) => t(k)).filter((q) => !used.has(q)).slice(0, state.vh < 760 ? 1 : 2)
    .map((q) => h("button.agent__sug", { on: { click: () => ask(q) } }, h("span", { text: "↳" }), q)));
}
