/**
 * Assistant-address lifecycle. Defaults are real paths; tests supply isolated paths/IO.
 * #1532: the shared options and file reads live in assistant-address-options.ts,
 * the Firefox profile edits in assistant-address-firefox.ts and the user-owned
 * runtime in assistant-address-runtime.ts; this module keeps the name, the
 * pending admin intent and setup/remove/status, and re-exports the moved
 * public functions.
 */
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { join, dirname, sep } from "node:path";
import { mkdir, rm, stat } from "node:fs/promises";
import { withPathLock, PathLockUnavailableError } from "./path-lock.js";
import { readSettings, SETTINGS_REGISTRY } from "./settings-file.js";
import {
  normalizeAssistantName,
  deriveAssistantAddress,
  requireAssistantAddress,
  assistantUrls,
} from "./assistant-address-name.js";
import { patchAssistantHosts, managedAssistantHostsName } from "./assistant-address-files.js";
import { getAssistantName, setAssistantName } from "./assistant-address-settings.js";
import { AssistantAddressError } from "./assistant-address-name.js";
import { addressWords, withAddressLanguage } from "./assistant-address-words.js";
import {
  renderAssistantSocketPair,
  runMacAddressAdmin,
  cleanupMacAddressAdminStaging,
  addressAdminProcessAlive,
  shellQuote,
  type AddressAdminPlan,
} from "./assistant-address-admin.js";
import { resolveDaemonEndpoint } from "./daemon-endpoint.js";
import {
  assistantAddressOptions,
  atomic,
  companionPath,
  optional,
  ownCompanion,
  ownHelper,
  state,
  type AssistantAddressOptions,
} from "./assistant-address-options.js";
import {
  applyProfiles,
  firefoxOwnership,
  profileAllowed,
  profileEdits,
  requireFirefoxClosed,
  restoreProfiles,
} from "./assistant-address-firefox.js";
import { assistantHelperLoaded, ensureAssistantAddressRuntime } from "./assistant-address-runtime.js";

export { assistantAddressOptions, type AssistantAddressOptions } from "./assistant-address-options.js";
export {
  ensureAssistantAddressRuntime,
  refreshAssistantAddressRuntime,
  migrateAssistantAddressRuntime,
  publishAssistantAddressEndpoint,
} from "./assistant-address-runtime.js";

function machineNames(o: ReturnType<typeof assistantAddressOptions>): readonly string[] {
  if (o.machineNames) return o.machineNames;
  const names = [hostname()];
  if (o.platform === "darwin")
    try {
      names.push(
        execFileSync("/usr/sbin/scutil", ["--get", "LocalHostName"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 1500,
        }).trim()
      );
    } catch {
      /* hostname remains reserved */
    }
  return names;
}
/** The address name a typed name derives to on this machine (its own host names stay reserved), or null. */
export function assistantAddressFor(value: string, options: AssistantAddressOptions = {}): string | null {
  return deriveAssistantAddress(value, machineNames(assistantAddressOptions(options)));
}
class AddressIntentError extends Error {}
class AddressPendingError extends AssistantAddressError {}
class AddressSettingsConflictError extends AssistantAddressError {
  constructor(
    readonly settled: boolean,
    language: string | undefined
  ) {
    super("settings_conflict", addressWords(language).settingsConflict);
  }
}

type ProfileEdit = { path: string; before: string | null; after: string };
interface PendingAddress {
  createdAt?: number;
  ownerPid?: number;
  adminPid?: number;
  recoveryOf?: { intent: PendingAddress; receipt: string | null };
  helperLoadedBefore?: boolean | null;
  id: string;
  plan: AddressAdminPlan;
  name: string | null;
  previousName: string | null;
  profiles: ProfileEdit[];
  desiredState: {
    version: number;
    name: string;
    firefoxFiles: string[];
    firefoxOwnedPrefs: Record<string, string[]>;
  } | null;
}
const pendingPath = (o: ReturnType<typeof assistantAddressOptions>) => join(o.runtimeDir, "pending-admin.json");
const receiptPath = (o: ReturnType<typeof assistantAddressOptions>, id: string) =>
  join(o.runtimeDir, `admin-result-${id}.json`);
