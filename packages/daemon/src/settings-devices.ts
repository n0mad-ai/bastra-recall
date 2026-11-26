/**
 * #1198 S7 — "Account and devices" of the settings page: who is signed in, the
 * throttle state, and the actions on both. Called by settings-ui.ts after its own
 * protection (loopback peer and host, no forwarding headers, settings session,
 * CSRF); the web-UI sign-in gate has already required a UI session when an
 * account exists, and /ui/settings* is never reachable through the tunnel.
 *
 * Answers carry no hashes and no secrets: sessions are identified by the neutral
 * handle `id` only.
 */
import type { IncomingMessage } from "node:http";
import { getUiPublicOrigin, mutateSettings } from "./settings.js";
import { applySettingChanges } from "./settings-registry.js";
import { uiRequestState } from "./ui-auth-gate.js";
import { uiAuthStores, type UiAuthStores } from "./ui-auth-stores.js";

export const DEVICES_PATH = "/ui/settings/devices";

export interface DevicesAnswer {
  status: number;
  body: Record<string, unknown>;
}

const ok = async (path: string, req: IncomingMessage, stores: UiAuthStores | null): Promise<DevicesAnswer> => {
  const account = stores?.accounts.status();
  const current = uiRequestState(req)?.session?.id;
  const throttle = stores?.throttle.status() ?? [];
  return {
    status: 200,
    body: {
      // "unavailable": the app database cannot be opened (sign-in is locked then).
      account: account?.state ?? "unavailable",
      username: account?.state === "present" ? account.username : undefined,
      publicOrigin: (await getUiPublicOrigin(path)) || null,
      sessions: (stores?.sessions.list() ?? []).map((s) => ({
        id: s.id,
        kind: s.kind,
        origin: s.origin,
        label: s.label,
        userAgent: s.userAgent,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.expiresAt,
        current: s.id === current,
      })),
      // Only entries that count: failures in the window or an active lock.
      locks: throttle
        .filter((e) => e.failures > 0 || e.lockedUntil > 0)
        .map((e) => ({
          scope: e.bucket === "account" ? "account" : "source",
          source: e.bucket.startsWith("source:") ? e.bucket.slice("source:".length) : undefined,
          failures: e.failures,
          lockedUntil: e.lockedUntil,
          lastFailureAt: e.lastFailureAt,
        })),
    },
  };
};

/** GET /ui/settings/devices */
export function devicesList(req: IncomingMessage, path: string): Promise<DevicesAnswer> {
  return ok(path, req, uiAuthStores());
}

const BAD: DevicesAnswer = { status: 400, body: { error: "bad-request" } };

type Action = (
  stores: UiAuthStores,
  body: Record<string, unknown>,
  own: string | undefined,
  path: string
) => Promise<boolean> | boolean;

/** A body-less action; any body field makes the request invalid. */
const bare =
  (run: (stores: UiAuthStores, own: string | undefined, path: string) => Promise<void> | void): Action =>
  async (stores, body, own, path) => {
    if (Object.keys(body).length) return false;
    await run(stores, own, path);
    return true;
  };

const ACTIONS: Record<string, Action> = {
  revoke: (stores, body) => {
    if (Object.keys(body).some((k) => k !== "id") || typeof body.id !== "string") return false;
    stores.sessions.revoke(body.id);
    return true;
  },
  "revoke-others": bare((stores, own) => {
    for (const s of stores.sessions.list()) if (s.id !== own) stores.sessions.revoke(s.id);
  }),
  "revoke-public": bare((stores) => void stores.sessions.revokeOrigin("public")),
  unlock: bare((stores) => void stores.throttle.unlock()),
  "remote-off": bare(async (stores, _own, path) => {
    await mutateSettings(path, (current) => applySettingChanges(current, { "ui.public_origin": null }), {
      refuseCorrupt: true,
      requireLock: true,
    });
    stores.sessions.revokeOrigin("public");
  }),
};

/**
 * POST /ui/settings/devices/<action>; null when the path is no devices action.
 * Every action answers with the fresh list.
 */
export async function devicesAction(
  req: IncomingMessage,
  url: string,
  body: Record<string, unknown>,
  path: string
): Promise<DevicesAnswer | null> {
  if (!url.startsWith(`${DEVICES_PATH}/`)) return null;
  const action = Object.hasOwn(ACTIONS, url.slice(DEVICES_PATH.length + 1))
    ? ACTIONS[url.slice(DEVICES_PATH.length + 1)]
    : undefined;
  if (!action) return null;
  const stores = uiAuthStores();
  if (!stores) return { status: 503, body: { error: "unavailable" } };
  if (!(await action(stores, body, uiRequestState(req)?.session?.id, path))) return BAD;
  return ok(path, req, stores);
}
