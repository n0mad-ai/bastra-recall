import { autostartService, autostartOn, autostartOff } from "./cli/autostart.js";
export interface SettingsAutostart {
  status(): Promise<{ installed: boolean; managed: boolean; supported: boolean }>;
  set(enabled: boolean): Promise<void>;
}
export const settingsAutostart: SettingsAutostart = {
  async status() {
    // Windows has no non-disruptive staging adapter yet.
    const service = autostartService();
    if (!service) return { installed: false, managed: false, supported: false };
    const state = await service.status();
    return { installed: state.exists, managed: state.managed, supported: process.platform === "darwin" };
  },
  async set(enabled) {
    if (process.platform !== "darwin") throw new Error("Staged autostart is unsupported");
    const code = enabled
      ? await autostartOn({ dryRun: false, force: false, vaultPath: null }, true)
      : await autostartOff({ dryRun: false, force: false }, true);
    if (code !== 0) throw new Error("Autostart registration failed");
  },
};
export async function autostartSnapshot(control: SettingsAutostart = settingsAutostart) {
  const state = await control.status();
  return {
    key: "autostart",
    label: "Beim Anmelden starten",
    area: "general",
    kind: "boolean",
    default: false,
    value: state.installed,
    effective: state.installed,
    isSet: state.installed,
    secret: false,
    managed: false,
    readonly: !state.supported || (state.installed && !state.managed),
    readonlyCode: !state.supported
      ? "autostart-unsupported"
      : state.installed && !state.managed
        ? "autostart-unmanaged"
        : undefined,
    restartRequired: false,
    storage: "autostart",
    envOverride: [],
  };
}
