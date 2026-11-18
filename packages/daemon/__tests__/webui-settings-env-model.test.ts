import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

async function model(fetch?: Function, globals: Record<string, unknown> = {}) {
  const source = await readFile(new URL("../webui/app/js/sections/settings-model.js", import.meta.url), "utf8");
  return runInNewContext(
    source
      .replace(/^import .*;$/gm, "")
      .replace(/^export /gm, "")
      .replace(/^\{ state \};$/gm, "") +
      "\n({GROUPS, store, groupKeys, entry, shown, setValue, revert, discard, setInvalid, onStore, changeList, cliOf, matches, metaOf, apply, restart, assistantName, locked})",
    {
      state: {},
      setState() {},
      setBackdrop() {},
      t: (key: string) => key,
      fetch,
      ...globals,
    }
  );
}

test("web UI env settings use runtime bounds, searchable env names and the existing change/revert store", async () => {
  const m = await model();
  const retention = {
    key: "logs.retention",
    envName: "BASTRA_LOG_RETENTION_DAYS",
    storage: "daemon.env",
    kind: "number",
    min: 30,
    max: 365,
    step: 1,
    value: 90,
    effective: 90,
    envOverride: [],
    restartRequired: true,
  };
  const external = {
    key: "embedding.model",
    value: "embeddinggemma",
    effective: "external-model",
    envOverride: [{ name: "BASTRA_EMBEDDING_MODEL", value: "external-model" }],
    readonly: true,
  };
  m.store.model = { entries: [retention, external] };
  assert.equal(m.metaOf(retention).min, 30);
  assert.equal(m.metaOf(retention).max, 365);
  assert.equal(m.metaOf(retention).unit, "days");
  assert.equal(m.matches(retention, "Retention", "", "bastra_log_retention_days"), true);
  assert.equal(m.groupKeys(m.GROUPS.find((g: any) => g.id === "logs")).join(), "logs.retention");
  m.setValue("logs.retention", 100);
  assert.equal(m.shown(retention), 100);
  assert.equal(m.changeList()[0].value, 100);
  assert.equal(m.changeList()[0].e.restartRequired, true);
  m.setValue("embedding.model", "forbidden");
  assert.equal(m.store.changes.has("embedding.model"), false);
  assert.equal(m.shown(external), "external-model");
  m.revert("logs.retention");
  assert.equal(m.shown(retention), 90);
  assert.equal(m.changeList().length, 0);
});

test("web UI saves autostart separately and retains only the failed change after partial success", async () => {
  const writes: Record<string, unknown>[] = [];
  const entries = [
    { key: "logs.retention", value: 90, restartRequired: true },
    { key: "autostart", value: true, default: false },
  ];
  const m = await model(async (path: string, options: any) => {
    if (path.endsWith("/session")) return { ok: true, json: async () => ({ csrf: "fixture" }) };
    const { changes } = JSON.parse(options.body);
    writes.push(changes);
    if ("autostart" in changes) return { ok: false, status: 409, json: async () => ({ error: "service unavailable" }) };
    return { ok: true, json: async () => ({ entries: [{ ...entries[0], value: 100 }, entries[1]] }) };
  });
  m.store.model = { entries };
  m.setValue("logs.retention", 100);
  m.setValue("autostart", false);
  await m.apply();
  assert.deepEqual(writes, [{ "logs.retention": 100 }, { autostart: false }]);
  assert.equal(m.entry("logs.retention").value, 100);
  assert.equal(m.store.changes.size, 1);
  assert.equal(m.store.changes.get("autostart"), false);
  assert.equal(m.store.savedRestart, true);
  assert.equal(m.store.error, "service unavailable");
  assert.equal(m.store.busy, false);
});

test("web UI CLI previews route env keys to config set, preserve shell arguments and use autostart commands", async () => {
  const m = await model();
  assert.equal(m.cliOf({ key: "recall.floor", storage: "daemon.env" }, 35), "bastra config set recall.floor 35");
  assert.equal(m.cliOf({ key: "autostart", default: false }, true), "bastra autostart on");
  assert.equal(m.cliOf({ key: "autostart", default: false }, false), "bastra autostart off");
  assert.equal(m.cliOf({ key: "autostart", default: false }, null), "bastra autostart off");
  assert.equal(
    m.cliOf({ key: "logs.path" }, "$(touch /tmp/unwanted)"),
    "bastra config set logs.path '$(touch /tmp/unwanted)'"
  );
  assert.equal(m.cliOf({ key: "logs.path" }, "a'b"), "bastra config set logs.path 'a'\\''b'");
  assert.equal(m.cliOf({ key: "api.token", secret: true }, "private-value"), "bastra config set api.token '…'");
});

