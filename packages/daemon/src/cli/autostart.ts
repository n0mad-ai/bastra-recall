/**
 * `bastra autostart` — der Schalter für den Dauerbetrieb, und der erste
 * Besitzer des LaunchAgent-plists.
 *
 * WARUM DAS HIER STEHT. Der Daemon kam bisher auf drei Wegen hoch: über den
 * Autospawn des MCP-Forwarders (der Normalfall, mit Idle-Shutdown nach 30
 * Minuten), von Hand — oder über einen LaunchAgent, den der Nutzer sich SELBST
 * geschrieben hat. Für den dritten Weg gab es im ganzen Repo keinen Schreiber;
 * `daemon-start.ts` sagt das wörtlich: „no install path registers one". Es gab
 * nur Stellen, die einen vorhandenen lesen, kickstarten oder beim
 * Deinstallieren entfernen.
 *
 * Und was nie geschrieben wurde, kann bei einem Update auch niemand pflegen.
 * Genau das war der gemeldete Fall: nach einem `brew upgrade` blieb der plist
 * stehen wie er war, der Daemon lief mit dem alten Code weiter, und nichts
 * sagte es. Ein Autostart, den bastra selbst schreibt, ist deshalb kein
 * Komfort-Feature — er ist die Voraussetzung dafür, dass `bastra update` ihn
 * auf die neue Installation ziehen und `bastra doctor` einen veralteten
 * erkennen kann.
 *
 * ENTSCHEIDUNG (Daniel, 27.08.2026): Der Daemon läuft NICHT dauerhaft per
 * Default. Der Autospawn bleibt der Standardweg; Dauerbetrieb ist opt-in.
 *
 * AUSDRÜCKLICH NICHT GEWÄHLT: ein `service do`-Block in der Homebrew-Formel.
 * Homebrew vergibt zwangsweise das Label `homebrew.mxcl.bastra-recall`, während
 * der Code hier und in `index.ts`/`update.ts` auf `ai.n0mad.bastra-recall`
 * prüft — es gäbe zwei Autostart-Welten, und beide wollen Port 6723, den es
 * nur einmal gibt.
 *
 * FREMDE plists WERDEN NICHT ANGEFASST. Wer sich seinen LaunchAgent selbst
 * gebaut hat, hat dafür Gründe — er zeigt zum Beispiel auf einen
 * Entwicklungs-Checkout statt auf die Installation, oder er trägt eine
 * Modell-Konfiguration, die dieser Code nicht kennt. `on` würde ihn
 * überschreiben und damit beim ersten Ausprobieren eine fremde Umgebung
 * abschießen. Erkannt wird er über eine Marke IM plist
 * ({@link MANAGED_MARKER}); ohne sie ist er fremd, und dann bricht der Befehl
 * ab und nennt `--force`.
 */
import { windowsService, type AutostartService } from "./windows-service.js";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { tasksEnabled, TASKS_DEFAULT } from "../tasks-enabled.js";
import { runtimeFeatureSetting } from "../runtime-feature-settings.js";
import {
  cleanManagedEnv,
  safeLaunchAgentSnapshot,
  legacySnapshotWarning,
  launchAgentBackupWarning,
} from "./autostart-env.js";
import { randomUUID } from "node:crypto";
import { DAEMON_SCRIPT_PATH } from "./paths.js";
import { probeDaemon, resolveVault } from "./helpers.js";
import { endpointToPersist, portOfEndpoint, resolveDaemonEndpoint } from "../daemon-endpoint.js";
import type { ParsedArgs } from "./types.js";
import { isOnValue } from "../env.js";
import { autostartWordsIn, type AutostartWords } from "./autostart-words.js";
import { taskCliLanguage } from "./task-cli-words.js";
import {
  LAUNCH_AGENT_LABEL,
  MANAGED_AUTOSTART_MARKER as MANAGED_MARKER,
  managedAutostartPlistPath as plistPath,
} from "../autostart-service.js";

/** Dasselbe Label, das `index.ts` und `update.ts` kennen. Ein zweites wäre ein
 *  zweiter Daemon auf demselben Port. */
export { LAUNCH_AGENT_LABEL, plistPath };

/**
 * Die Marke, an der bastra seinen EIGENEN plist wiedererkennt.
 *
 * Bewusst eine Umgebungsvariable und kein zusätzlicher Top-Level-Key: launchd
 * ist bei unbekannten Keys auf oberster Ebene je nach Version wählerisch, und
 * die Variable ist nebenbei nützlich — der Daemon weiß damit, dass er als
 * Autostart läuft und nicht als Autospawn.
 */

