/** Same-origin UI setting and explicitly consented system setup. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { getUiEnabled } from "./settings.js";
import { sendJson, readJsonBody } from "./http-util.js";
import {
  assistantAddressOptions,
  changeAssistantName,
  setupAssistantAddress,
  assistantAddressStatus,
  openAssistantAddress,
  type AssistantAddressOptions,
} from "./assistant-address.js";
import { normalizeAssistantName } from "./assistant-address-name.js";
import { managedAssistantHostsName } from "./assistant-address-files.js";
import { getAssistantName, getAssistantDisplayName, setAssistantDisplayName } from "./assistant-address-settings.js";
const change = z.strictObject({ name: z.string().min(1), systemConsent: z.boolean().optional() });
const consent = z.strictObject({ systemConsent: z.literal(true) });
const needsConsent = (message: string) => /consent|Zustimmung/i.test(message);

/** Address name this user's own hosts block registers; a damaged block counts as none (setup reports it). */
async function registeredAddress(o: ReturnType<typeof assistantAddressOptions>): Promise<string | null> {
  try {
    return managedAssistantHostsName(await readFile(o.hostsPath, "utf8"), o.uid);
  } catch {
    return null;
  }
}

/** Saves the name as typed; the address name derives from it (lower case). With systemConsent (the save is
 * the user's instruction) a macOS address not yet set up for the derived name is set up. If that part fails,
 * the display name still applies and the warning says why; the address stays as it was. */
export async function renameAssistant(value: string, options: AssistantAddressOptions = {}) {
  const o = assistantAddressOptions(options),
    name = normalizeAssistantName(value),
    system = !!o.systemConsent && o.platform === "darwin",
    openBrowser = o.openBrowser ?? openAssistantAddress;
  // Same address: the existing transaction only repairs an interrupted setup (with consent), nothing else.
  if ((await getAssistantName(o.settingsPath)) === name) await changeAssistantName(value, { ...options, openBrowser });
  else
    try {
      await changeAssistantName(value, { ...options, systemConsent: false }); // no address yet: saved directly
    } catch (error) {
      // A set-up address (or a finished partial setup) needs the system step; the setup below does it.
      if (!system || !/consent|Zustimmung|Systemfreigabe/i.test((error as Error).message)) throw error;
    }
  let warning: string | undefined;
  if (system && (await registeredAddress(o)) !== name)
    try {
      ({ warning } = await setupAssistantAddress({ ...options, name, openBrowser }));
    } catch (error) {
      warning = (error as Error).message;
    }
  await setAssistantDisplayName(value, o.settingsPath);
  return { warning };
}

export async function handleAssistantAddressUi(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  options: AssistantAddressOptions,
  refresh: () => Promise<{ port?: number }>
) {
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
    sendJson(res, 200, {
      warning,
      ...(await assistantAddressStatus({ ...options, gatewayPort: listener.port ?? options.gatewayPort })),
      displayName: await getAssistantDisplayName(options.settingsPath),
      fallbackUrl: `${options.daemonUrl}/ui/`,
    });
  } catch (e) {
    const error = (e as Error).message,
      consentMissing = needsConsent(error);
    sendJson(res, consentMissing ? 409 : 400, {
      error,
      code: consentMissing
        ? "system_consent_required"
        : /^Assistentenname:/.test(error)
          ? "invalid_name"
          : "address_setup_failed",
    });
  }
}