test("web UI keeps a newer edit made while an earlier value is being saved", async () => {
  const m = await model(async (path: string) => {
    if (path.endsWith("/session")) return { ok: true, json: async () => ({ csrf: "fixture" }) };
    m.setValue("logs.retention", 110);
    return {
      ok: true,
      json: async () => ({ entries: [{ key: "logs.retention", value: 100, restartRequired: true }] }),
    };
  });
  m.store.model = { entries: [{ key: "logs.retention", value: 90, restartRequired: true }] };
  m.setValue("logs.retention", 100);
  await m.apply();
  assert.equal(m.entry("logs.retention").value, 100);
  assert.equal(m.store.changes.get("logs.retention"), 110);
  assert.equal(m.shown(m.entry("logs.retention")), 110);
});

test("web UI assistant name is the saved name only while the user has set one", async () => {
  const m = await model();
  assert.equal(m.assistantName(), null);
  m.store.model = { entries: [{ key: "assistant.name", value: null, isSet: false }] };
  assert.equal(m.assistantName(), null);
  m.store.model = { entries: [{ key: "assistant.name", value: "jarvis", isSet: true }] };
  assert.equal(m.assistantName(), "jarvis");
  m.store.model = { entries: [{ key: "assistant.name", value: "  ", isSet: true }] };
  assert.equal(m.assistantName(), null);
});

test("web UI agent group: the name comes first, is editable and saves through the address endpoint", async () => {
  const calls: Array<{ path: string; body: any }> = [];
  let saved = "jarvis";
  const m = await model(async (path: string, options: any = {}) => {
    calls.push({ path, body: options.body ? JSON.parse(options.body) : undefined });
    if (path.endsWith("/session")) return { ok: true, json: async () => ({ csrf: "fixture" }) };
    if (path === "/ui/assistant-address") {
      if (options.body && JSON.parse(options.body).name === "a\u0007b")
        return { ok: false, status: 400, json: async () => ({ error: "Assistentenname: …", code: "invalid_name" }) };
      if (options.body) saved = JSON.parse(options.body).name;
      return { ok: true, json: async () => ({ name: saved.toLowerCase(), displayName: saved, ready: true }) };
    }
    return {
      ok: true,
      json: async () => ({ entries: [{ key: "assistant.name", value: saved, isSet: true, managed: true }] }),
    };
  });
  const group = m.GROUPS.find((g: any) => g.id === "personality");
  assert.deepEqual([...group.keys], ["assistant.name", "soul.direction", "soul.text"]);
  assert.ok(!m.GROUPS.find((g: any) => g.id === "general").keys.includes("assistant.name"));
  m.store.model = { entries: [{ key: "assistant.name", value: "jarvis", isSet: true, managed: true }] };
  assert.ok(!m.locked(m.entry("assistant.name")), "the name is no longer locked");
  m.setValue("assistant.name", "Jarvis");
  await m.apply();
  const write = calls.find((c) => c.path === "/ui/assistant-address" && c.body);
  assert.deepEqual(write?.body, { name: "Jarvis", systemConsent: true }, "the save is the instruction");
  assert.ok(!calls.some((c) => c.path === "/ui/settings" && c.body?.changes), "not through the settings route");
  assert.equal(m.assistantName(), "Jarvis", "shown as typed");
  assert.equal(m.store.address.displayName, "Jarvis");
  assert.equal(m.store.error, "");
  m.setValue("assistant.name", "a\u0007b");
  await m.apply();
  assert.equal(m.store.error, "st.addr.invalid", "a short, translated message");
  assert.equal(m.store.changes.get("assistant.name"), "a\u0007b", "the rejected input stays for correction");
  assert.equal(m.assistantName(), "Jarvis");
});

