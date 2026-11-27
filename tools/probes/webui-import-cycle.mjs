// Run against a throwaway fixture daemon on a dedicated loopback port.
// node tools/probes/webui-import-cycle.mjs http://127.0.0.1:<port>/ui/ [screenshot.png]
// Uses a local Chrome and Playwright installation. BASTRA_WEBUI_PROBE_PLAYWRIGHT
// can name the Playwright module when it is installed outside the workspace.

// #1516: run the actual module graph and shell. Only chat transport is mocked.
async function cycleProbe() {
  const { data } = await import("/ui/js/data.js");
  const { state, setState } = await import("/ui/js/state.js");
  const { t } = await import("/ui/js/i18n.js");
  const { vault } = await import("/ui/js/views/vault-data.js");
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(read, label) {
    for (let i = 0; i < 160; i++) {
      const value = read();
      if (value) return value;
      await pause(50);
    }
    throw new Error(label);
  }
  const find = (selector) => document.querySelector(selector);
  const text = (selector) => find(selector)?.textContent;
  const click = async (selector) => (await until(() => find(selector), selector)).click();
  const expect = (actual, expected, label) => {
    if (actual !== expected) throw new Error(`${label}: expected ${expected}; got ${actual}`);
  };
  const focus = (key) => setState({ view: "ring", focus: key, jOpen: true, time: "all", brush: null });
  const caption = ".agent__caption";
  const heading = ".mb.is-on .mb-rd__h";
  const intro = "The real agent panel types this answer before revealing its numbered source.";
  await until(() => data.graph && vault()?.total, "vault graph not loaded");
  console.info("MB-PROBE", "module graph and fixture loaded");
  const v = vault();
  const area = v.areas[0].key;
  const linked = v.mems[0];
  const requests = [];
  const originalFetch = window.fetch;
  window.fetch = (url, options) => {
    if (!String(url).includes("/ui/chat")) return originalFetch(url, options);
    requests.push(JSON.parse(options.body).message);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          reply: `${intro} **Visible emphasis.** [[${linked.id}|Open linked memory]]`,
          hits: [{ id: linked.id, title: linked.title, type: linked.type }],
        }),
        { headers: { "Content-Type": "application/json" } }
      )
    );
  };
  try {
    focus(area);
    await until(() => text(".vcard__name") === area, "area card did not mount");
    console.info("MB-PROBE", "area card mounted");
    const areaCard = { title: text(".vcard__name"), actions: text(".vcard__acts") };
    await click(".vcard__ask");
    await until(() => state.agent === "speaking" && find(`${caption} .agent__caret`), "agent did not type");
    expect(!!find(".agent__src"), false, "source visible before answer finished");
    await until(() => state.agent === "idle" && find(".agent__src"), "typed answer or sources missing");
    expect(text(`${caption} strong`), "Visible emphasis.", "answer formatting");
    expect(text(".agent__src-t"), linked.title, "source title");
    expect(requests[0], t("vv.askArea", { a: area }), "area-card question");
    console.info("MB-PROBE", "area card and agent typing passed");

    focus(area);
    const memoryTitle = await until(() => text(".vcard__mt"), "area card has no memory row");
    await click(".vcard__mem");
    await until(() => text(".vcard__title") === memoryTitle, "memory card did not open");
    const memoryCard = { title: text(".vcard__title"), actions: text(".vcard__acts") };
    await click(".vcard__ask");
    await until(() => requests.length === 2 && state.agent === "idle", "memory-card answer missing");
    expect(requests[1], t("vv.askMemory", { m: memoryTitle }), "memory-card question");
    console.info("MB-PROBE", "memory card question passed");

    focus(area);
    await click(".vcard__mem");
    await until(() => text(".vcard__title") === memoryTitle, "memory card did not reopen");
    await click(".vcard__open");
    await until(() => text(heading) === memoryTitle, "card opened the wrong browser memory");
    await click(".mb.is-on .mb-rd__acts button.is-primary");
    await until(() => requests.length === 3 && state.agent === "idle", "reader answer missing");
    expect(requests[2], t("mb.askQ", { m: memoryTitle }), "reader question");
    console.info("MB-PROBE", "reader question passed");

    await click(".mb__esc");
    setState({ view: "dashboard" });
    await until(() => state.view === "dashboard" && !find(".mb.is-on"), "browser did not close before dashboard");
    await click(`${caption} .mb-wl`);
    await until(() => text(heading) === linked.title, "answer wikilink opened the wrong browser memory");
    await until(() => !find(".mb-rd__text.is-wait"), "reader text did not load");
    return {
      areaCard,
      memoryCard,
      answer: text(caption),
      source: text(".agent__src-t"),
      reader: text(heading),
      selected: find(".mb-row.is-sel")?.dataset.id,
      questions: requests,
    };
  } finally {
    window.fetch = originalFetch;
  }
}

const url = new URL(process.argv[2]);
if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.port === "6723")
  throw new Error("Supply an isolated fixture-daemon URL on 127.0.0.1 with its own port");
const { chromium } = await import(process.env.BASTRA_WEBUI_PROBE_PLAYWRIGHT || "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-background-networking"] });
try {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "de-DE" });
  await context.route("**/*", (route) => {
    const target = new URL(route.request().url());
    return target.origin === url.origin || target.protocol === "data:" ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.text().startsWith("MB-PROBE ")) console.error(message.text());
  });
  await page.goto(url.href, { timeout: 10000, waitUntil: "domcontentloaded" });
  let watchdog;
  try {
    const snapshot = await Promise.race([
      page.evaluate(cycleProbe),
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("Chrome did not complete the module probe")), 30000);
      }),
    ]);
    if (errors.length) throw new Error(errors.join("\n"));
    if (process.argv[3]) {
      await page.waitForTimeout(700); // let the browser grow finish before capture
      await page.screenshot({ path: process.argv[3], timeout: 6000 });
    }
    console.log(JSON.stringify(snapshot, null, 2));
  } finally {
    clearTimeout(watchdog);
  }
} finally {
  await browser.close();
}