/** launchd's CLI. Absolute on purpose — never resolved through PATH. The
 *  parameter that carries it exists so the #435/#441 regressions can run
 *  against a stub instead of the machine's own launchd. */
const LAUNCHCTL = "/bin/launchctl";

/** The plist reader. Same rule as LAUNCHCTL: absolute, and the parameter that
 *  carries it exists so those regressions also run on a runner without one
 *  (#940 — CI is Linux, where there is no plutil). */
const PLUTIL = "/usr/bin/plutil";

export interface AutostartState {
  path: string;
  exists: boolean;
  /** Von bastra geschrieben? Nur dann darf dieser Code ihn anfassen. */
  managed: boolean;
  /** Was der plist startet — `[node, script]`. Leer, wenn unlesbar. */
  program: string[];
  /** Ist der Agent bei launchd geladen? */
  loaded: boolean;
  /** Environment currently loaded by launchd, distinct from the plist on disk. */
  loadedEnv?: Record<string, string>;
  /** Der erste Pfad aus `program`, den es nicht mehr gibt — das node-Binary
   *  ODER das Skript. `null`, wenn beide liegen, wo sie sollen. */
  missingProgramPath: string | null;
  /** Der plist ist da, aber sein Programm liegt nicht mehr auf der Platte —
   *  der klassische Zustand nach einem Update, das den Pfad verschoben hat. */
  danglingProgram: boolean;
  /**
   * Der Endpunkt, den DIESER plist festschreibt (#531) — `null`, wenn keiner
   * darinsteht. Er ist der Grund, warum ein gewählter Port ein Update
   * überlebt: `bastra update` läuft in einer Shell ohne den Export, und ohne
   * diesen Wert würde jedes Neuschreiben den Daemon auf 6723 zurückwerfen.
   */
  endpoint: string | null;
  /** #719: the plist's EnvironmentVariables (string values) — what a daemon
   *  this agent starts runs with. Empty when there is none or it is unreadable. */
  env: Record<string, string>;
}

/**
 * Den plist lesen — über `plutil`, nicht über einen eigenen XML-Parser.
 *
 * Ein handgeschriebener plist darf jede erlaubte Form haben (Reihenfolge der
 * Keys, Kommentare, binäres Format). Ein Reguläre-Ausdrücke-Parser hätte davon
 * genau die Fälle falsch gelesen, in denen es darauf ankommt — und ein falsch
 * gelesener fremder plist ist genau der, den dieser Code nicht überschreiben
 * soll. `plutil` liegt auf jedem Mac.
 */
