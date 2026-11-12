// One small store for the shell. Components subscribe and re-render the parts
// they own; nothing here touches the DOM.
const listeners = new Set();

const saved = (() => { try { return JSON.parse(localStorage.getItem("recall-v22-ui") || "{}"); } catch { return {}; } })();

export const state = {
  view: saved.view || "chronos",
  jOpen: saved.jOpen ?? false,
  lensOpen: saved.lensOpen ?? true,
  lensPeek: false,
  tab: "areas",
  vpOpen: false,
  vw: window.innerWidth,
  vh: window.innerHeight,
  agent: "idle",
  focus: null,
  hover: null,
  filter: "",
  time: "all",
  brush: null,
  live: true,
  toast: "",
};

export function setState(patch) {
  const next = typeof patch === "function" ? patch(state) : patch;
  let changed = false;
  for (const [k, v] of Object.entries(next)) if (state[k] !== v) { state[k] = v; changed = true; }
  if (!changed) return;
  try { localStorage.setItem("recall-v22-ui", JSON.stringify({ view: state.view, jOpen: state.jOpen, lensOpen: state.lensOpen })); } catch { /* storage blocked */ }
  for (const fn of listeners) fn(state);
}

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