async function forgetPending(o: ReturnType<typeof assistantAddressOptions>, p: PendingAddress) {
  await rm(pendingPath(o), { force: true });
  await rm(receiptPath(o, p.id), { force: true });
}
function validatePending(o: ReturnType<typeof assistantAddressOptions>, p: PendingAddress) {
  try {
    if (
      !/^[a-f0-9-]{36}$/.test(p.id) ||
      p.plan?.hostsPath !== o.hostsPath ||
      p.plan?.helperPath !== o.helperPath ||
      (p.plan.companion &&
        (p.plan.companion.path !== companionPath(o) ||
          p.plan.companion.label !== `ai.n0mad.bastra-recall.address.${o.uid}.ipv6`)) ||
      (p.name !== null && p.name !== normalizeAssistantName(p.name)) ||
      !Array.isArray(p.profiles) ||
      !p.profiles.every(
        (e) =>
          profileAllowed(e.path, o.firefoxRoot) ||
          (profileAllowed(join(dirname(e.path), "user.js"), o.firefoxRoot) && e.path.endsWith(sep + "prefs.js"))
      )
    )
      throw new AddressIntentError(addressWords(o.language).intentDamaged);
  } catch {
    throw new AddressIntentError(addressWords(o.language).intentDamaged);
  }
}
async function captureRecovery(o: ReturnType<typeof assistantAddressOptions>) {
  const raw = await optional(pendingPath(o));
  if (!raw) return undefined;
  const p = JSON.parse(raw) as PendingAddress;
  validatePending(o, p);
  if (p.recoveryOf) {
    validatePending(o, p.recoveryOf.intent);
    if (p.recoveryOf.intent.recoveryOf) throw new AddressIntentError(addressWords(o.language).nestedRecoveryDamaged);
    return p.recoveryOf;
  }
  return { intent: p, receipt: await optional(receiptPath(o, p.id)) };
}
async function discardAttempt(o: ReturnType<typeof assistantAddressOptions>, p: PendingAddress) {
  if (!p.recoveryOf) {
    await forgetPending(o, p);
    return;
  }
  const origin = p.recoveryOf;
  validatePending(o, origin.intent);
  if (origin.intent.recoveryOf) throw new AddressIntentError(addressWords(o.language).nestedRecoveryDamaged);
  if (origin.receipt !== null) await atomic(receiptPath(o, origin.intent.id), origin.receipt);
  await atomic(pendingPath(o), JSON.stringify(origin.intent) + "\n");
  await rm(receiptPath(o, p.id), { force: true });
}
async function finishIntent(o: ReturnType<typeof assistantAddressOptions>, p: PendingAddress) {
  if (p.recoveryOf) {
    validatePending(o, p.recoveryOf.intent);
    if (p.name !== null)
      await atomic(join(o.runtimeDir, `recovered-${p.recoveryOf.intent.id}.json`), JSON.stringify(p.recoveryOf) + "\n");
    await rm(receiptPath(o, p.recoveryOf.intent.id), { force: true });
  }
  await forgetPending(o, p);
}
async function partialDescription(o: ReturnType<typeof assistantAddressOptions>) {
  const loaded = await assistantHelperLoaded(o),
    w = addressWords(o.language);
  if (loaded === false) return w.partialHelperUnloaded;
  if (loaded === true) return w.partialHelperLoaded;
  return w.partialHelperUnknown;
}
async function replacePending(o: ReturnType<typeof assistantAddressOptions>, p: PendingAddress) {
  const raw = await optional(pendingPath(o)),
    old = raw ? (JSON.parse(raw) as PendingAddress) : null;
  if (old) validatePending(o, old);
  // Keep the old evidence until its replacement is durable; retain the origin receipt.
  await atomic(pendingPath(o), JSON.stringify(p) + "\n");
  if (old && old.id !== p.recoveryOf?.intent.id) await rm(receiptPath(o, old.id), { force: true });
}
/** Durable intent survives a lost osascript response and a daemon restart.
 * No root work is retried here: only exact observed system outputs are adopted. */