export async function readState(path = plistPath(), launchctl = LAUNCHCTL, plutil = PLUTIL): Promise<AutostartState> {
  const launchd = launchAgentState(launchctl);
  const state: AutostartState = {
    path,
    exists: existsSync(path),
    managed: false,
    program: [],
    loaded: launchd.loaded,
    loadedEnv: launchd.env,
    missingProgramPath: null,
    danglingProgram: false,
    endpoint: null,
    env: {},
  };
  if (!state.exists) return state;
  const conv = spawnSync(plutil, ["-convert", "json", "-o", "-", path], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (conv.status !== 0) return state;
  try {
    const parsed = JSON.parse(conv.stdout) as {
      ProgramArguments?: unknown;
      EnvironmentVariables?: Record<string, unknown>;
    };
    state.program = Array.isArray(parsed.ProgramArguments)
      ? parsed.ProgramArguments.filter((a): a is string => typeof a === "string")
      : [];
    const marker = parsed.EnvironmentVariables?.[MANAGED_MARKER];
    state.managed = typeof marker === "string" && isOnValue(marker);
    const url = parsed.EnvironmentVariables?.BASTRA_DAEMON_URL;
    state.endpoint = typeof url === "string" && url.trim() !== "" ? url.trim() : null;
    for (const [k, v] of Object.entries(parsed.EnvironmentVariables ?? {})) {
      if (typeof v === "string") state.env[k] = v;
    }
  } catch {
    // Unparsebar heißt FREMD, nicht „gehört uns" — dieselbe fail-closed-Regel
    // wie im Vault-Schreibpfad. Ein Fehler beim Lesen darf nie zu einem
    // Überschreiben führen.
    return state;
  }
  // `node <script>` — BEIDE Pfade sind absolut, und beide können nach einem
  // Update ins Leere zeigen. Das Skript zieht mit der bastra-Installation um
  // (#435); das Binary zieht mit node um, sobald Homebrew node aktualisiert und
  // das alte Keg aufräumt. Für launchd ist der Unterschied keiner: der Agent
  // startet nicht, und niemand sagt es. Also beide prüfen, und den ersten
  // fehlenden benennen.
  state.missingProgramPath = state.program.slice(0, 2).find((p) => p !== undefined && !existsSync(p)) ?? null;
  state.danglingProgram = state.missingProgramPath !== null;
  return state;
}

function launchAgentState(launchctl = LAUNCHCTL): { loaded: boolean; env?: Record<string, string> } {
  const uid = String(process.getuid?.() ?? 0);
  const r = spawnSync(launchctl, ["print", `gui/${uid}/${LAUNCH_AGENT_LABEL}`], {
    encoding: "utf8",
    timeout: 15_000,
  });
  const block = /(?:^|\n)[ \t]*environment = \{\n([\s\S]*?)\n[ \t]*\}/.exec(r.stdout ?? "");
  const env = block
    ? Object.fromEntries(
        [...block[1].matchAll(/^\s*(BASTRA_[A-Z0-9_]+)\s*=>[ \t]*(.*?)[ \t]*$/gm)].map((m) => [m[1], m[2]])
      )
    : undefined;
  return { loaded: r.status === 0, env };
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderPlist(env: Record<string, string>, program: string[]): string {
  const entries = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(v)}</string>`)
    .join("\n");
  const args = program.map((a) => `\t\t<string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xml(LAUNCH_AGENT_LABEL)}</string>
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${entries}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ProcessType</key>
\t<string>Interactive</string>
\t<key>StandardOutPath</key>
\t<string>/tmp/bastra-daemon.out</string>
\t<key>StandardErrorPath</key>
\t<string>/tmp/bastra-daemon.err</string>
</dict>
</plist>
`;
}

/**
 * Das node-Binary, das in den plist gehört — #435, zweiter Teil.
 *
 * Dieselbe Fehlerform wie beim Daemon-Skript, nur eine Ebene tiefer.
 * `process.execPath` ist unter Homebrew typischerweise ein versionsgebundener
 * Keg-Pfad (`/opt/homebrew/Cellar/node/<version>/bin/node`). Wird node
 * aktualisiert und das alte Keg aufgeräumt, nennt der verwaltete LaunchAgent
 * ein Binary, das es nicht mehr gibt — der Autostart ist tot, ohne dass jemand
 * bastra angefasst hat.
 *
 * Homebrew pflegt für genau diesen Zweck einen stabilen Symlink neben dem Keg
 * (`<prefix>/opt/<formel>/bin/node`, plus den Shim in `<prefix>/bin`). Der
 * Prefix wird aus dem Keg-Pfad selbst abgeleitet — der Paketmanager hat ihn
 * gebaut, er ist die verlässlichste Quelle, und es kostet keinen Unterprozess.
 *
 * BEWUSST NICHT PAUSCHAL: Wo es keinen stabilen Pfad gibt, ist
 * `process.execPath` die richtige Antwort und bleibt stehen — ein npm-global
 * mit eigenem node, ein Quell-Checkout, nvm (das versionsgebundene Pfade als
 * Prinzip hat). Und ein Kandidat wird erst genommen, wenn er sich als node
 * ausweist: existieren reicht nicht, er muss laufen.
 */
export function stableNodeBin(execPath: string = process.execPath): string {
  for (const candidate of stableNodeCandidates(execPath)) {
    if (candidate !== execPath && isRunnableNode(candidate)) return candidate;
  }
  return execPath;
}

/** `<prefix>/Cellar/<formel>/<version>/bin/node` → die stabilen Geschwister. */
function stableNodeCandidates(execPath: string): string[] {
  const keg = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(execPath);
  if (!keg) return [];
  const [, prefix, formula] = keg;
  return [join(prefix, "opt", formula, "bin", "node"), join(prefix, "bin", "node")];
}

/** Existiert, ist ausführbar, und meldet sich als node. Alle drei, oder nichts. */
export function isRunnableNode(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return false;
  }
  const r = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 15_000 });
  return r.status === 0 && /^v\d+\.\d+\.\d+/.test((r.stdout ?? "").trim());
}

/**
 * Die Umgebung, die der Autostart-Daemon bekommt.
 *
 * Bewusst schmal: der Vault-Pfad, der abgeschaltete Idle-Shutdown (wer
 * Autostart einschaltet, will genau den Dauerbetrieb) und ein PATH, der Node
 * findet. Alles Weitere — Embedding-Provider, Modelle — bleibt bei den
 * Einstellungen, die der Daemon ohnehin selbst liest. Ein plist, der jede
 * Option einfriert, wäre bei der nächsten Änderung sofort falsch, und niemand
 * würde es merken.
 *
 * DER PORT IST DIE AUSNAHME (#531). Der alte Kommentar hier behauptete, der
 * Daemon lese ihn aus den Einstellungen — das tut er nicht: `BASTRA_HTTP_PORT`
 * gibt es nur als Umgebungsvariable. Ein `bastra autostart on` aus einer Shell
 * mit `export BASTRA_HTTP_PORT=26723` schrieb also einen LaunchAgent, der auf
 * 6723 startete, während die Diagnose weiter 26723 nannte. Steht ein Endpunkt
 * fest, wird er deshalb HIER eingefroren — als `BASTRA_HTTP_PORT` (das liest
 * der Daemon beim Binden) und als `BASTRA_DAEMON_URL` (daran erkennt ihn der
 * nächste Lauf im plist wieder).
 */
export function autostartEnv(
  vaultPath: string,
  nodeBin: string,
  daemonUrl: string | null = endpointToPersist(null),
  platform: NodeJS.Platform = process.platform,
  existing: Record<string, string> = {},
  shell: NodeJS.ProcessEnv = process.env,
  write?: (s: string) => void,
  w: AutostartWords = EN
): Record<string, string> {
  const env: Record<string, string> = {
    [MANAGED_MARKER]: "1",
    BASTRA_VAULT_PATH: vaultPath,
    BASTRA_DAEMON_IDLE_SHUTDOWN_MS: "0",
    PATH:
      platform === "win32"
        ? (process.env.PATH ?? "")
        : `${dirname(nodeBin)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
  };
  const port = portOfEndpoint(daemonUrl);
  if (daemonUrl !== null && port !== null) {
    env.BASTRA_DAEMON_URL = daemonUrl;
    env.BASTRA_HTTP_PORT = String(port);
  }
  // Existing opt-ins remain authoritative; explicit `on` vault/endpoint inputs win.
  const merged: Record<string, string> = {
    ...bastraShellEnv(shell),
    ...env,
    ...cleanManagedEnv(existing, write, w),
    [MANAGED_MARKER]: "1",
    BASTRA_VAULT_PATH: vaultPath,
  };
  if (daemonUrl !== null && port !== null) {
    merged.BASTRA_DAEMON_URL = daemonUrl;
    merged.BASTRA_HTTP_PORT = String(port);
  }
  return merged;
}

function bastraShellEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  // Deliberate opt-ins only: never persist API keys or transient client routing.
  const keys = ["BASTRA_TASKS", "BASTRA_TRAINING_CAPTURE"] as const;
  return Object.fromEntries(keys.flatMap((key) => (typeof env[key] === "string" ? [[key, env[key]!]] : [])));
}

async function writePlistAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

function bootout(uid: string, launchctl = LAUNCHCTL): boolean {
  const result = spawnSync(launchctl, ["bootout", `gui/${uid}/${LAUNCH_AGENT_LABEL}`], {
    stdio: "pipe",
    timeout: 15_000,
  });
  return result.status === 0;
}

function bootstrap(uid: string, path: string, launchctl = LAUNCHCTL): { ok: boolean; detail: string } {
  const r = spawnSync(launchctl, ["bootstrap", `gui/${uid}`, path], {
    stdio: "pipe",
    encoding: "utf8",
    timeout: 15_000,
  });
  if (r.status === 0) return { ok: true, detail: "" };
  return { ok: false, detail: (r.stderr || r.stdout || "").trim() || `exit ${r.status}` };
}

/** Platform service boundary; the launchd commands retain their existing behavior. */
export function autostartService(platform: NodeJS.Platform = process.platform): AutostartService | null {
  if (platform === "win32") return windowsService();
  if (platform !== "darwin") return null;
  const uid = String(process.getuid?.() ?? 0);
  return {
    status: () => readState(),
    async install(env, program, opts) {
      const state = await readState();
      if (state.exists && !state.managed && !opts.force) return { ok: false, detail: "foreign LaunchAgent" };
      await writePlistAtomically(state.path, renderPlist(env, program));
      if (!opts.reload) return { ok: true, detail: "staged" };
      if (state.loaded) {
        if (!bootout(uid)) return { ok: false, detail: "bootout failed; service was not reloaded" };
        await delay(2000);
      }
      return bootstrap(uid, state.path);
    },
    async uninstall(opts = {}) {
      const state = await readState();
      if (state.exists && !state.managed && !opts.force) return { ok: false, detail: "foreign LaunchAgent" };
      if (state.loaded) bootout(uid);
      await unlink(state.path).catch(() => {});
      return { ok: true, detail: "" };
    },
    async kickstart() {
      const r = spawnSync(LAUNCHCTL, ["kickstart", "-k", `gui/${uid}/${LAUNCH_AGENT_LABEL}`], {
        stdio: "pipe",
        encoding: "utf8",
        timeout: 15_000,
      });
      return { ok: r.status === 0, detail: (r.stderr || r.stdout || "").trim() };
    },
  };
}
/** The English words: the browser settings path and the defaults print these. */
const EN = autostartWordsIn("en");

