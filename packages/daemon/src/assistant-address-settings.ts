import { mutateSettings, readSettings, settingsFilePath } from "./settings-file.js";
import { normalizeAssistantName } from "./assistant-address-name.js";
export async function getAssistantName(path = settingsFilePath()): Promise<string | null> {
  return (await readSettings(path)).assistant?.name ?? null;
}
export async function setAssistantName(value: string | null, path = settingsFilePath()): Promise<void> {
  const name = value === null || value === "" ? null : normalizeAssistantName(value);
  await mutateSettings(path, current => {
    const next = { ...current };
    if (name === null) delete next.assistant; else next.assistant = { name };
    return next;
  });
}
