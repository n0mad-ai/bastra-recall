// Integration probe against a running local daemon and its real graph.
// Run: nice -n 15 node tools/probes/v22-memory-browser.mjs [1440x900] [quick]
// Uses the shared Chrome lock; never writes to the vault or calls an LLM.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const lock = "/private/tmp/claude-501/bastra-chrome-lock";
const [width, height] = (process.argv[2] || "1440x900").split("x").map(Number);
let profile, chrome, ws, locked = false, seq = 0;
const pending = new Map(), errors = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

async function browserProbe(quick = false) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const { data } = await import("/ui/v22/js/data.js");
  const { state, setState } = await import("/ui/v22/js/state.js");
  const { vault, inWindow, timeWindow } = await import("/ui/v22/js/views/vault-data.js");
  const { openMemoryBrowser } = await import("/ui/v22/js/views/memory-browser.js");
  const { memoryCard, areaCard } = await import("/ui/v22/js/views/chrome.js");
  for (let i = 0; i < 100 && !data.graph; i++) await sleep(100);
  const v = vault();
  if (!v?.total) throw new Error("No graph available");
  const recent = v.mems.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  const largest = v.areas.slice().sort((a, b) => b.count - a.count)[0].key;
  const older = recent.filter((m) => m.area === largest).at(-1);
  const targets = [...new Map([recent[0], recent[120], recent.at(-1), older,
    ...v.areas.slice(0, 6).map((a) => recent.findLast((m) => m.area === a.key))]
    .filter(Boolean).map((m) => [m.id, m])).values()];
  const results = [];
  async function check(label, m) {
    await sleep(1100); // grow plus smooth scroll
    const root = document.querySelector(".mb.is-on.is-grow");
    const row = root?.querySelector(`.mb-row[data-id="${CSS.escape(m.id)}"]`);
    const list = root?.querySelector(".mb__list"), reader = root?.querySelector(".mb__reader");
    const rr = row?.getBoundingClientRect(), lr = list?.getBoundingClientRect();
    const narrow = root?.classList.contains("is-narrow");
    const reading = root?.classList.contains("is-reading");
    const visible = narrow ? reading && reader.getBoundingClientRect().height > 0 : rr && rr.top >= lr.top && rr.bottom <= lr.bottom + 1;
    const title = reader?.querySelector(".mb-rd__h")?.textContent;
    const loaded = !reader?.querySelector(".mb-rd__text.is-wait");
    let backReveals = true;
    if (narrow && reading) {
      root.querySelector(".mb-rd__back").click(); await sleep(30);
      const r = row.getBoundingClientRect(), b = list.getBoundingClientRect();
      backReveals = r.top >= b.top && r.bottom <= b.bottom + 1;
      row.click();
    }
    const pass = !!(row?.classList.contains("is-sel") && visible && title === m.title && loaded && backReveals);
    results.push({ label, pass, rendered: root?.querySelectorAll(".mb-row").length, narrow, visible: !!visible, loaded });
    console.info("MB-PROBE", label, pass);
    if (!pass) throw new Error(JSON.stringify({ label, id: m.id, title, row: rr?.toJSON(), list: lr?.toJSON(), scroll: list?.scrollTop, max: list && list.scrollHeight - list.clientHeight, results }));
  }
  setState({ view: "ring", focus: largest, jOpen: quick, time: "week", brush: { a: 51, b: 52 } });
  await sleep(200);
  // Escape during grow belongs to the browser, even before covered=true.
  let leaked = false;
  const onEscape = (e) => { if (e.key === "Escape") leaked = true; };
  window.addEventListener("keydown", onEscape, true);
  openMemoryBrowser(largest, older.id); await sleep(40);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  window.removeEventListener("keydown", onEscape, true);
  await sleep(510);
  if (leaked || document.querySelector(".mb.is-on")) throw new Error("Browser grow Escape leaked to the vault view");
  results.push({ label: "escape-during-grow", pass: true });
  // Direct links reset stale search/type filters and must reach every page.
  for (const [i, m] of (quick ? [older, recent.at(-1)] : targets).entries()) {
    openMemoryBrowser(i % 2 ? largest : "all", m.id);
    await check(`direct-${i}`, m);
    const input = document.querySelector(".mb__input");
    input.value = "no-matching-memory-in-this-probe";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (quick) return { viewport: [innerWidth, innerHeight], memories: v.total, tests: results };
  // Every vault view uses the actual shared memory-card button handler.
  for (const view of ["ring", "chronos", "radiant", "spiral", "halflife", "weave", "mindspace", "clouds", "semantic"]) {
    document.querySelector(".mb__esc")?.click();
    await sleep(510);
    setState({ view, focus: largest });
    await sleep(100);
    const { el } = memoryCard(older, { onClose() {} });
    document.querySelector(".stage").append(el);
    el.querySelector(".vcard__open").click(); el.remove();
    await check(`card-${view}`, older);
  }
  // An already open browser survives remounts and reveals the selected row.
  for (const view of ["ring", "chronos", "mindspace"]) {
    setState({ view });
    await check(`remount-${view}`, older);
  }
  // Area-card entry is unselected; choosing a memory then following a link
  // beyond page one must render both the linked row and the reader.
  document.querySelector(".mb__esc").click(); await sleep(510);
  const area = areaCard(largest, { onMemory() {} });
  document.querySelector(".stage").append(area.el);
  area.el.querySelector(".vcard__open").click(); area.el.remove();
  await sleep(550);
  const linked = recent.find((m) => m.links.some((l) => {
    const target = v.byId.get(l.id);
    return target && recent.filter((r) => r.area === target.area).findIndex((r) => r.id === target.id) >= 120;
  }));
  if (linked) {
    openMemoryBrowser("all", linked.id); await sleep(650);
    const target = v.byId.get(linked.links.find((l) => {
      const m = v.byId.get(l.id);
      return m && recent.filter((r) => r.area === m.area).findIndex((r) => r.id === m.id) >= 120;
    }).id);
    const buttons = [...document.querySelectorAll(".mb-rd__link")];
    const btn = buttons.find((b) => b.querySelector(".mb-rd__lt")?.textContent === target.title);
    if (!btn) throw new Error("Linked-memory button missing");
    btn.click(); await check("linked-beyond-first-page", target);
  }
  // Exercise the real agent-source button with a mocked chat response,
  // without persisting a conversation or calling an LLM.
  const originalFetch = window.fetch;
  const { ask } = await import("/ui/v22/js/agent.js");
  try {
    window.fetch = (url, init) => String(url).includes("/ui/chat")
      ? Promise.resolve(new Response(JSON.stringify({ reply: `[[${older.id}|go]]`, hits: [{ id: older.id, title: older.title, type: older.type }] }), { headers: { "Content-Type": "application/json" } }))
      : originalFetch(url, init);
    document.querySelector(".mb__esc").click(); await sleep(510);
    setState({ view: "dashboard", brush: { a: 51, b: 52 } }); await sleep(150);
    ask("Browser integration probe");
    for (let i = 0; i < 50 && !document.querySelector(".agent__srcs button"); i++) await sleep(100);
    const source = document.querySelector(".agent__srcs button");
    if (!source) throw new Error("Agent source button missing");
    source.click(); await check("agent-source-outside-vault", older);
    document.querySelector(".mb__esc").click(); await sleep(510);
    setState({ view: "dashboard" }); await sleep(100);
    const wikilink = document.querySelector(".agent__md .mb-wl");
    if (!wikilink) throw new Error("Agent wikilink missing");
    wikilink.click(); await check("agent-wikilink-outside-vault", older);
  } finally { window.fetch = originalFetch; }
  return { viewport: [innerWidth, innerHeight], memories: v.total, area: largest, areaCount: v.areas.find((a) => a.key === largest).count,
    oldMemoryOutsideTimeWindow: !inWindow(older, timeWindow()), tests: results };
}

