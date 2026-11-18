/**
 * The assistant address lines of `bastra doctor`, in language.primary (#1602):
 * English when unset or unlisted, German complete. The status' own messages
 * (error, repair, bare-name notice) already follow the same language.
 */
import { assistantAddressStatus } from "../assistant-address.js";
import { ASSISTANT_ADDRESS_PORT } from "../assistant-address-name.js";
import { addressLanguage, addressWords } from "../assistant-address-words.js";

/** `status` is replaceable for tests; doctor uses the real one and names the probed port (#1653). */
export async function printAssistantAddressNote(
  status: typeof assistantAddressStatus = assistantAddressStatus
): Promise<void> {
  const w = addressWords(await addressLanguage().catch(() => undefined));
  try {
    const a = await status({ gatewayPort: ASSISTANT_ADDRESS_PORT });
    if (a.error || a.pending) process.stdout.write(`${w.doctorLine(a.error ?? w.doctorPending)}  ${a.repair}\n`);
    if (a.name)
      process.stdout.write(
        w.doctorLine(a.ready ? w.doctorReachable : w.doctorNotReady(a.name)) +
          `  ${a.urls!.local}\n  ${w.doctorHosts(a.registeredName === a.name, a.firefoxProfiles)}\n  ${a.bareNameNotice}\n`
      );
  } catch (e) {
    process.stdout.write(w.doctorLine((e as Error).message));
  }
}