function unsupported(write: (s: string) => void, w: AutostartWords): boolean {
  if (autostartService()) return false;
  write(w.unsupported);
  return true;
}
async function serviceState(): Promise<AutostartState> {
  return autostartService()?.status() ?? readState();
}

// ─── on ─────────────────────────────────────────────────────────

export async function autostartOn(
  args: Pick<ParsedArgs, "dryRun" | "force" | "vaultPath">,
  stageOnly = false,
  w: AutostartWords = EN
): Promise<number> {
  const write = (s: string) => process.stdout.write(s);
  if (unsupported(write, w)) return 1;

  const state = await serviceState();
  if (state.exists && !state.managed && !args.force) {
    process.stderr.write(w.foreign(state.path, state.program.length > 0 ? state.program.join(" ") : null));
    return 1;
  }

  const vault = await resolveVault({ dryRun: false, vaultPath: args.vaultPath });
  if ("error" in vault) {
    process.stderr.write(w.error(vault.error));
    return 2;
  }
  if (!existsSync(DAEMON_SCRIPT_PATH)) {
    process.stderr.write(w.scriptMissing(DAEMON_SCRIPT_PATH));
    return 2;
  }

  // #435 — the stable node symlink, not the version-pinned keg path a node
  // upgrade would leave dangling.
  const nodeBin = stableNodeBin();
  const program = [nodeBin, DAEMON_SCRIPT_PATH];
  // #531 — the endpoint this process was told about, or the one the existing
  // managed plist already froze.
  const endpoint = endpointToPersist(state.endpoint);
  const env = autostartEnv(
    vault.path,
    nodeBin,
    endpoint,
    process.platform,
    state.managed ? state.env : {},
    process.env,
    write,
    w
  );

  if (args.dryRun) {
    write(w.dryRunWrite(state.path));
    write(w.dryRunStart(program.join(" "), vault.path));
    if (endpoint !== null) write(w.dryRunEndpoint(endpoint));
    return 0;
  }

  const started = await autostartService()!.install(env, program, { reload: !stageOnly, force: args.force });

  write(w.onResult(started.ok));
  write(w.service(state.path));
  write(w.starts(program.join(" ")));
  write(w.vault(vault.path));
  if (endpoint !== null) write(w.endpointPersisted(endpoint));
  if (started.ok) {
    write(stageOnly ? w.registered : w.loaded);
  } else {
    write(w.serviceFailed(started.detail));
    return 1;
  }
  return 0;
}

// ─── off ────────────────────────────────────────────────────────

export async function autostartOff(
  args: Pick<ParsedArgs, "dryRun" | "force">,
  stageOnly = false,
  w: AutostartWords = EN
): Promise<number> {
  const write = (s: string) => process.stdout.write(s);
  if (unsupported(write, w)) return 1;

  const state = await serviceState();
  if (!state.exists) {
    write(w.alreadyOff);
    return 0;
  }
  if (!state.managed && !args.force) {
    process.stderr.write(w.notOurs(state.path));
    return 1;
  }
  if (args.dryRun) {
    write(w.dryRunRemove(state.path));
    return 0;
  }

  // Browser settings change the next login registration without terminating
  // the daemon that must finish this HTTP request. CLI defaults stay unchanged.
  const removed = stageOnly
    ? await unlink(state.path).then(() => ({ ok: true, detail: "" }))
    : await autostartService()!.uninstall({ force: args.force });
  if (!removed.ok) {
    process.stderr.write(w.error(removed.detail));
    return 1;
  }
  write(w.off);
  write(w.removed(state.path));
  write(stageOnly ? w.offStaged : w.offOnDemand);
  return 0;
}

// ─── status ─────────────────────────────────────────────────────