async function reconcileAssistantAddress(
  o: ReturnType<typeof assistantAddressOptions>
): Promise<"none" | "completed" | "pending" | "partial"> {
  const raw = await optional(pendingPath(o));
  if (!raw) return "none";
  const p = JSON.parse(raw) as PendingAddress;
  validatePending(o, p);

  const hosts = await optional(o.hostsPath),
    helper = await optional(o.helperPath),
    companion = p.plan.companion ? await optional(companionPath(o)) : undefined;
  let receipt = await optional(receiptPath(o, p.id));
  const createdAt = p.createdAt ?? (await stat(pendingPath(o))).mtimeMs;
  if (!receipt && Date.now() - createdAt > 300000) {
    // A daemon PID says nothing about a still-running privileged child.
    if (addressAdminProcessAlive(p.adminPid) === false) {
      receipt = JSON.stringify({ success: false, orphaned: true });
      await atomic(receiptPath(o, p.id), receipt);
    }
  }
  const observedDelta = p.plan.hostsAfter !== p.plan.hostsBefore || p.plan.helperAfter !== p.plan.helperBefore;
  const outcome = receipt ? JSON.parse(receipt).success : undefined;
  const completedReceipt = outcome === true,
    settled = typeof outcome === "boolean";
  const loaded =
    p.plan.helperBefore !== null || p.plan.helperAfter !== null || p.plan.companion
      ? await assistantHelperLoaded(o, !!p.plan.companion)
      : false;

  if (
    (observedDelta || completedReceipt) &&
    hosts === p.plan.hostsAfter &&
    helper === p.plan.helperAfter &&
    (!p.plan.companion || companion === p.plan.companion.after) &&
    managedAssistantHostsName(hosts ?? "", o.uid) === p.name
  ) {
    if (settled && loaded !== null && loaded !== (p.name !== null)) return "partial";
    const current = await getAssistantName(o.settingsPath);
    if (current !== p.previousName && current !== p.name) throw new AddressSettingsConflictError(settled, o.language);
    await requireFirefoxClosed(o, p.profiles);
    // Recovery is idempotent if the process died between individual user writes.
    const edits = [];
    for (const e of p.profiles) {
      const actual = await optional(e.path);
      if (actual !== e.after && !(actual === null && e.after === "")) edits.push(e);
    }
    await applyProfiles(edits);
    await setAssistantName(p.name, o.settingsPath);
    if (p.desiredState) await atomic(join(o.runtimeDir, "state.json"), JSON.stringify(p.desiredState) + "\n");
    else await rm(join(o.runtimeDir, "state.json"), { force: true });
    await finishIntent(o, p);
    if (p.name === null) await cleanupAddressRuntime(o);
    return "completed";
  }
  if (
    receipt &&
    JSON.parse(receipt).success === false &&
    hosts === p.plan.hostsBefore &&
    helper === p.plan.helperBefore &&
    (!p.plan.companion || companion === p.plan.companion.before)
  ) {
    // bootout can succeed before a hosts write fails; file equality alone proves no rollback.
    if (p.plan.helperBefore !== null) {
      if (typeof p.helperLoadedBefore !== "boolean" || loaded === null) return "partial";
      if (loaded !== p.helperLoadedBefore) return "partial";
    }
    if (p.recoveryOf) {
      await discardAttempt(o, p);
      return reconcileAssistantAddress(o);
    }
    await forgetPending(o, p);
    return "none";
  }
  if (settled) return "partial"; // terminal failure may leave mixed files or service state
  return "pending"; // A late privileged process may still finish. Keep its intent.
}
async function hasSystem(o: ReturnType<typeof assistantAddressOptions>) {
  return !!(
    (await state(o)) ||
    managedAssistantHostsName((await optional(o.hostsPath)) ?? "", o.uid) ||
    (await ownHelper(o)) ||
    (await ownCompanion(o))
  );
}
async function changeAssistantNameUnlocked(
  value: string,
  options: AssistantAddressOptions = {},
  recovering = false
): Promise<void> {
  const o = assistantAddressOptions(options),
    name = requireAssistantAddress(value, machineNames(o), o.language),
    before = await getAssistantName(o.settingsPath);
  patchAssistantHosts((await optional(o.hostsPath)) ?? "", name, o.uid); // check conflicts before saving
  if (recovering || (before !== name && (await hasSystem(o)))) {
    if (!o.systemConsent)
      throw new AssistantAddressError("system_consent_required", addressWords(o.language).changeNeedsConsent);
    await setupAssistantAddressUnlocked({ ...o, name } as AssistantAddressOptions & { name: string });
    return;
  }
  await setAssistantName(name, o.settingsPath);
}
async function setupAssistantAddressUnlocked(options: AssistantAddressOptions & { name?: string } = {}) {
  const o = assistantAddressOptions(options),
    w = addressWords(o.language),
    name =
      options.name === undefined
        ? normalizeAssistantName((await getAssistantName(o.settingsPath)) ?? "", machineNames(o), o.language)
        : requireAssistantAddress(options.name, machineNames(o), o.language);
  if (!o.systemConsent) throw new AssistantAddressError("system_consent_required", w.setupNeedsConsent);
  if (o.platform !== "darwin") throw new Error(w.macOnly);
  const hostsBefore = await optional(o.hostsPath);
  if (hostsBefore === null) throw new Error("hosts file missing");
  const hostsAfter = patchAssistantHosts(hostsBefore, name, o.uid),
    helperBefore = await ownHelper(o),
    profiles = await profileEdits(o, name);
  await requireFirefoxClosed(o, profiles);
  await ownCompanion(o);
  await (o.ensureRuntime ?? (() => ensureAssistantAddressRuntime(o)))();
  const [helperAfter, companionAfter] = renderAssistantSocketPair({
    uid: o.uid,
    username: o.username,
    home: o.home,
    launcher: join(o.runtimeDir, "launch.sh"),
  });
  const companion = {
    path: companionPath(o),
    before: await ownCompanion(o),
    after: companionAfter,
    label: `ai.n0mad.bastra-recall.address.${o.uid}.ipv6`,
  };
  const plan: AddressAdminPlan = {
    hostsPath: o.hostsPath,
    hostsBefore,
    hostsAfter,
    helperPath: o.helperPath,
    helperBefore,
    helperAfter,
    companion,
    label: `ai.n0mad.bastra-recall.address.${o.uid}`,
  };
  const previousName = await getAssistantName(o.settingsPath),
    firefoxOwnedPrefs = await firefoxOwnership(o, name, profiles);
  const pending: PendingAddress = {
    createdAt: Date.now(),
    ownerPid: process.pid,
    recoveryOf: await captureRecovery(o),
    helperLoadedBefore: helperBefore === null ? false : await assistantHelperLoaded(o),
    id: randomUUID(),
    plan,
    name,
    previousName,
    profiles,
    desiredState: {
      version: 2,
      name,
      firefoxOwnedPrefs,
      firefoxFiles: profiles.filter((p) => p.path.endsWith(sep + "user.js")).map((p) => p.path),
    },
  };
  await replacePending(o, pending);
  try {
    await (o.runAdmin ?? runMacAddressAdmin)({
      ...plan,
      language: o.language,
      onStarted: async (pid) => {
        pending.adminPid = pid;
        await atomic(pendingPath(o), JSON.stringify(pending) + "\n");
      },
      onSettled: async (success) => atomic(receiptPath(o, pending.id), JSON.stringify({ success }) + "\n"),
    });
  } catch (error) {
    const result = await reconcileAssistantAddress(o);
    const cancelled = /abgebrochen|cancel(?:ed|led)|-128/i.test((error as Error).message);
    if (result === "none")
      throw new Error(
        cancelled
          ? w.setupCancelled
          : pending.helperLoadedBefore === false && helperBefore !== null
            ? w.setupFailedHelperUnloaded
            : w.setupFailed
      );
    if (result === "partial")
      throw new Error(cancelled ? w.setupCancelledPartial : w.setupPartial(await partialDescription(o), name));
    if (result === "completed") return { browserOpened: false, warning: w.adminAnswerMissing };
    throw new Error(w.setupUnconfirmed);
  }
  try {
    await requireFirefoxClosed(o, profiles);
    await applyProfiles(profiles);
    await setAssistantName(name, o.settingsPath);
    await atomic(join(o.runtimeDir, "state.json"), JSON.stringify(pending.desiredState) + "\n");
  } catch (error) {
    let rollbackError = false;
    try {
      await restoreProfiles(profiles);
    } catch {
      rollbackError = true;
    }
    try {
      await (o.runAdmin ?? runMacAddressAdmin)({
        ...plan,
        hostsBefore: hostsAfter,
        hostsAfter: hostsBefore,
        helperBefore: helperAfter,
        helperAfter: helperBefore,
        companion: { ...companion, before: companion.after, after: companion.before },
      });
    } catch {
      rollbackError = true;
    }
    try {
      if ((await getAssistantName(o.settingsPath)) === name) await setAssistantName(previousName, o.settingsPath);
    } catch {
      rollbackError = true;
    }
    if (rollbackError) throw new Error(w.rollbackUnconfirmed);
    await discardAttempt(o, pending);
    throw error;
  }
  await finishIntent(o, pending);
  let browserOpened = false;
  if (o.openBrowser) {
    try {
      await o.openBrowser(`http://${name}/`);
      browserOpened = true;
    } catch {
      /* address remains valid; user can follow the displayed link */
    }
  }
  return { browserOpened };
}
async function cleanupAddressRuntime(o: ReturnType<typeof assistantAddressOptions>) {
  if ((await optional(join(o.runtimeDir, "managed"))) === `bastra-assistant-address:${o.uid}\n`)
    await rm(o.runtimeDir, { recursive: true, force: true });
  else await rm(join(o.runtimeDir, "state.json"), { force: true });
}
async function removeAssistantAddressUnlocked(options: AssistantAddressOptions = {}): Promise<void> {
  const o = assistantAddressOptions(options),
    w = addressWords(o.language),
    hostsBefore = (await optional(o.hostsPath)) ?? "",
    helperBefore = await optional(o.helperPath),
    profiles = await profileEdits(o, null);
  await requireFirefoxClosed(o, profiles);
  const companionBefore = await ownCompanion(o);
  const hostsAfter = patchAssistantHosts(hostsBefore, null, o.uid),
    ownedHelper = helperBefore?.includes(`<key>BASTRA_ASSISTANT_ADDRESS_OWNER</key><string>${o.uid}</string>`) ?? false;
  let pending: PendingAddress | undefined;
  if (hostsAfter !== hostsBefore || ownedHelper || companionBefore !== null) {
    if (!o.systemConsent) throw new AssistantAddressError("system_consent_required", w.removeNeedsConsent);
    if (o.platform !== "darwin") throw new Error(w.removeByAdministrator);
    const plan: AddressAdminPlan = {
      hostsPath: o.hostsPath,
      hostsBefore,
      hostsAfter,
      helperPath: o.helperPath,
      helperBefore,
      helperAfter: ownedHelper ? null : helperBefore,
      ...(companionBefore !== null
        ? {
            companion: {
              path: companionPath(o),
              before: companionBefore,
              after: null,
              label: `ai.n0mad.bastra-recall.address.${o.uid}.ipv6`,
            },
          }
        : {}),
      label: `ai.n0mad.bastra-recall.address.${o.uid}`,
    };
    pending = {
      createdAt: Date.now(),
      ownerPid: process.pid,
      recoveryOf: await captureRecovery(o),
      helperLoadedBefore: helperBefore === null ? false : await assistantHelperLoaded(o),
      id: randomUUID(),
      plan,
      name: null,
      previousName: await getAssistantName(o.settingsPath),
      profiles,
      desiredState: null,
    };
    await replacePending(o, pending);
    const id = pending.id;
    try {
      await (o.runAdmin ?? runMacAddressAdmin)({
        ...plan,
        language: o.language,
        onStarted: async (pid) => {
          pending!.adminPid = pid;
          await atomic(pendingPath(o), JSON.stringify(pending) + "\n");
        },
        onSettled: async (success) => atomic(receiptPath(o, id), JSON.stringify({ success }) + "\n"),
      });
    } catch {
      const result = await reconcileAssistantAddress(o);
      if (result === "completed") return;
      if (result === "partial") throw new Error(w.removePartial(await partialDescription(o)));
      if (result === "none") throw new Error(w.removeFailed);
      throw new Error(w.removeUnconfirmed);
    }
  }
  await applyProfiles(profiles);
  await setAssistantName(null, o.settingsPath);
  if (pending) await finishIntent(o, pending);
  else {
    const raw = await optional(pendingPath(o));
    if (raw) {
      const old = JSON.parse(raw) as PendingAddress;
      validatePending(o, old);
      await finishIntent(o, { ...old, name: null });
    }
  }
  await cleanupAddressRuntime(o);
}
/** Whether this user's address listener answers for `name`: undefined when there is nothing to probe
 * (no name or the UI is off), null when a probe is due but no port was given (#1653: only an explicit
 * port is asked, never a silently assumed 80 that may belong to another local service). */
