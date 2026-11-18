/**
 * Assistant-address options and the small file reads every part of the
 * lifecycle shares: the resolved paths (real defaults; tests supply isolated
 * paths/IO), the owned-service checks and the local state file. Split out of
 * assistant-address.ts (#1532) so the runtime and Firefox modules can use them
 * without importing the lifecycle back.
 */
import { userInfo, homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { settingsFilePath } from "./settings-file.js";
import type { AddressAdminPlan } from "./assistant-address-admin.js";
import { resolveDaemonEndpoint } from "./daemon-endpoint.js";

export type RuntimeProcess = { pid: number; uid: number; command: string; started?: string };
export interface AssistantAddressOptions {
  runtimeProcesses?: () => Promise<RuntimeProcess[]>;
  runtimeProcess?: (pid: number) => Promise<RuntimeProcess | null>;
  retireRuntime?: (pid: number) => void;
  runtimeSourceDir?: string;
  runtimeNode?: string;
  adminStagingRoot?: string;
  usernameLookup?: () => string;
  machineNames?: readonly string[];
  helperLoaded?: () => Promise<boolean | null>;
  settingsPath?: string;
  hostsPath?: string;
  runtimeDir?: string;
  firefoxRoot?: string;
  helperPath?: string;
  uid?: string;
  username?: string;
  home?: string;
  platform?: NodeJS.Platform;
  daemonUrl?: string;
  systemConsent?: boolean;
  gatewayPort?: number;
  firefoxRunning?: () => Promise<boolean>;
  openBrowser?: (url: string) => Promise<void>;
  runAdmin?: (plan: AddressAdminPlan) => Promise<void>;
  ensureRuntime?: () => Promise<void>;
}
function lookupUsername(o: AssistantAddressOptions): string {
  try {
    return (o.usernameLookup ?? (() => userInfo().username))();
  } catch {
    return "";
  }
}
function defaultHostsPath(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "drivers", "etc", "hosts")
    : "/etc/hosts";
}
function defaultFirefoxRoot(home: string, platform: NodeJS.Platform): string {
  return platform === "darwin"
    ? join(home, "Library", "Application Support", "Firefox")
    : platform === "win32"
      ? join(process.env.APPDATA ?? home, "Mozilla", "Firefox")
      : join(home, ".mozilla", "firefox");
}
export function assistantAddressOptions(o: AssistantAddressOptions = {}) {
  const home = o.home ?? homedir(),
    uid = o.uid ?? String(process.getuid?.() ?? 0),
    platform = o.platform ?? process.platform;
  const username = o.username === undefined ? lookupUsername(o) : o.username;
  return {
    ...o,
    home,
    uid,
    platform,
    username,
    settingsPath: o.settingsPath ?? settingsFilePath(),
    runtimeDir: o.runtimeDir ?? join(home, ".bastra", "assistant-address"),
    hostsPath: o.hostsPath ?? defaultHostsPath(platform),
    helperPath: o.helperPath ?? `/Library/LaunchDaemons/ai.n0mad.bastra-recall.address.${uid}.plist`,
    firefoxRoot: o.firefoxRoot ?? defaultFirefoxRoot(home, platform),
    daemonUrl: o.daemonUrl ?? resolveDaemonEndpoint().baseUrl,
  };
}
export async function optional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
export async function atomic(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temp, content, { mode: 0o600, flag: "wx" });
  try {
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
export const companionPath = (o: ReturnType<typeof assistantAddressOptions>) => o.helperPath + ".ipv6.plist";
export async function ownCompanion(o: ReturnType<typeof assistantAddressOptions>) {
  const text = await optional(companionPath(o));
  if (text !== null && !text.includes(`<key>BASTRA_ASSISTANT_ADDRESS_OWNER</key><string>${o.uid}</string>`))
    throw new Error("foreign assistant IPv6 service — left unchanged");
  return text;
}
export async function ownHelper(o: ReturnType<typeof assistantAddressOptions>) {
  const text = await optional(o.helperPath);
  if (text !== null && !text.includes(`<key>BASTRA_ASSISTANT_ADDRESS_OWNER</key><string>${o.uid}</string>`))
    throw new Error("foreign assistant socket service — left unchanged");
  return text;
}
export async function state(
  o: ReturnType<typeof assistantAddressOptions>
): Promise<{ name?: string; firefoxFiles?: string[]; firefoxOwnedPrefs?: Record<string, string[]> } | null> {
  const raw = await optional(join(o.runtimeDir, "state.json"));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("assistant address state is damaged");
  }
}