async function autostartStatus(args: ParsedArgs, w: AutostartWords): Promise<number> {
  const state = await serviceState();
  const probe = await probeDaemon();

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          platform: process.platform,
          service_path: state.path,
          plist_path: process.platform === "darwin" ? state.path : null,
          installed: state.exists,
          managed_by_bastra: state.managed,
          loaded: state.loaded,
          program: state.program,
          dangling_program: state.danglingProgram,
          missing_program_path: state.missingProgramPath,
          daemon_running: probe.ok,
          daemon_version: probe.version ?? null,
          // #531 — which instance the two lines above describe, and what the
          // LaunchAgent itself starts. Two fields, never merged into one.
          daemon_endpoint: probe.endpoint?.baseUrl ?? resolveDaemonEndpoint().baseUrl,
          service_endpoint: state.endpoint,
          plist_endpoint: process.platform === "darwin" ? state.endpoint : null,
        },
        null,
        2
      ) + "\n"
    );
    return 0;
  }

  const write = (s: string) => process.stdout.write(s);
  write(w.statusHeader);
  if (!autostartService()) {
    write(w.statusUnsupported);
    return 0;
  }
  if (!state.exists) {
    write(w.statusOff);
    return 0;
  }
  write(w.statusState(state.loaded, state.path));
  write(w.owner(state.managed));
  if (state.program.length > 0) write(w.starts(state.program.join(" ")));
  if (state.danglingProgram) {
    write(w.dangling(`${state.missingProgramPath}`));
  }
  const endpoint = probe.endpoint ?? resolveDaemonEndpoint();
  write(
    probe.ok
      ? w.daemonRunning(endpoint.label, probe.version ? ` (${probe.version})` : "")
      : w.daemonDown(endpoint.label)
  );
  // #531: a LaunchAgent that starts a daemon on one port while this CLI probes
  // another is exactly the split that made status describe two machines as one.
  const plistPort = portOfEndpoint(state.endpoint);
  if (state.managed && plistPort !== null && plistPort !== endpoint.port) {
    write(w.portSplit(plistPort, endpoint.label));
  }
  write("\n");
  return 0;
}

/**
 * Die Laufzeit, auf die der verwaltete Dienst nach einem Update zeigen MUSS.
 *
 * #435: Nicht die des laufenden Prozesses. Nach `brew upgrade` führt dieser
 * Prozess weiterhin Module aus dem abgelösten Keg aus — `process.execPath` und
 * `DAEMON_SCRIPT_PATH` beschreiben also die ALTE Installation. Wer den plist
 * daraus baut, biegt den Autostart auf genau das Verzeichnis zurück, das der
 * Installer gerade ersetzt hat. Der Aufrufer löst diese Angabe deshalb gegen
 * die tatsächlich installierte Ablage auf (`update.ts`) und reicht sie hier
 * herein.
 */
export interface InstalledRuntime {
  /** Das node-Binary, das der LaunchAgent ausführt. */
  node: string;
  /** Der Daemon-Einstiegspunkt der INSTALLIERTEN Version. */
  script: string;
  /** Die Version, zu der dieser Einstiegspunkt gehört — der Beleg in der
   *  Erfolgsmeldung. `null`, wenn sie nicht gelesen werden konnte. */
  version: string | null;
}

export interface RefreshOutcome {
  /** Zeigt der verwaltete Dienst jetzt nachweislich auf die installierte
   *  Laufzeit? Auch `true`, wenn es gar keinen verwalteten Dienst gibt. */
  ok: boolean;
  detail: string;
}

/**
 * Nach einem Update den EIGENEN Autostart auf die neue Installation ziehen.
 *
 * Genau der Schritt, der bisher fehlte: Ein `brew upgrade` legt die neue
 * Version in ein neues Verzeichnis, und ein plist, der auf das alte zeigt,
 * startet danach entweder nichts mehr oder weiter den alten Code. Fremde plists
 * bleiben unangetastet — sie zeigen absichtlich woandershin.
 *
 * `reload` trennt die zwei Entscheidungen, die vorher eine waren (#441):
 * „jetzt neu starten" und „den plist umbiegen". Ein staged Update setzt
 * `reload: false` — die Datei wird atomar auf die neue Laufzeit gezogen, der
 * laufende Agent bleibt unangetastet, und nach dem nächsten Login startet
 * launchd den neuen Code statt eines Pfades, den es dann nicht mehr gibt.
 *
 * Belegt wird das Ergebnis, nicht behauptet: der plist wird nach dem Schreiben
 * erneut gelesen und muss die installierte Laufzeit nennen, sonst ist das
 * Ergebnis `ok: false`.
 */