async function probeListener(name: string | null, enabled: boolean, port: number | undefined) {
  if (!name || !enabled) return undefined;
  if (port === undefined) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/.well-known/bastra-assistant-address`, {
      headers: { Host: `${name}.localhost:${port}` },
      signal: AbortSignal.timeout(800),
    });
    const b = (await r.json()) as any;
    return r.ok && b.service === "bastra-assistant-address" && b.name === name;
  } catch {
    return false;
  }
}
async function assistantAddressStatusUnlocked(options: AssistantAddressOptions = {}) {
  const o = assistantAddressOptions(options),
    w = addressWords(o.language),
    name = await getAssistantName(o.settingsPath),
    enabled = (await readSettings(o.settingsPath)).ui?.enabled ?? SETTINGS_REGISTRY.ui.enabled.default;
  let registered: string | null = null,
    error: string | undefined;
  try {
    registered = managedAssistantHostsName((await optional(o.hostsPath)) ?? "", o.uid);
  } catch (e) {
    error = (e as Error).message;
  }
  const probed = await probeListener(name, enabled, o.gatewayPort);
  let listener = probed === true;
  const helper = await ownHelper(o),
    helperLoaded = helper ? await assistantHelperLoaded(o) : null;
  const companion = await ownCompanion(o),
    processBound = !!(
      helperLoaded === true &&
      helper &&
      companion &&
      helper.includes("<key>Wait</key><true/>") &&
      companion.includes("<key>Wait</key><true/>")
    );
  if (helper && helperLoaded === false) listener = false;
  // An unchecked listener proves nothing: only a helper known to be unloaded is still a problem then.
  const listenerKnown = probed !== null || helperLoaded === false;
  const helperProblem = helper && !listener && !error && (helperLoaded !== true || enabled) && listenerKnown;
  if (helperProblem)
    error = helperLoaded === false ? w.helperNotLoaded : helperLoaded === true ? w.helperUnreachable : w.helperUnknown;
  const repair = error ? w.hostsRepairStatus(name ?? "<name>") : undefined;
  const helperRepair = helperProblem ? w.helperRepair(name ?? "<name>", o.daemonUrl) : undefined;
  return {
    repair: helperRepair ?? repair,
    helperLoaded,
    processBound,
    processBoundUpgrade: helper && !processBound ? `bastra address setup ${name ?? "<name>"} --yes` : undefined,
    name,
    enabled,
    urls: name ? assistantUrls(name) : null,
    registeredName: registered,
    ready: listener,
    listenerChecked: typeof probed === "boolean",
    error,
    systemSetupSupported: o.platform === "darwin",
    firefoxProfiles: (await profileEdits(o, null)).filter((p) => p.path.endsWith(sep + "user.js")).length,
    bareNameNotice: w.bareNameNotice,
  };
}

export async function openAssistantAddress(url: string): Promise<void> {
  if (process.platform !== "darwin") return;
  await new Promise<void>((resolve, reject) => {
    const c = spawn("/usr/bin/open", [url], { stdio: "ignore" });
    c.once("error", reject);
    c.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("Browser konnte nicht geöffnet werden"))));
  });
}
export async function hasManagedAssistantAddress(options: AssistantAddressOptions = {}): Promise<boolean> {
  const o = assistantAddressOptions(options);
  if ((await getAssistantName(o.settingsPath)) || (await state(o))) return true;
  const hosts = (await optional(o.hostsPath)) ?? "";
  if (managedAssistantHostsName(hosts, o.uid)) return true;
  return (
    !!(await ownCompanion(o)) ||
    ((await optional(o.helperPath))?.includes(`<key>BASTRA_ASSISTANT_ADDRESS_OWNER</key><string>${o.uid}</string>`) ??
      false)
  );
}
export async function addressRemovalNeedsConsent(options: AssistantAddressOptions = {}): Promise<boolean> {
  const o = assistantAddressOptions(options);
  if (managedAssistantHostsName((await optional(o.hostsPath)) ?? "", o.uid)) return true;
  return (
    !!(await ownCompanion(o)) ||
    ((await optional(o.helperPath))?.includes(`<key>BASTRA_ASSISTANT_ADDRESS_OWNER</key><string>${o.uid}</string>`) ??
      false)
  );
}
export async function notifyAssistantAddressDaemon(): Promise<void> {
  const base = resolveDaemonEndpoint().baseUrl;
  const u = new URL(base);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return;
  try {
    await fetch(`${base}/ui/assistant-address/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    /* saved configuration takes effect when daemon starts */
  }
}

