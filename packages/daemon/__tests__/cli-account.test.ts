/**
 * #1198 (S4) — `bastra account …` and `bastra ui remote …` on an isolated app
 * database: the password never leaves the prompt, no terminal means a message
 * instead of a hang, setup never overwrites, `ui remote off` revokes the
 * public sessions.
 *
 * Runner: `node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/cli-account.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAppDatabase } from "../src/app-database.js";
import { UiAccountStore } from "../src/ui-account-store.js";
import { UiSessionStore } from "../src/ui-session.js";
import { UiLoginThrottle } from "../src/ui-login-throttle.js";
import { cmdAccount, cmdUiRemote, type AccountIO } from "../src/cli/account-cmd.js";
import { ACCOUNT_WORDS, accountWordsIn } from "../src/cli/account-words.js";
import { parseArgs } from "../src/cli/commands.js";

const PASSWORD = "correct horse battery staple 42";
const OTHER = "another long passphrase 1234";

function fixture(opts: { tty?: boolean; username?: string | null; secrets?: string[]; language?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bastra-cli-account-"));
  const db = openAppDatabase({ path: join(dir, "recall.db") });
  const stores = {
    db,
    accounts: new UiAccountStore(db),
    sessions: new UiSessionStore(db),
    throttle: new UiLoginThrottle(db),
  };
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const secrets = [...(opts.secrets ?? [])];
  let origin = "";
  const io: AccountIO = {
    stores: () => stores,
    interactive: () => opts.tty ?? true,
    askLine: async (q) => (prompts.push(q), opts.username === undefined ? "daniel" : opts.username),
    askSecret: async (label) => {
      prompts.push(label);
      const next = secrets.shift();
      if (next === undefined) throw new Error("cancelled");
      return next;
    },
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    words: async () => accountWordsIn(opts.language),
    publicOrigin: {
      get: async () => origin,
      set: async (v) => void (origin = v ?? ""),
    },
  };
  const all = () => [...out, ...err, ...prompts].join("");
  return {
    io,
    stores,
    out: () => out.join(""),
    err: () => err.join(""),
    all,
    origin: () => origin,
    done: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const account = (f: ReturnType<typeof fixture>, sub: string | null, ...rest: string[]) =>
  cmdAccount({ sub, positional: ["account", sub ?? "", ...rest] }, f.io);
const remote = (f: ReturnType<typeof fixture>, ...rest: string[]) =>
  cmdUiRemote({ positional: ["ui", "remote", ...rest] }, f.io);

test("setup creates the account; the password is never printed", async () => {
  const f = fixture({ secrets: [PASSWORD, PASSWORD] });
  try {
    assert.equal(await account(f, "setup"), 0);
    assert.equal(f.stores.accounts.status().state, "present");
    assert.match(f.out(), /daniel/);
    assert.ok(!f.all().includes(PASSWORD));
    assert.equal((await f.stores.accounts.verifyLogin("daniel", PASSWORD)).ok, true);
  } finally {
    f.done();
  }
});

test("setup never overwrites an existing account, damaged or not", async () => {
  const f = fixture({ secrets: [OTHER, OTHER] });
  try {
    await f.stores.accounts.create("daniel", PASSWORD);
    assert.equal(await account(f, "setup"), 1);
    assert.match(f.err(), /never overwrites/);
    assert.equal((await f.stores.accounts.verifyLogin("daniel", PASSWORD)).ok, true);
    assert.equal((await f.stores.accounts.verifyLogin("daniel", OTHER)).ok, false);
    f.stores.db.sqlite.prepare("UPDATE ui_account SET password_hash='x'").run();
    assert.equal(await account(f, "setup"), 1);
    assert.match(f.err(), /damaged/);
  } finally {
    f.done();
  }
});

test("without a terminal the interactive commands stop with a message", async () => {
  const f = fixture({ tty: false, secrets: [PASSWORD, PASSWORD] });
  try {
    assert.equal(await account(f, "setup"), 1);
    assert.match(f.err(), /interactive terminal/);
    assert.equal(f.stores.accounts.status().state, "none");
    await f.stores.accounts.create("daniel", PASSWORD);
    f.err();
    assert.equal(await account(f, "reset-password"), 1);
    assert.match(f.err(), /interactive terminal/);
    assert.equal((await f.stores.accounts.verifyLogin("daniel", PASSWORD)).ok, true);
  } finally {
    f.done();
  }
});

test("input problems have their own messages and change nothing", async () => {
  for (const [username, secrets, pattern] of [
    ["", [], /user name is empty/],
    ["x".repeat(65), [], /too long/],
    [" daniel", [], /white space/],
    ["daniel", ["short"], /too short/],
    ["daniel", ["x".repeat(1025)], /too long \(at most 1024 bytes\)/],
    ["daniel", [PASSWORD, OTHER], /differ/],
  ] as const) {
    const f = fixture({ username, secrets: [...secrets] });
    try {
      assert.notEqual(await account(f, "setup"), 0);
      assert.match(f.err(), pattern);
      assert.equal(f.stores.accounts.status().state, "none");
      for (const s of secrets) if (s.length > 5) assert.ok(!f.all().includes(s));
    } finally {
      f.done();
    }
  }
});

test("cancelling the prompt changes nothing", async () => {
  const f = fixture({ secrets: [PASSWORD] });
  try {
    assert.equal(await account(f, "setup"), 1);
    assert.match(f.err(), /cancelled/);
    assert.equal(f.stores.accounts.status().state, "none");
  } finally {
    f.done();
  }
});

test("reset-password ends all sessions and repairs a damaged record", async () => {
  const f = fixture({ secrets: [OTHER, OTHER] });
  try {
    await f.stores.accounts.create("daniel", PASSWORD);
    f.stores.sessions.create({ kind: "browser", origin: "local", credentialVersion: 1 });
    f.stores.db.sqlite.prepare("UPDATE ui_account SET password_hash='broken'").run();
    assert.equal(f.stores.accounts.status().state, "damaged");
    assert.equal(await account(f, "reset-password"), 0);
    assert.equal(f.stores.accounts.status().state, "present");
    assert.equal(f.stores.sessions.list().length, 0);
    assert.equal((await f.stores.accounts.verifyLogin("daniel", OTHER)).ok, true);
    assert.ok(!f.all().includes(OTHER));
  } finally {
    f.done();
  }
});

test("reset-password without an account says so", async () => {
  const f = fixture({ secrets: [OTHER, OTHER] });
  try {
    assert.equal(await account(f, "reset-password"), 1);
    assert.match(f.err(), /no account yet/);
  } finally {
    f.done();
  }
});

test("status, devices, revoke, logout-all and unlock", async () => {
  const f = fixture();
  try {
    await f.stores.accounts.create("daniel", PASSWORD);
    const a = f.stores.sessions.create({
      kind: "browser",
      origin: "local",
      credentialVersion: 1,
      userAgent: "Mozilla/5.0 X",
    });
    const b = f.stores.sessions.create({ kind: "device", origin: "public", credentialVersion: 1, label: "Pixel" });
    const attempt = f.stores.throttle.check({ access: "public", cfConnectingIp: "203.0.113.9" });
    assert.equal(attempt.kind, "allowed");
    if (attempt.kind === "allowed") for (let i = 0; i < 5; i++) f.stores.throttle.report(attempt, false);

    assert.equal(await account(f, "status"), 0);
    assert.match(f.out(), /present \(user name: daniel\)/);
    assert.match(f.out(), /2 active \(local 1, public 1\)/);
    assert.match(f.out(), /locks: +1 active/);
    assert.match(f.out(), /remote access: +off/);

    await f.io.publicOrigin.set("https://recall.example.com");
    f.out();
    assert.equal(await account(f, "devices"), 0);
    assert.match(f.out(), /Pixel/);
    assert.ok(![a.token, b.token].some((t) => f.out().includes(t)));
    assert.ok(!/[0-9a-f]{64}/.test(f.out()));

    assert.equal(await account(f, "revoke"), 2);
    assert.equal(await account(f, "revoke", "nonexistent"), 1);
    assert.equal(await account(f, "revoke", a.id.slice(0, 8)), 0);
    assert.deepEqual(
      f.stores.sessions.list().map((s) => s.id),
      [b.id]
    );

    assert.equal(await account(f, "unlock"), 0);
    assert.equal(f.stores.throttle.status().length, 0);
    assert.equal(await account(f, "logout-all"), 0);
    assert.equal(f.stores.sessions.list().length, 0);
  } finally {
    f.done();
  }
});

test("status reports a damaged account and no account", async () => {
  const f = fixture();
  try {
    await account(f, "status");
    assert.match(f.out(), /none/);
    await f.stores.accounts.create("daniel", PASSWORD);
    f.stores.db.sqlite.prepare("UPDATE ui_account SET username=''").run();
    await account(f, "status");
    assert.match(f.out(), /DAMAGED/);
  } finally {
    f.done();
  }
});

test("ui remote on sets a valid https origin and hints at tunnel and account", async () => {
  const f = fixture();
  try {
    assert.equal(await remote(f, "on", "https://Recall.Example.com/"), 0);
    assert.equal(f.origin(), "https://recall.example.com");
    assert.match(f.out(), /\/ui/);
    assert.match(f.out(), /no account yet/);
    assert.equal(await remote(f, "status"), 0);
    assert.match(f.out(), /on — https:\/\/recall.example.com/);
  } finally {
    f.done();
  }
});

test("ui remote on refuses anything but a bare https origin", async () => {
  const f = fixture();
  try {
    for (const bad of [
      "http://recall.example.com",
      "https://x.example/path",
      "https://x.example?a=1",
      "https://u:p@x.example",
      "https://localhost",
      "recall.example.com",
      "ftp://x",
    ])
      assert.equal(await remote(f, "on", bad), 2, bad);
    assert.equal(await remote(f, "on"), 2);
    assert.equal(f.origin(), "");
  } finally {
    f.done();
  }
});

test("ui remote off clears the setting and ends only the public sessions", async () => {
  const f = fixture();
  try {
    await f.stores.accounts.create("daniel", PASSWORD);
    const local = f.stores.sessions.create({ kind: "browser", origin: "local", credentialVersion: 1 });
    f.stores.sessions.create({ kind: "device", origin: "public", credentialVersion: 1 });
    f.stores.sessions.create({ kind: "browser", origin: "public", credentialVersion: 1 });
    await remote(f, "on", "https://recall.example.com");
    assert.equal(await remote(f, "off"), 0);
    assert.equal(f.origin(), "");
    assert.match(f.out(), /2 public session/);
    assert.deepEqual(
      f.stores.sessions.list().map((s) => s.id),
      [local.id]
    );
  } finally {
    f.done();
  }
});

test("German words exist for every English key and differ", () => {
  const { en, de } = ACCOUNT_WORDS;
  assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort());
  assert.equal(accountWordsIn("xx"), en);
  assert.notEqual(de.noAccount, en.noAccount);
});

test("German output is used for language de", async () => {
  const f = fixture({ language: "de", tty: false });
  try {
    await account(f, "setup");
    assert.match(f.err(), /interaktives Terminal/);
  } finally {
    f.done();
  }
});

test("a password cannot be handed over as an option or in the environment", () => {
  const parsed = parseArgs(["account", "setup", "--password", PASSWORD]);
  assert.ok((parsed.errors ?? []).length > 0);
  assert.ok(!Object.values(process.env).some((v) => v?.includes(PASSWORD)));
  assert.ok(!process.argv.some((v) => v.includes(PASSWORD)));
});