try {
  for (let i = 0; !locked; i++) {
    try { mkdirSync(lock); locked = true; } catch (e) { if (e.code !== "EEXIST" || i >= 40) throw e; await sleep(1500); }
  }
  profile = mkdtempSync(join(tmpdir(), "v22-mb-probe-"));
  chrome = spawn(process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Chrome startup timeout")), 10000);
    chrome.stderr.on("data", (buf) => { const m = String(buf).match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(timeout); resolve(m[1]); } });
    chrome.on("error", reject);
  });
  const port = new URL(endpoint).port;
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve));
  ws.addEventListener("message", ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); }
    else if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.args[0]?.value === "MB-PROBE") console.log(msg.params.args.map((a) => a.value).join(" "));
  });
  await send("Runtime.enable"); await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: "http://127.0.0.1:6723/ui/v22/index.html" }); await sleep(2500);
  const result = await send("Runtime.evaluate", { expression: `(${browserProbe.toString()})(${process.argv[3] === "quick"})`, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  console.log(JSON.stringify({ ...result.result.value, uncaught: errors }, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (e) { console.error(e); process.exitCode = 1; }
finally {
  ws?.close();
  if (chrome) { chrome.kill(); await new Promise((resolve) => chrome.once("exit", resolve)); }
  if (profile) rmSync(profile, { recursive: true, force: true });
  if (locked) rmdirSync(lock);
}
