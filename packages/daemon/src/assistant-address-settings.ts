import { mutateSettings, readSettings, settingsFilePath, type CliSettings } from "./settings-file.js";
import {
  normalizeAssistantName,
  deriveAssistantAddress,
  normalizeAssistantDisplayName,
  readableAssistantName,
} from "./assistant-address-name.js";
/** Address name (DNS label): what hosts, helper and gateway use. */
export async function getAssistantName(path = settingsFilePath()): Promise<string | null> {
  return (await readSettings(path)).assistant?.name ?? null;
}
/** The name as the user typed it; older settings without one show the address name in readable form. */
export function assistantDisplayName(settings: CliSettings): string | null {
  const { displayName, name } = settings.assistant ?? {};
  return displayName ?? (name ? readableAssistantName(name) : null);
}
export async function getAssistantDisplayName(path = settingsFilePath()): Promise<string | null> {
  return assistantDisplayName(await readSettings(path));
}
/** Sets the address name. A display name survives only while it still derives to this address. */
export async function setAssistantName(value: string | null, path = settingsFilePath()): Promise<void> {
  const name = value === null || value === "" ? null : normalizeAssistantName(value);
  await mutateSettings(path, (current) => {
    const next = { ...current };
    const displayName = current.assistant?.displayName;
    if (name === null) delete next.assistant;
    else
      next.assistant =
        displayName !== undefined && deriveAssistantAddress(displayName) === name ? { name, displayName } : { name };
    return next;
  });
}
/** Stores the display name as typed (trimmed, NFC); only its technical limits apply. The address itself
 * changes only through setAssistantName, so a display name may lead an address still to be set up, or
 * derive none at all: then the existing address (or none) stays. */
export async function setAssistantDisplayName(value: string, path = settingsFilePath()): Promise<void> {
  const displayName = normalizeAssistantDisplayName(value);
  await mutateSettings(path, (current) => ({ ...current, assistant: { ...current.assistant, displayName } }));
}
