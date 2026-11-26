/**
 * `bastra account …` and `bastra ui remote …` (#1198) — the web UI account,
 * its sessions and the switch for access over the internet.
 *
 * Works on the app database directly (BASTRA_DB_PATH, ~/.bastra/recall.db), no
 * daemon needed: the daemon reads sessions and `ui.public_origin` on every
 * request, so every change here bites at once.
 *
 * Passwords: only ever read from the controlling terminal (task-private-prompt),
 * never from argv, environment or a pipe, and never printed or logged. Without
 * a terminal the interactive commands stop with a message instead of hanging.
 */
import { applySettingChanges, normalizePublicUiOrigin } from "../settings-registry.js";
import { uiUsernameProblem } from "../ui-account-store.js";
import { uiPasswordProblem } from "../ui-password.js";
import { uiAuthStores, type UiAuthStores } from "../ui-auth-stores.js";
import type { UiSessionInfo } from "../ui-session.js";
import { getUiPublicOrigin } from "../settings.js";
import { mutateSettings, settingsFilePath } from "../settings-file.js";
import { accountWords, type AccountWords } from "./account-words.js";
import { ask } from "./prompt.js";
import { taskPrivatePrompt } from "./task-private-prompt.js";

/** Everything the commands touch outside their own logic; tests replace it. */
export interface AccountIO {
  stores(): UiAuthStores | null;
  interactive(): boolean;
  askLine(question: string): Promise<string | null>;
  /** Hidden input from the terminal; rejects when the person cancels. */
  askSecret(label: string): Promise<string>;
  out(text: string): void;
  err(text: string): void;
  words(): Promise<AccountWords>;
  publicOrigin: { get(): Promise<string>; /** null clears the setting. */ set(value: string | null): Promise<void> };
}

const SESSION_LABEL_CHARS = 40;

const settingsPublicOrigin: AccountIO["publicOrigin"] = {
  get: () => getUiPublicOrigin(),
  set: (value) =>
    mutateSettings(settingsFilePath(), (current) => applySettingChanges(current, { "ui.public_origin": value })),
};

const defaultIO = (): AccountIO => ({
  stores: uiAuthStores,
  interactive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  askLine: ask,
  askSecret: (label) => taskPrivatePrompt(label, true),
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
  words: accountWords,
  publicOrigin: settingsPublicOrigin,
});

/** Runs one command on the shared stores; says so when the database cannot be opened (= locked). */
async function withStores(io: AccountIO, cmd: string, run: (stores: UiAuthStores) => Promise<number>): Promise<number> {
  const stores = io.stores();
  if (!stores) {
    io.err((await io.words()).failed(cmd));
    return 1;
  }
  return run(stores);
}

