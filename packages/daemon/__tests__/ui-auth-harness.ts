/**
 * #1198 S5 — shared harness for the sign-in HTTP tests: an isolated daemon
 * (temp vault, temp HOME, the runner's isolated app database), the web UI on,
 * `ui.public_origin` set, and requests with simulated tunnel headers.
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type IncomingHttpHeaders } from "node:http";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";
import { mutateSettings, setUiEnabled, settingsFilePath } from "../src/settings.js";
import { applySettingChanges } from "../src/settings-registry.js";
import { uiAuthStores, type UiAuthStores } from "../src/ui-auth-stores.js";

export const PUBLIC_HOST = "recall.example.test";
export const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
export const USER = "daniel";
export const PASSWORD = "correct horse battery staple";
export const API_TOKEN = "ui-auth-test-token";

export interface Res {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json: () => Record<string, unknown>;
}

export function call(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: out,
          json: () => JSON.parse(out) as Record<string, unknown>,
        })
      );
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Headers cloudflared adds for a request through the tunnel. */
export function tunnel(extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: PUBLIC_HOST,
    "x-forwarded-proto": "https",
    "x-forwarded-for": "203.0.113.9",
    "cf-connecting-ip": "203.0.113.9",
    ...extra,
  };
}

/** Headers of a direct request on the Mac. */
export function local(port: number, extra: Record<string, string> = {}): Record<string, string> {
  return { host: `127.0.0.1:${port}`, ...extra };
}

export const JSON_TYPE = { "content-type": "application/json" };

/** The cookie pair (name=value) from a Set-Cookie answer. */
export function cookieOf(res: Res): string {
  const header = res.headers["set-cookie"]?.[0];
  if (!header) throw new Error(`no Set-Cookie (status ${res.status}: ${res.body})`);
  return header.split(";", 1)[0]!;
}

function stores(): UiAuthStores {
  const found = uiAuthStores();
  if (!found) throw new Error("app database unavailable");
  return found;
}

/** Fresh sign-in state: no account, no sessions, no counters. */
export function resetAuth(): void {
  const s = stores();
  s.sessions.revokeAll();
  s.throttle.unlock();
  s.db.sqlite.prepare("DELETE FROM ui_account").run();
}

export async function createAccount(): Promise<void> {
  const created = await stores().accounts.create(USER, PASSWORD);
  if (!created.ok) throw new Error(created.problem);
}

export async function setPublicOrigin(origin: string | null): Promise<void> {
  await mutateSettings(settingsFilePath(), (current) => applySettingChanges(current, { "ui.public_origin": origin }));
}

/** Sign in through the tunnel or on the Mac; returns the cookie pair and the CSRF value. */
export async function signIn(
  port: number,
  access: "public" | "local",
  remember = false
): Promise<{ cookie: string; csrf: string }> {
  const headers = access === "public" ? tunnel({ ...JSON_TYPE, origin: PUBLIC_ORIGIN }) : local(port, { ...JSON_TYPE });
  const res = await call(
    port,
    "POST",
    "/ui/auth/login",
    headers,
    JSON.stringify({ username: USER, password: PASSWORD, remember })
  );
  const cookie = cookieOf(res);
  const state = await call(port, "GET", "/ui/auth/state", {
    ...(access === "public" ? tunnel() : local(port)),
    cookie,
  });
  return { cookie, csrf: String(state.json().csrf) };
}

async function buildVault(): Promise<{ dir: string; vault: Vault }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-ui-auth-"));
  await mkdir(join(dir, "memories", "projects", "alpha"), { recursive: true });
  const ts = new Date().toISOString();
  await writeFile(
    join(dir, "memories", "projects", "alpha", "a1.md"),
    [
      "---",
      "id: a1",
      "title: Title of a1",
      "type: reference",
      "summary: Summary of a1",
      "topic_path:",
      "  - test",
      "tags:",
      "  - test",
      "scope: ui-auth-test",
      "recall_when:",
      "  - a1",
      `created: ${ts}`,
      `updated: ${ts}`,
      "---",
      "",
      "Body of a1.",
      "",
    ].join("\n")
  );
  const vault = new Vault(dir);
  await vault.init();
  return { dir, vault };
}

/** A daemon on a free port with the web UI on and `ui.public_origin` set. */
export async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
  const { dir, vault } = await buildVault();
  const home = await mkdtemp(join(tmpdir(), "bastra-ui-auth-home-"));
  const saved = { HOME: process.env.HOME, BASTRA_API_TOKEN: process.env.BASTRA_API_TOKEN };
  process.env.HOME = home;
  process.env.BASTRA_API_TOKEN = API_TOKEN;
  await setUiEnabled(true);
  await setPublicOrigin(PUBLIC_ORIGIN);
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const handle = await startHttpServer({
    // The peer-account check (lsof) is not what these tests are about; it stays as in production otherwise.
    localAccount: { platform: "linux" },
    port: 0,
    vault,
    search,
    telemetry,
    version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" },
  });
  try {
    await fn(handle.port!);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    search.stop();
    await vault.stop?.();
    await handle.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
