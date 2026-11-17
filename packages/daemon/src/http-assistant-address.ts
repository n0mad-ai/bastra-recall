/** Same-origin UI setting and explicitly consented system setup. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { getPrimaryLanguage, getUiEnabled } from "./settings.js";
import { sendJson, readJsonBody } from "./http-util.js";
import {
  assistantAddressOptions,
  changeAssistantName,
  setupAssistantAddress,
  assistantAddressStatus,
  openAssistantAddress,
  assistantAddressFor,
  type AssistantAddressOptions,
} from "./assistant-address.js";
import { normalizeAssistantDisplayName, readableAssistantName } from "./assistant-address-name.js";
import { managedAssistantHostsName } from "./assistant-address-files.js";
import { getAssistantName, getAssistantDisplayName, setAssistantDisplayName } from "./assistant-address-settings.js";
import { AssistantAddressError, hasAddressErrorCode } from "./assistant-address-name.js";
const change = z.strictObject({ name: z.string().min(1), systemConsent: z.boolean().optional() });
const consent = z.strictObject({ systemConsent: z.boolean().optional() });

/** A direct rename that only the system step can complete (#1556: decided by code, never by message text):
 * a set-up address needs consent, a finished partial setup needs it to be restored, or the setting moved
 * during an earlier system step. With consent the setup in applyAddress does that step. */
export const needsSystemStep = (error: unknown) =>
  hasAddressErrorCode(error, "system_consent_required", "partial_needs_consent", "settings_conflict");

/** HTTP status and body for a failed request; the message stays as the daemon wrote it. */
export function addressErrorReply(error: unknown): { status: number; body: { error: string; code: string } } {
  const message = (error as Error).message;
  if (hasAddressErrorCode(error, "system_consent_required"))
    return { status: 409, body: { error: message, code: "system_consent_required" } };
  return {
    status: 400,
    body: {
      error: message,
      code: hasAddressErrorCode(error, "invalid_name") ? "invalid_name" : "address_setup_failed",
    },
  };
}

/** Address name this user's own hosts block registers; a damaged block counts as none (setup reports it). */
async function registeredAddress(o: ReturnType<typeof assistantAddressOptions>): Promise<string | null> {
  try {
    return managedAssistantHostsName(await readFile(o.hostsPath, "utf8"), o.uid);
  } catch {
    return null;
  }
}

/** Saves the name as typed; the address name derives from it (deriveAssistantAddress). With systemConsent
 * (the save is the user's instruction) a macOS address not yet set up for the derived name is set up. If
 * that part fails, the display name still applies and the warning says why; the address stays as it was.
 * A name that derives no address is saved all the same and leaves the address (or none) unchanged. */
export async function renameAssistant(value: string, options: AssistantAddressOptions = {}) {
  const o = assistantAddressOptions(options),
    displayName = normalizeAssistantDisplayName(value, await getPrimaryLanguage(o.settingsPath)),
    name = assistantAddressFor(displayName, o);
  let warning: string | undefined;
  if (name !== null) warning = await applyAddress(name, options, o);
  await setAssistantDisplayName(displayName, o.settingsPath);
  return { warning };
}

/** The address part of a rename: save the derived address name and, with consent, set it up. */
async function applyAddress(
  name: string,
  options: AssistantAddressOptions,
  o: ReturnType<typeof assistantAddressOptions>
): Promise<string | undefined> {
  const system = !!o.systemConsent && o.platform === "darwin",
    openBrowser = o.openBrowser ?? openAssistantAddress;
  // Same address: the existing transaction only repairs an interrupted setup (with consent), nothing else.
  if ((await getAssistantName(o.settingsPath)) === name) await changeAssistantName(name, { ...options, openBrowser });
  else
    try {
      await changeAssistantName(name, { ...options, systemConsent: false }); // no address yet: saved directly
    } catch (error) {
      // A set-up address (or a finished partial setup) needs the system step; the setup below does it.
      if (!system || !needsSystemStep(error)) throw error;
    }
  if (!system || (await registeredAddress(o)) === name) return undefined;
  try {
    return (await setupAssistantAddress({ ...options, name, openBrowser })).warning;
  } catch (error) {
    return (error as Error).message;
  }
}

/** What the settings row shows: the name as typed, the readable form of the set address and the address
 * the typed name derives to (target; null when it derives none). Text only, computed here, not in the UI. */
async function nameForms(name: string | null, options: AssistantAddressOptions) {
  const displayName = await getAssistantDisplayName(options.settingsPath),
    target = displayName === null ? null : assistantAddressFor(displayName, options);
  return {
    displayName,
    readableName: name === null ? null : readableAssistantName(name),
    targetName: target,
    targetReadableName: target === null ? null : readableAssistantName(target),
  };
}

export async function handleAssistantAddressUi(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  options: AssistantAddressOptions,
  refresh: () => Promise<{ port?: number }>
) {
  // #1571: refresh is deliberately NOT gated on ui.enabled. The CLI calls it
  // after an address change (notifyAssistantAddressDaemon, cli/address-cmd.ts)
  // so the daemon picks up the new listener, with or without the web UI; its
  // answer is the address status only, no memory content.
  if (path !== "/ui/assistant-address/refresh" && !(await getUiEnabled(options.settingsPath))) {
    sendJson(res, 404, { error: "UI is disabled" });
    return;
  }
  try {
    let warning: string | undefined;
    if (method === "POST") {
      const body = await readJsonBody(req, 4096);
      if (path === "/ui/assistant-address/setup") {
        const input = consent.parse(body);
        if (input.systemConsent !== true)
          throw new AssistantAddressError(
            "system_consent_required",
            "Systemeinrichtung braucht ausdrückliche Zustimmung (system consent)"
          );
        const result = await setupAssistantAddress({
          ...options,
          systemConsent: input.systemConsent,
          openBrowser: options.openBrowser ?? openAssistantAddress,
        });
        warning = result.warning;
      } else if (path === "/ui/assistant-address") {
        const input = change.parse(body);
        ({ warning } = await renameAssistant(input.name, { ...options, systemConsent: input.systemConsent }));
      } else if (path === "/ui/assistant-address/refresh") {
        z.strictObject({}).parse(body);
      } else {
        sendJson(res, 404, { error: "not found" });
        return;
      }
    } else if (method !== "GET" || path !== "/ui/assistant-address") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const listener = await refresh();
    const status = await assistantAddressStatus({ ...options, gatewayPort: listener.port ?? options.gatewayPort });
    sendJson(res, 200, {
      warning,
      ...status,
      ...(await nameForms(status.name, options)),
      fallbackUrl: `${options.daemonUrl}/ui/`,
    });
  } catch (e) {
    const reply = addressErrorReply(e);
    sendJson(res, reply.status, reply.body);
  }
}