// A separate strict lock serializes UI/CLI lifecycles, including long admin prompts,
// without holding the settings-file lock or displacing a living process.
async function addressOperation<T>(
  options: AssistantAddressOptions,
  operation: (recovering: boolean) => Promise<T>,
  allowPending = false,
  kind?: "remove"
): Promise<T> {
  const o = assistantAddressOptions(options),
    path = o.settingsPath + ".assistant-address-operation";
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return withPathLock(
    path,
    async (assertOwnership) => {
      assertOwnership();
      if (o.adminStagingRoot || !o.runAdmin) await cleanupMacAddressAdminStaging(o.adminStagingRoot);
      let recovering = false;
      let result: "none" | "completed" | "pending" | "partial";
      try {
        result = await reconcileAssistantAddress(o);
      } catch (error) {
        if (!allowPending && o.systemConsent && error instanceof AddressSettingsConflictError && error.settled) {
          recovering = true;
          result = "partial";
        } else throw error;
      }
      if (result === "pending" && !allowPending)
        throw new AddressPendingError("address_pending", addressWords(o.language).pendingSetup);
      if (result === "partial" && !allowPending) {
        if (!o.systemConsent && !(kind === "remove" && !(await addressRemovalNeedsConsent(o))))
          throw new AddressPendingError("partial_needs_consent", addressWords(o.language).partialNeedsConsent);
        recovering = true; // keep the original marker until a replacement transaction succeeds
      }
      const value = await operation(recovering);
      assertOwnership();
      return value;
    },
    { strictLocal: true, noQueue: allowPending }
  );
}
export async function changeAssistantName(value: string, options: AssistantAddressOptions = {}): Promise<void> {
  const o = await withAddressLanguage(options);
  return addressOperation(o, (recovering) => changeAssistantNameUnlocked(value, o, recovering));
}
export async function setupAssistantAddress(options: AssistantAddressOptions & { name?: string } = {}) {
  const o = await withAddressLanguage(options);
  return addressOperation(o, () => setupAssistantAddressUnlocked(o));
}
export async function removeAssistantAddress(options: AssistantAddressOptions = {}): Promise<void> {
  const o = await withAddressLanguage(options);
  return addressOperation(o, () => removeAssistantAddressUnlocked(o), false, "remove");
}

