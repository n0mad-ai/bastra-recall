/** #1653: the address status probes only an explicitly given port; the product callers name port 80. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { assistantAddressStatus, type AssistantAddressOptions } from "../src/assistant-address.js";
import { setAssistantName } from "../src/assistant-address-settings.js";
import { cmdAddress } from "../src/cli/address-cmd.js";
import { parseArgs } from "../src/cli/commands.js";
import { printAssistantAddressNote } from "../src/cli/doctor-address-note.js";
import { handleAssistantAddressUi } from "../src/http-assistant-address.js";

const WELL_KNOWN = "/.well-known/bastra-assistant-address";

/** Isolated paths, an enabled UI, the name "jarvis" and this user's loaded helper — but no gatewayPort. */
async function fixture(t: test.TestContext): Promise<AssistantAddressOptions> {
  const root = await mkdtemp(join(tmpdir(), "address-probe-port-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const o = {
    language: "en",
    settingsPath: join(root, "settings"),
    hostsPath: join(root, "hosts"),
    helperPath: join(root, "helper.plist"),
    runtimeDir: join(root, "runtime"),
    firefoxRoot: join(root, "firefox"),
    home: root,
    uid: "501",
    username: "fixture",
    platform: "darwin" as const,
    daemonUrl: "http://127.0.0.1:9",
    helperLoaded: async () => true,
    runAdmin: async () => {},
  };
  await writeFile(o.settingsPath, JSON.stringify({ ui: { enabled: true } }));
  await writeFile(o.hostsPath, "127.0.0.1 localhost\n");
  await writeFile(o.helperPath, "<key>BASTRA_ASSISTANT_ADDRESS_OWNER</key><string>501</string>");
  await setAssistantName("jarvis", o.settingsPath);
  return o;
}

/** Records every fetch; answers like the assistant address listener of "jarvis". */
function recordFetch(t: test.TestContext): string[] {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    urls.push(String(url));
    return Response.json({ service: "bastra-assistant-address", name: "jarvis" });
  });
  return urls;
}

function quiet(t: test.TestContext): () => string {
  const out: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string) => (out.push(String(chunk)), true));
  return () => out.join("");
}

test("#1653: a status without gatewayPort contacts no port and says the listener was not checked", async (t) => {
  const o = await fixture(t),
    urls = recordFetch(t);
  const s = await assistantAddressStatus(o);
  assert.deepEqual(urls, [], "no network access without an explicit port");
  assert.equal(s.listenerChecked, false);
  assert.equal(s.ready, false);
  assert.equal(s.error, undefined, "an unchecked listener is not reported as an unreachable helper");
  assert.equal(s.name, "jarvis");
});

test("#1653: an unchecked listener still reports a helper known to be unloaded", async (t) => {
  const o = await fixture(t),
    urls = recordFetch(t);
  const s = await assistantAddressStatus({ ...o, helperLoaded: async () => false });
  assert.deepEqual(urls, []);
  assert.match(s.error ?? "", /not loaded/i);
});

test("#1653: an explicit gatewayPort is probed with Host, service and name checks", async (t) => {
  const o = await fixture(t),
    urls = recordFetch(t);
  const s = await assistantAddressStatus({ ...o, gatewayPort: 4567 });
  assert.deepEqual(urls, [`http://127.0.0.1:4567${WELL_KNOWN}`]);
  assert.equal(s.listenerChecked, true);
  assert.equal(s.ready, true);
});

test("#1653: `bastra address status` keeps probing the address port 80", async (t) => {
  const o = await fixture(t),
    urls = recordFetch(t),
    out = quiet(t);
  assert.equal(await cmdAddress(parseArgs(["address", "status", "--json"]), o), 0);
  assert.deepEqual(urls, [`http://127.0.0.1:80${WELL_KNOWN}`]);
  const s = JSON.parse(out());
  assert.equal(s.ready, true);
  assert.equal(s.listenerChecked, true);
});

test("#1653: `bastra doctor` asks the status for the address port 80", async (t) => {
  const seen: AssistantAddressOptions[] = [];
  quiet(t);
  await printAssistantAddressNote((async (options: AssistantAddressOptions = {}) => {
    seen.push(options);
    return { name: null, pending: false };
  }) as never);
  assert.deepEqual(seen, [{ gatewayPort: 80 }]);
});

async function uiStatus(o: AssistantAddressOptions, listener: { port?: number }) {
  let status = 0,
    body = "";
  const res = {
    headersSent: false,
    setHeader: () => {},
    writeHead: (code: number) => (status = code),
    end: (payload: string) => (body = payload),
  } as unknown as ServerResponse;
  await handleAssistantAddressUi({} as IncomingMessage, res, "GET", "/ui/assistant-address", o, async () => listener);
  return { status, body: JSON.parse(body) };
}

test("#1653: the UI status probes the running listener's port, else the address port 80", async (t) => {
  const o = await fixture(t),
    urls = recordFetch(t);
  const own = await uiStatus(o, { port: 4321 });
  assert.equal(own.status, 200);
  assert.equal(own.body.listenerChecked, true);
  const helper = await uiStatus(o, {});
  assert.equal(helper.status, 200);
  assert.deepEqual(urls, [`http://127.0.0.1:4321${WELL_KNOWN}`, `http://127.0.0.1:80${WELL_KNOWN}`]);
});
