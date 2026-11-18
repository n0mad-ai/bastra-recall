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
  constructor(readonly settled: boolean) {
    super("settings_conflict", "Einstellung während Systemfreigabe geändert.");
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
      throw new AddressIntentError("Adress-Abgleich beschädigt; keine Systemänderung wiederholen.");
  } catch {
    throw new AddressIntentError("Adress-Abgleich beschädigt; keine Systemänderung wiederholen.");
  }
}
async function captureRecovery(o: ReturnType<typeof assistantAddressOptions>) {
  const raw = await optional(pendingPath(o));
  if (!raw) return undefined;
  const p = JSON.parse(raw) as PendingAddress;
  validatePending(o, p);
  if (p.recoveryOf) {
    validatePending(o, p.recoveryOf.intent);
    if (p.recoveryOf.intent.recoveryOf)
      throw new AddressIntentError("Verschachtelter Wiederherstellungsauftrag beschädigt.");
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
  if (origin.intent.recoveryOf) throw new AddressIntentError("Verschachtelter Wiederherstellungsauftrag beschädigt.");
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
  const loaded = await assistantHelperLoaded(o);
  if (loaded === false)
    return "Helfer derzeit nicht geladen; Dateien oder lokaler Zustand noch nicht vollständig abgeglichen.";
  if (loaded === true)
    return "Helfer derzeit geladen; Dateien oder lokaler Zustand noch nicht vollständig abgeglichen.";
  return "Aktueller Dienstzustand unbekannt; Dateien oder lokaler Zustand noch nicht vollständig abgeglichen.";
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
    if (current !== p.previousName && current !== p.name) throw new AddressSettingsConflictError(settled);
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
    name = requireAssistantAddress(value, machineNames(o)),
    before = await getAssistantName(o.settingsPath);
  patchAssistantHosts((await optional(o.hostsPath)) ?? "", name, o.uid); // check conflicts before saving
  if (recovering || (before !== name && (await hasSystem(o)))) {
    if (!o.systemConsent)
      throw new AssistantAddressError(
        "system_consent_required",
        "Systemänderung braucht Zustimmung (system consent); bastra address setup <name> --yes"
      );
    await setupAssistantAddressUnlocked({ ...o, name } as AssistantAddressOptions & { name: string });
    return;
  }
  await setAssistantName(name, o.settingsPath);
}
async function setupAssistantAddressUnlocked(options: AssistantAddressOptions & { name?: string } = {}) {
  const o = assistantAddressOptions(options),
    name =
      options.name === undefined
        ? normalizeAssistantName((await getAssistantName(o.settingsPath)) ?? "", machineNames(o))
        : requireAssistantAddress(options.name, machineNames(o));
  if (!o.systemConsent)
    throw new AssistantAddressError(
      "system_consent_required",
      "Systemeinrichtung braucht ausdrückliche Zustimmung (system consent)"
    );
  if (o.platform !== "darwin")
    throw new Error(
      "Automatische Systemeinrichtung ist nur auf macOS verfügbar; hosts/Port-80-Freigabe unter Windows/Linux durch den Administrator einrichten."
    );
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
          ? "Systemeinrichtung abgebrochen, nichts geändert."
          : pending.helperLoadedBefore === false && helperBefore !== null
            ? "Einrichtung fehlgeschlagen; Helfer war bereits entladen und ist weiterhin nicht geladen. Dateien unverändert."
            : "Systemeinrichtung fehlgeschlagen, nichts geändert."
      );
    if (result === "partial")
      throw new Error(
        cancelled
          ? "Systemeinrichtung abgebrochen; bestehender Teilzustand bleibt erhalten."
          : `Einrichtung nur teilweise ausgeführt: ${await partialDescription(o)} bastra address setup ${name} --yes stellt die Adresse wieder her; bastra address remove --yes setzt das Entfernen fort.`
      );
    if (result === "completed")
      return {
        browserOpened: false,
        warning: "Admin-Rückmeldung fehlte; tatsächliche Systemeinrichtung geprüft und übernommen.",
      };
    throw new Error(
      "Systemeinrichtung nicht abschließend bestätigt, möglicherweise noch ausstehend. bastra address status prüft den tatsächlichen Zustand; Einrichtung nicht parallel wiederholen."
    );
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
    if (rollbackError)
      throw new Error(
        "Einrichtung fehlgeschlagen; Rücknahme nicht vollständig bestätigt. bastra address status prüfen."
      );
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
    hostsBefore = (await optional(o.hostsPath)) ?? "",
    helperBefore = await optional(o.helperPath),
    profiles = await profileEdits(o, null);
  await requireFirefoxClosed(o, profiles);
  const companionBefore = await ownCompanion(o);
  const hostsAfter = patchAssistantHosts(hostsBefore, null, o.uid),
    ownedHelper = helperBefore?.includes(`<key>BASTRA_ASSISTANT_ADDRESS_OWNER</key><string>${o.uid}</string>`) ?? false;
  let pending: PendingAddress | undefined;
  if (hostsAfter !== hostsBefore || ownedHelper || companionBefore !== null) {
    if (!o.systemConsent)
      throw new AssistantAddressError(
        "system_consent_required",
        "Entfernen der Systemadresse braucht Zustimmung (system consent)"
      );
    if (o.platform !== "darwin") throw new Error("Systemadresse durch den Administrator entfernen");
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
        onStarted: async (pid) => {
          pending!.adminPid = pid;
          await atomic(pendingPath(o), JSON.stringify(pending) + "\n");
        },
        onSettled: async (success) => atomic(receiptPath(o, id), JSON.stringify({ success }) + "\n"),
      });
    } catch {
      const result = await reconcileAssistantAddress(o);
      if (result === "completed") return;
      if (result === "partial")
        throw new Error(
          `Entfernen nur teilweise ausgeführt: ${await partialDescription(o)} bastra address setup <name> --yes stellt die Adresse wieder her.`
        );
      if (result === "none") throw new Error("Entfernen abgebrochen oder fehlgeschlagen, nichts geändert.");
      throw new Error(
        "Entfernen nicht abschließend bestätigt; bastra address status prüft den tatsächlichen Zustand. Nicht parallel wiederholen."
      );
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
async function assistantAddressStatusUnlocked(options: AssistantAddressOptions = {}) {
  const o = assistantAddressOptions(options),
    name = await getAssistantName(o.settingsPath),
    enabled = (await readSettings(o.settingsPath)).ui?.enabled ?? SETTINGS_REGISTRY.ui.enabled.default;
  let registered: string | null = null,
    error: string | undefined;
  try {
    registered = managedAssistantHostsName((await optional(o.hostsPath)) ?? "", o.uid);
  } catch (e) {
    error = (e as Error).message;
  }
  let listener = false;
  if (name && enabled) {
    try {
      const r = await fetch(`http://127.0.0.1:${o.gatewayPort ?? 80}/.well-known/bastra-assistant-address`, {
        headers: { Host: `${name}.localhost:${o.gatewayPort ?? 80}` },
        signal: AbortSignal.timeout(800),
      });
      const b = (await r.json()) as any;
      listener = r.ok && b.service === "bastra-assistant-address" && b.name === name;
    } catch {}
  }
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
  const helperProblem = helper && !listener && !error && (helperLoaded !== true || enabled);
  if (helperProblem)
    error =
      helperLoaded === false
        ? "Adress-Helfer eingerichtet, aber nicht geladen."
        : helperLoaded === true
          ? "Adress-Helfer geladen, aber Adresse nicht erreichbar; Laufzeit prüfen."
          : "Adress-Helfer eingerichtet; Ladezustand unbekannt und Adresse nicht erreichbar.";
  const repair = error
    ? `hosts zuerst sichern (Backup). Den veränderten Block zwischen den eigenen bastra-recall assistant-address-Markierungen prüfen; eigene Anpassungen außerhalb des Blocks bewahren. Nur den vollständigen eigenen Block als Administrator entfernen, dann bastra address setup ${name ?? "<name>"} --yes erneut ausführen. Keine fremden Zeilen löschen.`
    : undefined;
  const helperRepair = helperProblem
    ? `Adress-Helfer mit bastra address setup ${name ?? "<name>"} --yes prüfen und erneut laden. Direkter UI-Zugang: ${o.daemonUrl}/ui/.`
    : undefined;
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
    error,
    systemSetupSupported: o.platform === "darwin",
    firefoxProfiles: (await profileEdits(o, null)).filter((p) => p.path.endsWith(sep + "user.js")).length,
    bareNameNotice:
      "Einzelne Wörter können je nach Browser als Suche gelten. Adresse einmal öffnen; Firefox nach Einrichtung neu starten. <name>/ oder <name>.localhost bleibt die eindeutige Eingabe.",
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
        throw new AddressPendingError(
          "address_pending",
          "Systemeinrichtung noch ausstehend; laufenden Dialog abwarten und bastra address status erneut prüfen."
        );
      if (result === "partial" && !allowPending) {
        if (!o.systemConsent && !(kind === "remove" && !(await addressRemovalNeedsConsent(o))))
          throw new AddressPendingError(
            "partial_needs_consent",
            "Abgeschlossener Teilzustand: Wiederherstellen oder Entfernen braucht ausdrückliche Systemfreigabe."
          );
        recovering = true; // keep the original marker until a replacement transaction succeeds
      }
      const value = await operation(recovering);
      assertOwnership();
      return value;
    },
    { strictLocal: true, noQueue: allowPending }
  );
}
export function changeAssistantName(value: string, options: AssistantAddressOptions = {}): Promise<void> {
  return addressOperation(options, (recovering) => changeAssistantNameUnlocked(value, options, recovering));
}
export function setupAssistantAddress(options: AssistantAddressOptions & { name?: string } = {}) {
  return addressOperation(options, () => setupAssistantAddressUnlocked(options));
}
export function removeAssistantAddress(options: AssistantAddressOptions = {}): Promise<void> {
  return addressOperation(options, () => removeAssistantAddressUnlocked(options), false, "remove");
}