export async function refreshManagedAutostart(
  write: (s: string) => void,
  opts: {
    /** `null` = die installierte Laufzeit war nicht auflösbar. Dann wird der
     *  plist NICHT angefasst — lieber veraltet als auf ein Nichts gebogen. */
    target: InstalledRuntime | null;
    /** #441 — staged: umbiegen ja, kickstarten nein. */
    reload: boolean;
    /** Nur für die Regressionen: plist-Datei, launchd-CLI, plist-Leser und
     *  Plattform — damit sie auch auf dem Linux-Runner laufen (#940). */
    plistFile?: string;
    backupDir?: string;
    env?: NodeJS.ProcessEnv;
    launchctl?: string;
    plutil?: string;
    platform?: NodeJS.Platform;
  },
  /** The words to print in (language.primary of the update run); English when absent. */
  w: AutostartWords = EN
): Promise<RefreshOutcome> {
  if ((opts.platform ?? process.platform) === "win32") {
    return refreshWindowsAutostart(write, opts, windowsService(), w);
  }
  if ((opts.platform ?? process.platform) !== "darwin") return { ok: true, detail: "unsupported platform" };
  const launchctl = opts.launchctl ?? LAUNCHCTL;
  const plutil = opts.plutil ?? PLUTIL;
  const path = opts.plistFile ?? plistPath();
  const state = await readState(path, launchctl, plutil);
  if (!state.exists || !state.managed) return { ok: true, detail: "no managed autostart" };

  if (!opts.target) {
    write(w.notResolved(state.program[1] ?? w.unknownPath));
    return { ok: false, detail: "installed runtime not resolved" };
  }

  // Snapshot before any mutation or restart, even when no repoint is needed.
  // Fixture paths keep their backups in the fixture; production uses ~/.bastra.
  const backupDir =
    opts.backupDir ?? (opts.plistFile ? join(dirname(path), "backups") : join(homedir(), ".bastra", "backups"));
  try {
    await mkdir(backupDir, { recursive: true });
    const snapshot = join(
      backupDir,
      `launchagent-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}.plist`
    );
    // Create private from the first write; chmod after copy leaves an exposure window.
    await writeFile(snapshot, await safeLaunchAgentSnapshot(path, state.env, plutil), { mode: 0o600, flag: "wx" });
    await chmod(path, 0o600);
    write(w.snapshot(snapshot));
  } catch (err) {
    write(w.snapshotFailed(path, (err as Error).message));
    return { ok: false, detail: "LaunchAgent snapshot failed" };
  }

  const program = [opts.target.node, opts.target.script];
  const pointsAtInstall = state.program.length === program.length && state.program.every((p, i) => p === program[i]);
  const env = { ...bastraShellEnv(opts.env ?? process.env), ...cleanManagedEnv(state.env, write, w) };
  const envChanged =
    Object.keys(env).length !== Object.keys(state.env).length ||
    Object.keys(env).some((key) => env[key] !== state.env[key]);
  if (!pointsAtInstall || envChanged) {
    write(w.repointing(state.program[1] ?? w.unknownPath));
    try {
      // The existing environment is authoritative. Reconstructing defaults here
      // loses provider, retention and other settings before the next boot.
      await writePlistAtomically(path, renderPlist(env, program));
    } catch (err) {
      write(w.rewriteFailed(path, (err as Error).message));
      return { ok: false, detail: (err as Error).message };
    }
  }

  if (opts.reload) {
    const uid = String(process.getuid?.() ?? 0);
    if (state.loaded) {
      if (!bootout(uid, launchctl)) {
        write(w.bootoutFailed);
        return { ok: false, detail: "bootout failed; service was not reloaded" };
      }
      await delay(2000);
    }
    const started = bootstrap(uid, path, launchctl);
    if (!started.ok) {
      const detail = state.loaded
        ? `bootstrap failed after bootout; service is stopped: ${started.detail}`
        : `bootstrap failed; service is not running: ${started.detail}`;
      write(w.bootstrapFailed(state.loaded, started.detail, uid, path));
      return { ok: false, detail };
    }
  }

  // Der Beweis: erneut lesen. Erst wenn die Datei die installierte Laufzeit
  // nennt und die auch auf der Platte liegt, darf das hier Erfolg melden.
  const after = await readState(path, launchctl, plutil);
  if (after.program[0] !== opts.target.node || after.program[1] !== opts.target.script) {
    write(w.stillNames(after.program.join(" "), `${opts.target.node} ${opts.target.script}`));
    return { ok: false, detail: "verification failed" };
  }
  if (after.danglingProgram) {
    write(w.namesMissing(`${after.missingProgramPath}`));
    return { ok: false, detail: "verification failed" };
  }
  // Existieren reicht beim Binary nicht: launchd exec()t es, ein kaputter
  // Symlink oder ein nicht ausführbarer Rest eines aufgeräumten Kegs ist genau
  // so tot wie ein fehlender Pfad.
  if (!isRunnableNode(after.program[0])) {
    write(w.notNode(after.program[0]));
    return { ok: false, detail: "node binary not runnable" };
  }
  const version = opts.target.version ? ` (${opts.target.version})` : "";
  write(w.nowRuns(opts.reload, opts.target.script, version));
  return { ok: true, detail: opts.target.script };
}

