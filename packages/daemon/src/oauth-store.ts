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
 * Writes take the cross-process path lock (path-lock.ts), because the daemon
 * and `bastra oauth revoke` both write this file: without it a refresh landing
 * next to a revoke could write the revoked grant back. Files land by rename,
 * so a reader never sees half a file; a mutation that changed nothing does not
 * write at all.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { bastraDataDir } from "./platform-paths.js";
import { withPathLock } from "./path-lock.js";

export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
/** A registration that never led to a grant is dropped after this — DCR is an
 *  open door, so unused clients must not pile up. */
const UNUSED_CLIENT_TTL_MS = 10 * 60_000;
const MAX_CLIENTS = 100;
/** The refresh token replaced last is honoured once more within this window:
 *  two parallel workers, or a rotation whose response was lost, must not cost
 *  the user the connector. Later, or a second time, it counts as a leak. */
const REFRESH_GRACE_MS = 60_000;
const MAX_RETIRED = 10;

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
  /** The refresh token replaced by the last rotation, and when — the one
   *  token the grace window applies to. */
  prev_refresh_hash: string | null;
  rotated_at?: number;
  /** Older refresh tokens. Presenting one means a copy leaked — the whole
   *  grant is revoked (OAuth 2.1 §4.3.1 rotation). */
  retired_hashes?: string[];
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

/** C0/C1 control characters (ESC among them) out of a client-chosen name:
 *  it is printed to a terminal by `bastra oauth list`. */
export function sanitizeClientName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
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

function granted(data: OAuthFile): Set<string> {
  return new Set(data.grants.map((g) => g.client_id));
}

function prune(data: OAuthFile, now: number): void {
  data.grants = data.grants.filter((g) => g.refresh_expires_at > now);
  const used = granted(data);
  data.clients = data.clients.filter(
    (c) => used.has(c.client_id) || now - Date.parse(c.created_at) < UNUSED_CLIENT_TTL_MS,
  );
}

/** Read-modify-write under the path lock; skips the write when nothing changed. */
async function mutate<T>(path: string, fn: (data: OAuthFile, now: number) => T): Promise<T> {
  return withPathLock(path, async () => {
    const data = await load(path);
    const before = JSON.stringify(data);
    const now = Date.now();
    prune(data, now);
    const result = fn(data, now);
    const after = JSON.stringify(data, null, 2);
    if (JSON.stringify(data) !== before) {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}`;
      await writeFile(tmp, after + "\n", { encoding: "utf8", mode: 0o600 });
      await rename(tmp, path);
    }
    return result;
  }, { crossProcess: true });
}

/** At the cap the oldest never-granted registration makes room; only a file
 *  full of clients the user actually approved refuses a new one. */
export async function registerClient(
  meta: { client_name: string; redirect_uris: string[] },
  path = oauthStorePath(),
): Promise<OAuthClient | null> {
  return mutate(path, (data) => {
    if (data.clients.length >= MAX_CLIENTS) {
      const used = granted(data);
      const victim = data.clients
        .filter((c) => !used.has(c.client_id))
        .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
      if (!victim) return null;
      data.clients = data.clients.filter((c) => c !== victim);
    }
    const client: OAuthClient = {
      client_id: randomUUID(),
      client_name: sanitizeClientName(meta.client_name),
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
): Promise<{ grantId: string; tokens: IssuedTokens } | null> {
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
    return { grantId: grant.id, tokens };
  });
}

/** Drops one grant — used when its authorization code is presented twice. */
export async function revokeGrant(grantId: string, path = oauthStorePath()): Promise<void> {
  await mutate(path, (data) => {
    data.grants = data.grants.filter((g) => g.id !== grantId);
  });
}

/** Rotates a refresh token. `null` = invalid; a replayed old token (outside
 *  the grace window, or used twice) also revokes the grant it belonged to. */
export async function refreshGrant(
  p: { refresh_token: string; client_id: string; resource: string | null },
  path = oauthStorePath(),
): Promise<IssuedTokens | null> {
  const h = hashToken(p.refresh_token);
  return mutate(path, (data, now) => {
    const grant = data.grants.find((g) => g.refresh_hash === h || g.prev_refresh_hash === h || g.retired_hashes?.includes(h));
    if (!grant) return null;
    const inGrace = grant.prev_refresh_hash === h && now - (grant.rotated_at ?? 0) < REFRESH_GRACE_MS;
    if (grant.refresh_hash !== h && !inGrace) {
      data.grants = data.grants.filter((g) => g !== grant);
      return null;
    }
    if (grant.client_id !== p.client_id || grant.refresh_expires_at <= now) return null;
    if (p.resource !== null && p.resource !== grant.resource) return null;
    if (!data.clients.some((c) => c.client_id === grant.client_id)) return null;
    // The token replaced before now retires for good; the one replaced now
    // gets the grace window. A grace use therefore spends that token's grace.
    if (grant.prev_refresh_hash) {
      grant.retired_hashes = [...(grant.retired_hashes ?? []), grant.prev_refresh_hash].slice(-MAX_RETIRED);
    }
    grant.prev_refresh_hash = grant.refresh_hash;
    grant.rotated_at = now;
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