const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const pad = (text: string, width: number) => text.padEnd(width);
const clip = (text: string, max: number) =>
  [...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text;

/** Asks the password twice, hidden. Returns the password, or null after saying why not (exit code in `code`). */
async function askNewPassword(io: AccountIO, w: AccountWords, first: string): Promise<string | null | "cancelled"> {
  try {
    const password = await io.askSecret(first);
    const problem = uiPasswordProblem(password);
    if (problem) {
      io.err(w.passwordProblem(problem));
      return null;
    }
    if ((await io.askSecret(w.passwordAgain)) !== password) {
      io.err(w.mismatch);
      return null;
    }
    return password;
  } catch {
    io.err(w.cancelled);
    return "cancelled";
  }
}

async function setup(io: AccountIO, w: AccountWords): Promise<number> {
  return withStores(io, "account setup", async (stores) => {
    const store = stores.accounts;
    if (store.status().state !== "none") {
      io.err(store.status().state === "damaged" ? w.accountDamaged : w.accountExists);
      return 1;
    }
    if (!io.interactive()) {
      io.err(w.noTerminal("account setup"));
      return 1;
    }
    const username = await io.askLine(w.usernamePrompt);
    if (username === null) {
      io.err(w.cancelled);
      return 1;
    }
    const nameProblem = uiUsernameProblem(username);
    if (nameProblem) {
      io.err(w.usernameProblem(nameProblem));
      return 2;
    }
    const password = await askNewPassword(io, w, w.passwordPrompt);
    if (password === null) return 2;
    if (password === "cancelled") return 1;
    const result = await store.create(username, password);
    if (!result.ok) {
      io.err(result.problem === "account-exists" ? w.accountExists : w.failed("account setup"));
      return 1;
    }
    io.out(w.created(username.normalize("NFC")));
    return 0;
  });
}

async function resetPassword(io: AccountIO, w: AccountWords): Promise<number> {
  return withStores(io, "account reset-password", async (stores) => {
    const store = stores.accounts;
    if (store.status().state === "none") {
      io.err(w.noAccount);
      return 1;
    }
    if (!io.interactive()) {
      io.err(w.noTerminal("account reset-password"));
      return 1;
    }
    const password = await askNewPassword(io, w, w.passwordNew);
    if (password === null) return 2;
    if (password === "cancelled") return 1;
    const result = await store.setPassword(password);
    if (!result.ok) {
      io.err(w.failed("account reset-password"));
      return 1;
    }
    // credential_version already invalidates old sessions; deleting the rows
    // keeps the device list clean as well.
    io.out(w.passwordSet(stores.sessions.revokeAll()));
    return 0;
  });
}

async function status(io: AccountIO, w: AccountWords): Promise<number> {
  return withStores(io, "account status", async (stores) => {
    const account = stores.accounts.status();
    const sessions = stores.sessions.list();
    const entries = stores.throttle.status();
    const origin = await io.publicOrigin.get();
    const locks = entries
      .filter((e) => e.lockedUntil > 0)
      .map((e) => w.lockLine(e.bucket, stamp(e.lockedUntil), e.failures));
    io.out(w.statusAccount(account.state, account.state === "present" ? account.username : null));
    const pub = sessions.filter((s) => s.origin === "public").length;
    io.out(w.statusSessions(sessions.length, sessions.length - pub, pub));
    io.out(w.statusLocks(locks));
    io.out(w.statusCounters(entries.filter((e) => e.failures > 0).length));
    io.out(origin ? w.statusRemoteOn(origin) : w.statusRemoteOff);
    return 0;
  });
}

const deviceLine = (s: UiSessionInfo, w: AccountWords): string =>
  [
    pad(s.id, 37),
    pad(w.deviceKind(s.kind), 8),
    pad(s.origin, 9),
    pad(stamp(s.lastSeenAt), 21),
    pad(stamp(s.expiresAt), 21),
    clip(s.label || s.userAgent, SESSION_LABEL_CHARS),
  ]
    .join(" ")
    .trimEnd();

async function devices(io: AccountIO, w: AccountWords): Promise<number> {
  return withStores(io, "account devices", async (stores) => {
    const list = stores.sessions.list();
    io.out(list.length === 0 ? w.devicesNone : w.devicesHeader + list.map((s) => `${deviceLine(s, w)}\n`).join(""));
    return 0;
  });
}

async function revoke(io: AccountIO, w: AccountWords, handle: string | undefined): Promise<number> {
  if (!handle) {
    io.err(w.revokeNeedsId);
    return 2;
  }
  return withStores(io, "account revoke", async (stores) => {
    const sessions = stores.sessions;
    // The full handle, or an unambiguous start of one (the list is long to type).
    const matches = sessions.list().filter((s) => s.id === handle || (handle.length >= 6 && s.id.startsWith(handle)));
    const exact = matches.find((s) => s.id === handle);
    if (!exact && matches.length > 1) {
      io.err(w.revokeAmbiguous(handle));
      return 1;
    }
    const target = exact ?? matches[0];
    if (!target || !sessions.revoke(target.id)) {
      io.err(w.revokeNone(handle));
      return 1;
    }
    io.out(w.revoked(target.id));
    return 0;
  });
}

export async function cmdAccount(
  args: { sub: string | null; positional: string[] },
  io: AccountIO = defaultIO()
): Promise<number> {
  const w = await io.words();
  switch (args.sub) {
    case "setup":
      return setup(io, w);
    case "status":
    case null:
      return status(io, w);
    case "reset-password":
      return resetPassword(io, w);
    case "devices":
      return devices(io, w);
    case "revoke":
      return revoke(io, w, args.positional[2]);
    case "logout-all":
      return withStores(io, "account logout-all", async (stores) => {
        io.out(w.loggedOutAll(stores.sessions.revokeAll()));
        return 0;
      });
    case "unlock":
      return withStores(io, "account unlock", async (stores) => {
        io.out(w.unlocked(stores.throttle.unlock()));
        return 0;
      });
    default:
      io.err(w.unknownSub(args.sub));
      return 2;
  }
}

/** `bastra ui remote <on <origin>|off|status>` — `sub` is the word after `ui`. */
export async function cmdUiRemote(args: { positional: string[] }, io: AccountIO = defaultIO()): Promise<number> {
  const w = await io.words();
  const [, sub, action, value] = args.positional;
  if (sub !== "remote") {
    io.err(w.remoteUnknownSub(sub ?? ""));
    return 2;
  }
  switch (action) {
    case "on": {
      if (!value) {
        io.err(w.remoteNeedsOrigin);
        return 2;
      }
      const origin = normalizePublicUiOrigin(value);
      if (!origin) {
        io.err(w.remoteBadOrigin(value));
        return 2;
      }
      return withStores(io, "ui remote on", async (stores) => {
        await io.publicOrigin.set(origin);
        io.out(w.remoteOn(origin, stores.accounts.status().state === "present"));
        return 0;
      });
    }
    case "off":
      return withStores(io, "ui remote off", async (stores) => {
        await io.publicOrigin.set(null);
        io.out(w.remoteOff(stores.sessions.revokeOrigin("public")));
        return 0;
      });
    case "status":
    case undefined: {
      const origin = await io.publicOrigin.get();
      io.out(origin ? w.statusRemoteOn(origin) : w.statusRemoteOff);
      return 0;
    }
    default:
      io.err(w.remoteUnknownSub(`remote ${action}`));
      return 2;
  }
}
