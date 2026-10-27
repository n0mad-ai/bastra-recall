/**
 * #1279 Phase 2: the persistent half of the daemon's OAuth server — the
 * registered clients and the grants issued to them, in one small JSON file
 * under the bastra home (`oauth.json`).
 *
 * Tokens are stored only as SHA-256 hashes: the file proves a presented token,
 * it can never hand one out. A token is 32 random bytes, so an unsalted hash
 * is enough — there is nothing to brute-force.
 *
 * Read on every check instead of cached: `bastra oauth revoke` edits the file
 * from another process, and a revocation must bite on the very next request,
 * without a daemon restart. The file holds a handful of entries.
 *
 * Writes are serialised inside the process and land by rename, so a reader
 * never sees half a file. A CLI revoke racing a token refresh in the same
 * millisecond can still lose one of the two writes; for a single user that is
 * accepted rather than locked against.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { bastraDataDir } from "./platform-paths.js";

export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
/** A registration that never led to a grant is dropped after this — DCR is an
 *  open door, so unused clients must not pile up. */
const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60_000;
const MAX_CLIENTS = 100;

export interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: string;
}

export interface OAuthGrant {
  id: string;
  client_id: string;
  /** RFC 8707 audience: the canonical MCP URL the token is bound to. */
  resource: string;
  scope: string;
  created_at: string;
  last_used_at: string;
  access_hash: string;
  access_expires_at: number;
  refresh_hash: string;
  refresh_expires_at: number;
  /** The refresh token this one replaced. Presenting it again means a copy
   *  leaked — the whole grant is revoked (OAuth 2.1 §4.3.1 rotation). */
  prev_refresh_hash: string | null;
}

interface OAuthFile {
  clients: OAuthClient[];
  grants: OAuthGrant[];
}

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}

export function oauthStorePath(): string {
  return process.env.BASTRA_OAUTH_PATH ?? join(bastraDataDir(), "oauth.json");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

async function load(path: string): Promise<OAuthFile> {
  try {
    const data = JSON.parse(await readFile(path, "utf8")) as Partial<OAuthFile>;
    return { clients: data.clients ?? [], grants: data.grants ?? [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { clients: [], grants: [] };
    throw err;
  }
}

function prune(data: OAuthFile, now: number): void {
  data.grants = data.grants.filter((g) => g.refresh_expires_at > now);
  const granted = new Set(data.grants.map((g) => g.client_id));
  data.clients = data.clients.filter(
    (c) => granted.has(c.client_id) || now - Date.parse(c.created_at) < UNUSED_CLIENT_TTL_MS,
  );
}

let queue: Promise<unknown> = Promise.resolve();

/** Read-modify-write under the in-process queue; the file lands by rename. */
async function mutate<T>(path: string, fn: (data: OAuthFile, now: number) => T): Promise<T> {
  const run = queue.then(async () => {
    const data = await load(path);
    const now = Date.now();
    prune(data, now);
    const result = fn(data, now);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

export async function registerClient(
  meta: { client_name: string; redirect_uris: string[] },
  path = oauthStorePath(),
): Promise<OAuthClient | null> {
  return mutate(path, (data) => {
    if (data.clients.length >= MAX_CLIENTS) return null;
    const client: OAuthClient = {
      client_id: randomUUID(),
      client_name: meta.client_name,
      redirect_uris: meta.redirect_uris,
      created_at: new Date().toISOString(),
    };
    data.clients.push(client);
    return client;
  });
}

export async function getClient(clientId: string, path = oauthStorePath()): Promise<OAuthClient | null> {
  const data = await load(path);
  return data.clients.find((c) => c.client_id === clientId) ?? null;
}

function issueInto(grant: OAuthGrant, now: number): IssuedTokens {
  const access = newToken();
  const refresh = newToken();
  grant.access_hash = hashToken(access);
  grant.access_expires_at = now + ACCESS_TTL_MS;
  grant.refresh_hash = hashToken(refresh);
  grant.refresh_expires_at = now + REFRESH_TTL_MS;
  grant.last_used_at = new Date(now).toISOString();
  return { access_token: access, refresh_token: refresh, expires_in: ACCESS_TTL_MS / 1000, scope: grant.scope };
}

export async function createGrant(
  p: { client_id: string; resource: string; scope: string },
  path = oauthStorePath(),
): Promise<IssuedTokens | null> {
  return mutate(path, (data, now) => {
    if (!data.clients.some((c) => c.client_id === p.client_id)) return null;
    const grant: OAuthGrant = {
      id: randomUUID(),
      client_id: p.client_id,
      resource: p.resource,
      scope: p.scope,
      created_at: new Date(now).toISOString(),
      last_used_at: new Date(now).toISOString(),
      access_hash: "",
      access_expires_at: 0,
      refresh_hash: "",
      refresh_expires_at: 0,
      prev_refresh_hash: null,
    };
    const tokens = issueInto(grant, now);
    data.grants.push(grant);
    return tokens;
  });
}

/** Rotates a refresh token. `null` = invalid; a replayed old token also
 *  revokes the grant it belonged to. */
export async function refreshGrant(
  p: { refresh_token: string; client_id: string; resource: string | null },
  path = oauthStorePath(),
): Promise<IssuedTokens | null> {
  const h = hashToken(p.refresh_token);
  return mutate(path, (data, now) => {
    const replayed = data.grants.findIndex((g) => g.prev_refresh_hash === h);
    if (replayed !== -1) {
      data.grants.splice(replayed, 1);
      return null;
    }
    const grant = data.grants.find((g) => g.refresh_hash === h);
    if (!grant || grant.client_id !== p.client_id || grant.refresh_expires_at <= now) return null;
    if (p.resource !== null && p.resource !== grant.resource) return null;
    if (!data.clients.some((c) => c.client_id === grant.client_id)) return null;
    grant.prev_refresh_hash = grant.refresh_hash;
    return issueInto(grant, now);
  });
}

/** True when `token` is a live access token bound to `resource`. */
export async function verifyAccessToken(token: string, resource: string, path = oauthStorePath()): Promise<boolean> {
  const h = hashToken(token);
  const data = await load(path);
  const grant = data.grants.find((g) => g.access_hash === h);
  if (!grant || grant.access_expires_at <= Date.now() || grant.resource !== resource) return false;
  return data.clients.some((c) => c.client_id === grant.client_id);
}

export interface ClientListing extends OAuthClient {
  grants: number;
  last_used_at: string | null;
}

export async function listClients(path = oauthStorePath()): Promise<ClientListing[]> {
  const data = await load(path);
  return data.clients.map((c) => {
    const own = data.grants.filter((g) => g.client_id === c.client_id);
    const last = own.map((g) => g.last_used_at).sort().at(-1) ?? null;
    return { ...c, grants: own.length, last_used_at: last };
  });
}

/** Removes a client and every grant it holds; `"all"` clears the file.
 *  Returns how many clients were removed. */
export async function revokeClient(clientId: string, path = oauthStorePath()): Promise<number> {
  return mutate(path, (data) => {
    const before = data.clients.length;
    if (clientId === "all") {
      data.clients = [];
      data.grants = [];
      return before;
    }
    data.clients = data.clients.filter((c) => c.client_id !== clientId);
    data.grants = data.grants.filter((g) => g.client_id !== clientId);
    return before - data.clients.length;
  });
}