test("web UI address note: honest state of http://<name>/ for the saved name", async () => {
  const source = await readFile(new URL("../webui/app/js/sections/settings-assistant.js", import.meta.url), "utf8");
  const { addressNote } = runInNewContext(
    source.replace(/^import .*;$/gm, "").replace(/^export /gm, "") + "\n({ addressNote })",
    { t: (key: string, v?: any) => (v ? `${key} ${JSON.stringify(v)}` : key), store: {}, h() {} }
  );
  const ok = {
    name: "jarvis",
    registeredName: "jarvis",
    targetName: "jarvis",
    ready: true,
    systemSetupSupported: true,
  };
  assert.match(addressNote("Jarvis", ok).text, /st\.addr\.ready .*http:\/\/jarvis\/"/);
  assert.equal(addressNote("Jarvis", ok).retry, false);
  const failed = { ...ok, targetName: "ruby", warning: "Systemeinrichtung abgebrochen, nichts geändert." };
  const pending = addressNote("Ruby", failed);
  assert.match(pending.text, /st\.addr\.todo .*http:\/\/ruby\/.* Systemeinrichtung abgebrochen/);
  assert.equal(pending.retry, true);
  assert.match(
    addressNote("ruby", { name: "ruby", targetName: "ruby", systemSetupSupported: false }).text,
    /ruby\.localhost/
  );
  assert.equal(addressNote(null, ok), null);
  // Special characters: the readable form first, the technical one only in addition; the daemon supplies both.
  const idn = {
    ...ok,
    name: "xn--jrgen-kva",
    registeredName: "xn--jrgen-kva",
    readableName: "jürgen",
    targetName: "xn--jrgen-kva",
    targetReadableName: "jürgen",
  };
  assert.equal(addressNote("Jürgen", idn).text, 'st.addr.ready {"url":"http://jürgen/ (http://xn--jrgen-kva/)"}');
  // No address derivable: say so, and which address still applies (or that there is none).
  const none = addressNote("🤖", { ...idn, targetName: null, targetReadableName: null });
  assert.equal(none.text, 'st.addr.none {"url":"http://jürgen/ (http://xn--jrgen-kva/)"}');
  assert.equal(none.retry, false);
  assert.equal(addressNote("🤖", { name: null, targetName: null, systemSetupSupported: true }).text, "st.addr.noneYet");
});

test("web UI invalid daemon.env JSON blocks Apply and restart and never saves the older valid draft", async () => {
  const writes: Record<string, unknown>[] = [];
  const m = await model(async (path: string, options: any = {}) => {
    if (path.endsWith("/session")) return { ok: true, json: async () => ({ csrf: "fixture" }) };
    if (options.body) writes.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ entries: [env], restartAvailable: true }) };
  });
  const env = { key: "daemon.env", kind: "json", secret: true, isSet: true, envOverride: [], restartRequired: true };
  m.store.model = { entries: [env], restartAvailable: true };
  const events: string[] = [];
  m.onStore((what: string) => events.push(what));
  // An earlier valid draft, then the visible text becomes invalid (what the secret field does on input).
  m.store.changes.set("daemon.env", { A: "earlier" });
  m.setInvalid("daemon.env", '{"A": "visible"');
  await m.apply();
  assert.deepEqual(writes, [], "nothing is saved while the visible text is invalid");
  assert.equal(m.store.error, "st.json.invalid");
  assert.equal(events.at(-1), "invalid", "the view is told to focus the invalid field");
  assert.equal(m.store.busy, false);
  await m.restart();
  assert.deepEqual(writes, [], "restart stays blocked as well");
  assert.equal(m.store.restarting, false);
  // Correcting the text clears the block; the visible value is what gets saved.
  m.setInvalid("daemon.env", null);
  m.store.changes.set("daemon.env", { A: "visible" });
  await m.apply();
  assert.deepEqual(writes, [{ changes: { "daemon.env": { A: "visible" } } }]);
  assert.equal(m.store.error, "");
  // Revert and discard both drop an invalid draft.
  m.setInvalid("daemon.env", "{");
  m.revert("daemon.env");
  assert.equal(m.store.invalid.size, 0);
  m.setInvalid("daemon.env", "{");
  m.discard();
  assert.equal(m.store.invalid.size, 0);
});

test("web UI settings: unsaved changes block the daemon restart until they are applied or discarded", async () => {
  const calls: string[] = [];
  const entries = [{ key: "logs.retention", value: 90, restartRequired: true, envOverride: [] }];
  const m = await model(
    async (path: string) => {
      calls.push(path);
      if (path.endsWith("/session")) return { ok: true, json: async () => ({ csrf: "fixture" }) };
      return { ok: true, json: async () => ({ entries, restartAvailable: true }) };
    },
    // The restart waits for the daemon to come back; no real wait in the test.
    { setTimeout: (fn: () => void) => fn() }
  );
  m.store.model = { entries, restartAvailable: true };
  m.setValue("logs.retention", 100);
  await m.restart();
  assert.equal(calls.length, 0, "a restart with unsaved changes would drop them, so nothing is sent");
  assert.equal(m.store.restarting, false);
  m.discard();
  await m.restart();
  assert.ok(calls.includes("/ui/settings/restart"), "without pending changes the restart goes through");
  assert.equal(m.store.restarting, false);
});
