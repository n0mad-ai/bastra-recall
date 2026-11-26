/** Local browser session + CSRF for the complete settings surface. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { isLoopback, isLoopbackHost, hasForwardingHeaders, gateLocalPost, safeEqual } from "./http-auth.js";
import { readJsonBody, sendJson } from "./http-util.js";
import { getUiEnabled, mutateSettings, readSettings, settingsFilePath } from "./settings.js";
import {
  settingEntries,
  storedSetting,
  applySettingChanges,
  type CliSettings,
  type SettingEntry,
} from "./settings-registry.js";
import { effectiveSetting } from "./settings-effective.js";
import { assistantDisplayName } from "./assistant-address-settings.js";
import {
  envSettingsSnapshot,
  envSettingSpec,
  applyEnvSettingChanges,
  validateEnvPinChanges,
  validateRawEnvInput,
} from "./settings-env.js";
import { autostartSnapshot, settingsAutostart, type SettingsAutostart } from "./settings-autostart.js";
import { listClients, revokeClient } from "./oauth-store.js";
import { listOllamaModels } from "./learned-recall/reranker.js";
import { DEVICES_PATH, devicesAction, devicesList } from "./settings-devices.js";
const sessions = new Map<string, { csrf: string; expires: number; path: string; host: string; lastUsed: number }>();
const ttl = 15 * 60_000,
  cookieName = "bastra_settings_session";
// Full: the least recently used session gives way once it has been idle this
// long; sessions used within the window keep the capacity guard (429).
const capacity = 100,
  reclaimIdleMs = 10 * 60_000;
const cookie = (id: string) =>
  `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/ui/settings; Max-Age=${ttl / 1000}`;
/** The session id from the request cookie; "" (never a session key) when absent. */
const presentedSession = (req: IncomingMessage) =>
  req.headers.cookie
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1) ?? "";
export interface SettingsUiOptions {
  path?: string;
  oauthPath?: string;
  restart?: () => Promise<void>;
  autostart?: SettingsAutostart;
}
// `code` names a recoverable denial for the client; it is only set where the
// endpoint calls failure() itself, so no internal error code leaves the endpoint.
function failure(status: number, code?: string): never {
  throw Object.assign(new Error("Settings request denied"), { status, settingsCode: code });
}
/** The assistant name row shows the name as typed; its stored companion field is not a row of its own. */
const DISPLAY_NAME_KEY = "assistant.displayName";
function shownSetting(settings: CliSettings, entry: SettingEntry) {
  const effective = effectiveSetting(entry, settings);
  if (entry.key !== "assistant.name") return { stored: storedSetting(settings, entry), effective };
  const name = assistantDisplayName(settings) ?? undefined;
  return { stored: name, effective: { ...effective, value: name ?? effective.value } };
}
async function snapshot(path: string, options: SettingsUiOptions) {
  const settings = await readSettings(path);
  return {
    entries: [
      ...settingEntries()
        .filter((entry) => entry.key !== DISPLAY_NAME_KEY)
        .map((entry) => {
          const { stored, effective } = shownSetting(settings, entry),
            mask = (value: unknown) =>
              entry.secret ? (value === undefined || value === null ? null : "••••••••") : value;
          return {
            key: entry.key,
            label: entry.label,
            area: entry.area,
            kind: entry.kind,
            choices: entry.choices,
            default: mask(entry.default),
            value: mask(stored ?? entry.default),
            effective: mask(effective.value),
            isSet: stored !== undefined,
            secret: !!entry.secret,
            readonly: !!entry.readonly,
            managed: entry.key === "assistant.name",
            restartRequired: !!entry.restartRequired,
            envOverride: effective.envNames.map((name) => ({
              name,
              value: entry.secret ? "••••••••" : process.env[name],
            })),
          };
        }),
      ...envSettingsSnapshot(settings),
      await autostartSnapshot(options.autostart),
    ],
    oauthClients: (
      await listClients(options.oauthPath ?? (options.path ? join(dirname(path), "oauth.json") : undefined))
    ).map((client) => ({
      id: client.client_id,
      name: client.client_name,
      grants: client.grants,
      lastUsedAt: client.last_used_at,
    })),
    restartAvailable: !!options.restart,
  };
}
/** POST /ui/settings/session: a fresh settings session (cookie + CSRF) for this browser. */
async function openSession(req: IncomingMessage, res: ServerResponse, id: string, path: string): Promise<void> {
  const body = await readJsonBody(req, 256);
  if (Object.keys(body).length) failure(400);
  // The new cookie replaces this browser's old one, so the old session can
  // no longer be presented: free its slot (#1733). Only the cookie holder
  // knows its id, so no other browser's session can be pushed out this way.
  sessions.delete(id);
  if (sessions.size >= capacity) {
    let lru: string | undefined,
      lruAt = Infinity;
    for (const [key, session] of sessions)
      if (session.lastUsed < lruAt) {
        lru = key;
        lruAt = session.lastUsed;
      }
    if (lru && Date.now() - lruAt >= reclaimIdleMs) sessions.delete(lru);
  }
  if (sessions.size >= capacity) failure(429);
  const fresh = randomBytes(32).toString("base64url"),
    csrf = randomBytes(32).toString("base64url");
  sessions.set(fresh, { csrf, expires: Date.now() + ttl, path, host: req.headers.host!, lastUsed: Date.now() });
  res.setHeader("Set-Cookie", cookie(fresh));
  sendJson(res, 200, { csrf, expiresIn: ttl / 1000 });
}
export function dispatchSettingsUi(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: string,
  options: SettingsUiOptions = {}
): boolean {
  if (url !== "/ui/settings" && !url.startsWith("/ui/settings/")) return false;
  void (async () => {
    try {
      res.setHeader("Cache-Control", "no-store");
      if (!isLoopback(req) || !isLoopbackHost(req.headers.host, []) || hasForwardingHeaders(req)) failure(403);
      const path = resolve(options.path ?? settingsFilePath());
      if (!(await getUiEnabled(path))) failure(404);
      if (
        method === "POST" &&
        gateLocalPost({
          origin: req.headers.origin,
          host: req.headers.host,
          contentType: req.headers["content-type"],
          path: url,
        }) !== 200
      )
        failure(403);
      for (const [id, session] of sessions) if (session.expires <= Date.now()) sessions.delete(id);
      const id = presentedSession(req);
      if (url === "/ui/settings/session" && method === "POST") {
        await openSession(req, res, id, path);
        return;
      }
      const session = sessions.get(id);
      if (!session || session.path !== path || session.host !== req.headers.host) failure(401);
      if (method === "GET" && url === "/ui/settings") {
        session.lastUsed = Date.now();
        sendJson(res, 200, await snapshot(path, options));
        return;
      }
      // Installed Ollama models for the model pickers; empty when Ollama is not reachable.
      if (method === "GET" && url === "/ui/settings/models") {
        session.lastUsed = Date.now();
        sendJson(res, 200, { models: await listOllamaModels({ timeoutMs: 2000 }).catch(() => [] as string[]) });
        return;
      }
      if (method === "GET" && url === DEVICES_PATH) {
        session.lastUsed = Date.now();
        const answer = await devicesList(req, path);
        sendJson(res, answer.status, answer.body);
        return;
      }
      if (method !== "POST") failure(405);
      const csrf = req.headers["x-bastra-settings-csrf"];
      if (typeof csrf !== "string" || !safeEqual(csrf, session.csrf)) failure(403, "csrf_mismatch");
      session.lastUsed = Date.now();
      const body = await readJsonBody(req, 128 * 1024);
      if (url === "/ui/settings") {
        if (
          Object.keys(body).some((k) => k !== "changes") ||
          !body.changes ||
          typeof body.changes !== "object" ||
          Array.isArray(body.changes)
        )
          failure(400);
        const changes = body.changes as Record<string, unknown>;
        // Name/address edits retain the existing native system-consent transaction.
        if (Object.hasOwn(changes, "assistant.name")) failure(400);
        const envChanges = Object.fromEntries(Object.entries(changes).filter(([key]) => envSettingSpec(key)));
        const regular = Object.fromEntries(
          Object.entries(changes).filter(([key]) => !envSettingSpec(key) && key !== "autostart")
        );
        const auto = options.autostart ?? settingsAutostart;
        if (Object.hasOwn(changes, "autostart")) {
          // Service registration is a separate transaction: mixing it with a
          // settings write would imply atomicity the operating system cannot offer.
          const enabled = changes.autostart === null ? false : changes.autostart;
          if (
            Object.keys(changes).length !== 1 ||
            typeof enabled !== "boolean" ||
            (await autostartSnapshot(auto)).readonly
          )
            failure(400);
          await auto.set(enabled);
        } else {
          if (Object.hasOwn(regular, "daemon.env")) validateRawEnvInput(regular["daemon.env"]);
          await mutateSettings(
            path,
            (current) => {
              const next = applySettingChanges(current, regular);
              // Preserve the advanced JSON editor, with the same validation and
              // read-only checks on changed pins as the individual controls.
              validateEnvPinChanges(current, next);
              return applyEnvSettingChanges(next, envChanges);
            },
            { refuseCorrupt: true, requireLock: true }
          );
        }
        sendJson(res, 200, await snapshot(path, options));
        return;
      }
      if (url === "/ui/settings/oauth/revoke") {
        if (Object.keys(body).some((k) => k !== "clientId") || typeof body.clientId !== "string") failure(400);
        await revokeClient(
          body.clientId,
          options.oauthPath ?? (options.path ? join(dirname(path), "oauth.json") : undefined)
        );
        sendJson(res, 200, await snapshot(path, options));
        return;
      }
      const devices = await devicesAction(req, url, body, path);
      if (devices) {
        sendJson(res, devices.status, devices.body);
        return;
      }
      if (url === "/ui/settings/restart") {
        if (Object.keys(body).length) failure(400);
        if (!options.restart) failure(409);
        sendJson(res, 202, { restarting: true });
        setImmediate(() => void options.restart!().catch(() => {}));
        return;
      }
      failure(404);
    } catch (error) {
      const status = (error as { status?: number }).status ?? 400;
      // Neither parser errors, SQLite errors nor supplied values leave this endpoint.
      sendJson(res, status, {
        error:
          status === 401
            ? "Einstellungssitzung erforderlich"
            : status === 403
              ? "Zugriff nicht erlaubt"
              : "Einstellungen konnten nicht verarbeitet werden",
        // Another tab replaced the session cookie: the client renews once (#1699).
        code: (error as { settingsCode?: string }).settingsCode,
      });
    }
  })();
  return true;
}
