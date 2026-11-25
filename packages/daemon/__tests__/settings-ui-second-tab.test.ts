// #1699: a second Settings tab replaces the shared session cookie. The first tab's
// next Apply renews its session once and saves, with the production handler, two
// client-module instances and one shared cookie jar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { dispatchSettingsUi } from "../src/settings-ui.js";
import { mutateSettings, readSettings } from "../src/settings-file.js";

type Init = {
  method?: string;
  credentials?: RequestInit["credentials"];
  headers?: Record<string, string>;
  body?: string;
};
type Tab = {
  store: { error: string; changes: Map<string, unknown> };
  load: () => Promise<void>;
  apply: () => Promise<void>;
  settingsApi: (path: string, body?: unknown) => Promise<unknown>;
};

const read = (path: string) => readFile(new URL(`../webui/app/js/${path}`, import.meta.url), "utf8");
const strip = (src: string) => src.replace(/^import .*;$/gm, "").replace(/^export /gm, "");

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const path = join(await mkdtemp(join(tmpdir(), "settings-tabs-")), "cli-settings.json");
  await mutateSettings(path, (s) => ({ ...s, ui: { enabled: true } }));
  const server = createServer((req, res) => {
    if (!dispatchSettingsUi(req, res, req.method!, req.url!, { path })) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // One browser: both tabs share this cookie jar; POSTs carry the page origin.
  let jar = "";
  const log: string[] = [];
  // `saveOrigin` replaces the Origin of every POST except the session request.
  const browserFetch = async (url: string, init: Init = {}, saveOrigin = origin) => {
    const pageOrigin = url === "/ui/settings/session" ? origin : saveOrigin;
    const headers = {
      ...init.headers,
      ...(jar ? { Cookie: jar } : {}),
      ...(init.method ? { Origin: pageOrigin } : {}),
    };
    const res = await fetch(origin + url, { ...init, headers });
    const set = res.headers.get("set-cookie");
    if (set) jar = set.split(";")[0];
    log.push(`${init.method ?? "GET"} ${url} ${res.status}`);
    return res;
  };
  const src = strip((await read("session-client.js")) + "\n" + (await read("sections/settings-model.js")));
  const tab = (saveOrigin = origin): Tab =>
    runInNewContext(src + "\n({ store, load, apply, settingsApi })", {
      state: {},
      setState: () => {},
      t: (key: string) => key,
      setBackdrop: () => {},
      fetch: (url: string, init?: Init) => browserFetch(url, init, saveOrigin),
      JSON,
      Object,
      Error,
      TypeError,
      Array,
      Set,
      Map,
      Promise,
      Date,
    }) as Tab;
  return { path, tab, log };
}

test("settings: Apply in the first tab saves after a second tab opened its session (#1699)", async (t) => {
  const { path, tab } = await setup(t);
  const a = tab();
  await a.load();
  assert.equal(a.store.error, "");
  a.store.changes.set("docs.language", "de");
  const b = tab();
  await b.load();
  assert.equal(b.store.error, "");
  await a.apply();
  assert.equal(a.store.error, "");
  assert.equal(a.store.changes.size, 0);
  assert.equal((await readSettings(path)).docs?.language, "de");
  // The second tab recovers the same way after the first one renewed.
  b.store.changes.set("docs.language", "en");
  await b.apply();
  assert.equal(b.store.error, "");
  assert.equal((await readSettings(path)).docs?.language, "en");
});

test("settings: an origin 403 on Apply is neither renewed nor repeated and keeps the draft", async (t) => {
  const { path, tab, log } = await setup(t);
  const a = tab("https://evil.example");
  await a.load();
  assert.equal(a.store.error, "");
  a.store.changes.set("docs.language", "de");
  log.length = 0;
  await a.apply();
  assert.equal(a.store.error, "Zugriff nicht erlaubt");
  assert.equal(a.store.changes.get("docs.language"), "de");
  // load() also asks the separate assistant-address route; only settings requests count here.
  assert.deepEqual(
    log.filter((line) => line.includes(" /ui/settings")),
    ["POST /ui/settings 403"]
  );
  assert.equal((await readSettings(path)).docs?.language, undefined);
});