function addressRepair(
  o: ReturnType<typeof assistantAddressOptions>,
  name: string | null,
  error: string,
  cause?: unknown,
  kind?: "hosts" | "partial"
) {
  const command = `bastra address setup ${name ?? "<name>"} --yes`;
  if (cause instanceof PathLockUnavailableError || cause instanceof AddressPendingError)
    return `Laufenden Vorgang zuerst beenden oder warten. Danach bastra address status erneut ausführen; keine hosts-Einträge ändern.`;
  if (cause instanceof AddressSettingsConflictError)
    return cause.settled
      ? `Einstellung/Namen prüfen: bastra config get assistant.name. Danach den gewünschten Namen ausdrücklich mit ${command} bestätigen.`
      : `Einstellung wurde geändert. Laufende Systemfreigabe erst abwarten; danach bastra address status erneut ausführen und den Namen prüfen.`;

  if (/Firefox/i.test(error)) return `Firefox vollständig schließen; dann ${command} ausführen.`;
  if (cause instanceof SyntaxError || cause instanceof AddressIntentError)
    return `Zuerst einen noch laufenden Admin-Dialog beenden und dessen Abschluss prüfen. Beschädigten Auftrag sichern: mv ${shellQuote(pendingPath(o))} ${shellQuote(pendingPath(o) + ".backup")}. Danach ${command} ausführen. hosts vorher sichern; keine fremden Einträge löschen.`;
  if (kind === "hosts")
    return `hosts zuerst sichern. Veränderten eigenen bastra-recall assistant-address-Block prüfen und nur diesen als Administrator entfernen; fremde Anpassungen bewahren. Dann ${command} ausführen.`;
  if (kind === "partial")
    return `Abgeschlossenen Teilzustand mit ${command} wiederherstellen oder mit bastra address remove --yes fortsetzen. Keine hosts-Einträge manuell löschen.`;
  return `Fehlerursache prüfen und bastra address status erneut ausführen. Nach bestätigtem Abschluss kann ${command} die Adresse wiederherstellen; keine hosts-Einträge löschen.`;
}
export async function assistantAddressStatus(options: AssistantAddressOptions = {}) {
  const o = assistantAddressOptions(options);
  try {
    return await addressOperation(
      o,
      async () => {
        const s = await assistantAddressStatusUnlocked(o),
          pending = !!(await optional(pendingPath(o)));
        const partial = pending && (await reconcileAssistantAddress(o)) === "partial";
        const error = partial ? `Teilzustand: ${await partialDescription(o)}` : s.error;
        const raw = pending ? await optional(pendingPath(o)) : null;
        const pidUnknown = raw && addressAdminProcessAlive((JSON.parse(raw) as PendingAddress).adminPid) === null;
        let repair = error
          ? partial
            ? addressRepair(o, s.name, error, undefined, "partial")
            : (s.repair ?? addressRepair(o, s.name, error, undefined, "hosts"))
          : pending
            ? `Admin-Einrichtung noch ausstehend. Laufenden Dialog zuerst beenden; bastra address status erneut prüfen. Erst nach bestätigtem Abschluss bastra address setup ${s.name ?? "<name>"} --yes ausführen.`
            : s.repair;
        if (pending && !partial && pidUnknown)
          repair =
            "Admin-PID nicht gesichert; laufenden Dialog und tatsächlichen Abschluss zuerst prüfen. Automatische Freigabe ist ohne Prozessnachweis gesperrt; bastra address status erneut ausführen." +
            (error ? ` Nach geklärtem Abschluss: ${repair}` : "");
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
