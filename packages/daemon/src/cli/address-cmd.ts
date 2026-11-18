import {
  assistantAddressStatus,
  changeAssistantName,
  setupAssistantAddress,
  removeAssistantAddress,
  notifyAssistantAddressDaemon,
  addressRemovalNeedsConsent,
  openAssistantAddress,
  assistantAddressFor,
  type AssistantAddressOptions,
} from "../assistant-address.js";
import { requireAssistantAddress, normalizeAssistantDisplayName, assistantUrls } from "../assistant-address-name.js";
import { getAssistantDisplayName, setAssistantDisplayName } from "../assistant-address-settings.js";
import { hasAddressErrorCode } from "../assistant-address-name.js";
import { confirm } from "./prompt.js";
import { getPrimaryLanguage } from "../settings.js";
import { addressLanguage, addressWords } from "../assistant-address-words.js";
import type { ParsedArgs } from "./types.js";
export async function cmdAddress(args: ParsedArgs, options?: AssistantAddressOptions): Promise<number> {
  options ??= {};
  const language = options.language ?? (await addressLanguage(options.settingsPath)),
    w = addressWords(language);
  try {
    const action = args.surface ?? "status",
      value = args.positional[2];
    if (action === "status") {
      const s = {
        ...(await assistantAddressStatus(options)),
        displayName: await getAssistantDisplayName(options.settingsPath),
      };
      process.stdout.write(
        args.json
          ? JSON.stringify(s) + "\n"
          : `${s.displayName ?? w.noName}\n${s.urls ? `${s.urls.local}\n${s.urls.bare}\n` : ""}${s.ready ? w.reachable : w.notReachable}\n${s.bareNameNotice}\n${s.repair ?? ""}\n${s.processBoundUpgrade ? w.processBoundUpgrade(s.processBoundUpgrade) : ""}`
      );
      return 0;
    }
    if (!["setup", "remove"].includes(action))
      throw new Error("bastra address status | setup [name] [--yes] | remove [--yes]");
    if (args.dryRun) {
      const name = value ? requireAssistantAddress(value, [], language) : null;
      process.stdout.write(w.dryRun(action === "remove", name ? JSON.stringify(assistantUrls(name)) : null));
      return 0;
    }
    const needs = action === "setup" || (await addressRemovalNeedsConsent(options));
    const allowed =
      !needs || args.yes || (process.stdin.isTTY && process.stdout.isTTY && (await confirm(w.confirmChange)));
    if (!allowed) throw new Error(w.notConfirmed);
    if (action === "setup") {
      const result = await setupAssistantAddress({
        ...options,
        name: value,
        systemConsent: true,
        openBrowser: options.openBrowser ?? openAssistantAddress,
      });
      if (result.warning) process.stdout.write(result.warning + "\n");
    } else await removeAssistantAddress({ ...options, systemConsent: !!allowed });
    await notifyAssistantAddressDaemon();
    process.stdout.write(action === "setup" ? w.setupDone : w.removed);
    return 0;
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 1;
  }
}
/** Saves the name as typed. A name that derives no address keeps the existing address (or none). */
export async function configureAssistantName(value: string): Promise<void> {
  const displayName = normalizeAssistantDisplayName(value, await getPrimaryLanguage()),
    name = assistantAddressFor(displayName);
  if (name !== null) await changeAddressName(name);
  await setAssistantDisplayName(displayName);
  await notifyAssistantAddressDaemon();
}
async function changeAddressName(name: string): Promise<void> {
  try {
    await changeAssistantName(name);
  } catch (e) {
    if (
      hasAddressErrorCode(e, "system_consent_required") &&
      process.stdin.isTTY &&
      process.stdout.isTTY &&
      (await confirm(addressWords(await getPrimaryLanguage()).confirmRename))
    )
      await changeAssistantName(name, { systemConsent: true, openBrowser: openAssistantAddress });
    else throw e;
  }
}