/** Exported for platform-mocked lifecycle regressions. Never enables an absent service. */
export async function refreshWindowsAutostart(
  write: (s: string) => void,
  opts: { target: InstalledRuntime | null; reload: boolean },
  service: AutostartService,
  w: AutostartWords = EN
): Promise<RefreshOutcome> {
  const state = await service.status();
  if (!state.exists || !state.managed) return { ok: true, detail: "no managed autostart" };
  if (!opts.target) return { ok: false, detail: "installed runtime not resolved" };
  if (!existsSync(opts.target.node) || !existsSync(opts.target.script))
    return { ok: false, detail: "installed runtime missing" };
  const result = await service.install(state.env, [opts.target.node, opts.target.script], { reload: opts.reload });
  if (!result.ok) return result;
  const after = await service.status();
  if (
    !after.managed ||
    after.program[0] !== opts.target.node ||
    after.program[1] !== opts.target.script ||
    after.danglingProgram
  )
    return { ok: false, detail: "verification failed" };
  write(w.windowsRefreshed(opts.reload));
  return { ok: true, detail: opts.target.script };
}

/** Was `bastra doctor` über den Autostart zu sagen hat — `null`, wenn nichts. `w`: die Sprache des Doctor-Laufs. */
export async function autostartWarning(
  service = autostartService(),
  clientEnv: NodeJS.ProcessEnv = process.env,
  backupDir = join(homedir(), ".bastra", "backups"),
  launchAgentsDir = dirname(plistPath()),
  w: AutostartWords = EN
): Promise<string | null> {
  const warnings = await Promise.all([
    managedServiceWarning(service, clientEnv, w),
    legacySnapshotWarning(backupDir, w),
    launchAgentBackupWarning(launchAgentsDir, LAUNCH_AGENT_LABEL, w),
  ]);
  return warnings.filter(Boolean).join("; ") || null;
}

async function managedServiceWarning(
  service: AutostartService | null,
  clientEnv: NodeJS.ProcessEnv,
  w: AutostartWords
): Promise<string | null> {
  if (!service) return null;
  let state: AutostartState;
  try {
    state = await service.status();
  } catch (error) {
    return w.queryFailed((error as Error).message);
  }
  if (!state.exists) return null;
  if (state.danglingProgram) {
    return w.danglingWarning(`${state.missingProgramPath}`, state.managed);
  }
  if (state.exists && !state.loaded) {
    return w.notRunningWarning(state.path);
  }
  if (state.managed && state.loaded) {
    // All snapshots belong to this account's settings. tasksEnabled deliberately
    // ignores persistence for arbitrary env objects; diagnostics must instead
    // give each snapshot the same stored fallback, without leaking a client's
    // explicit BASTRA_TASKS override into the service comparison.
    const storedTasks = runtimeFeatureSetting("tasks", TASKS_DEFAULT);
    const effectiveTasks = (env: NodeJS.ProcessEnv) =>
      env.BASTRA_TASKS === undefined ? storedTasks : tasksEnabled(env);
    const loaded = state.loadedEnv;
    if (loaded && effectiveTasks(loaded) !== effectiveTasks(state.env)) {
      return w.tasksPlistDrift;
    }
    if (effectiveTasks(clientEnv) !== effectiveTasks(loaded ?? state.env)) {
      return w.tasksClientDrift;
    }
  }
  return null;
}

export async function cmdAutostart(args: ParsedArgs): Promise<number> {
  const w = autostartWordsIn(await taskCliLanguage().catch(() => "en"));
  switch (args.surface) {
    case "on":
      return autostartOn(args, false, w);
    case "off":
      return autostartOff(args, false, w);
    case "status":
    case null:
      return autostartStatus(args, w);
    default:
      process.stderr.write(w.unknownSub(`${args.surface}`));
      return 2;
  }
}