function addressRepair(
  o: ReturnType<typeof assistantAddressOptions>,
  name: string | null,
  error: string,
  cause?: unknown,
  kind?: "hosts" | "partial"
) {
  const command = `bastra address setup ${name ?? "<name>"} --yes`,
    w = addressWords(o.language);
  if (cause instanceof PathLockUnavailableError || cause instanceof AddressPendingError) return w.repairBusy;
  if (cause instanceof AddressSettingsConflictError)
    return cause.settled ? w.repairSettingsSettled(command) : w.repairSettingsChanged;

  if (/Firefox/i.test(error)) return w.repairFirefox(command);
  if (cause instanceof SyntaxError || cause instanceof AddressIntentError)
    return w.repairIntent(`mv ${shellQuote(pendingPath(o))} ${shellQuote(pendingPath(o) + ".backup")}`, command);
  if (kind === "hosts") return w.repairHosts(command);
  if (kind === "partial") return w.repairPartial(command);
  return w.repairDefault(command);
}
export async function assistantAddressStatus(options: AssistantAddressOptions = {}) {
  const o = assistantAddressOptions(await withAddressLanguage(options)),
    w = addressWords(o.language);
  try {
    return await addressOperation(
      o,
      async () => {
        const s = await assistantAddressStatusUnlocked(o),
          pending = !!(await optional(pendingPath(o)));
        const partial = pending && (await reconcileAssistantAddress(o)) === "partial";
        const error = partial ? w.partialState(await partialDescription(o)) : s.error;
        const raw = pending ? await optional(pendingPath(o)) : null;
        const pidUnknown = raw && addressAdminProcessAlive((JSON.parse(raw) as PendingAddress).adminPid) === null;
        let repair = error
          ? partial
            ? addressRepair(o, s.name, error, undefined, "partial")
            : (s.repair ?? addressRepair(o, s.name, error, undefined, "hosts"))
          : pending
            ? w.adminPending(s.name ?? "<name>")
            : s.repair;
        if (pending && !partial && pidUnknown)
          repair = w.adminPidUnsecured + (error ? w.afterClarified(String(repair)) : "");
        return { ...s, pending, partial, error, repair };
      },
      true
    );
  } catch (e) {
    // Doctor must still return useful diagnostics when recovery itself is damaged/blocked.
    const name = await getAssistantName(o.settingsPath).catch(() => null),
      error = (e as Error).message;
    return {
      processBound: false,
      processBoundUpgrade: undefined,
      name,
      enabled: false,
      urls: name ? assistantUrls(name) : null,
      registeredName: null,
      ready: false,
      listenerChecked: false,
      error,
      pending: true,
      partial: false,
      systemSetupSupported: o.platform === "darwin",
      firefoxProfiles: 0,
      bareNameNotice: "",
      repair: addressRepair(o, name, error, e),
    };
  }
}
