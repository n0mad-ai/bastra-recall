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
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DAEMON_SCRIPT_PATH } from "./paths.js";
import { probeDaemon, resolveVault } from "./helpers.js";
import type { ParsedArgs } from "./types.js";

/** Dasselbe Label, das `index.ts` und `update.ts` kennen. Ein zweites wäre ein
 *  zweiter Daemon auf demselben Port. */
export const LAUNCH_AGENT_LABEL = "ai.n0mad.bastra-recall";

/**
 * Die Marke, an der bastra seinen EIGENEN plist wiedererkennt.
 *
 * Bewusst eine Umgebungsvariable und kein zusätzlicher Top-Level-Key: launchd
 * ist bei unbekannten Keys auf oberster Ebene je nach Version wählerisch, und
 * die Variable ist nebenbei nützlich — der Daemon weiß damit, dass er als
 * Autostart läuft und nicht als Autospawn.
 */
const MANAGED_MARKER = "BASTRA_AUTOSTART_MANAGED";

export function plistPath(home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

export interface AutostartState {
  path: string;
  exists: boolean;
  /** Von bastra geschrieben? Nur dann darf dieser Code ihn anfassen. */
  managed: boolean;
  /** Was der plist startet — `[node, script]`. Leer, wenn unlesbar. */
  program: string[];
  /** Ist der Agent bei launchd geladen? */
  loaded: boolean;
  /** Der plist ist da, aber sein Programm liegt nicht mehr auf der Platte —
   *  der klassische Zustand nach einem Update, das den Pfad verschoben hat. */
  danglingProgram: boolean;
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
export async function readState(path = plistPath()): Promise<AutostartState> {
  const state: AutostartState = {
    path,
    exists: existsSync(path),
    managed: false,
    program: [],
    loaded: launchAgentLoaded(),
    danglingProgram: false,
  };
  if (!state.exists) return state;
  const conv = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], {
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
    state.managed = parsed.EnvironmentVariables?.[MANAGED_MARKER] === "1";
  } catch {
    // Unparsebar heißt FREMD, nicht „gehört uns" — dieselbe fail-closed-Regel
    // wie im Vault-Schreibpfad. Ein Fehler beim Lesen darf nie zu einem
    // Überschreiben führen.
    return state;
  }
  // Das Skript ist das zweite Argument (`node <script>`); ohne es ist der
  // Agent kaputt, mit einem nicht mehr existierenden Pfad ist er veraltet.
  const script = state.program[1];
  state.danglingProgram = script !== undefined && !existsSync(script);
  return state;
}

function launchAgentLoaded(): boolean {
  const uid = String(process.getuid?.() ?? 0);
  const r = spawnSync("/bin/launchctl", ["print", `gui/${uid}/${LAUNCH_AGENT_LABEL}`], {
    stdio: "pipe",
    timeout: 15_000,
  });
  return r.status === 0;
}

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
 * Die Umgebung, die der Autostart-Daemon bekommt.
 *
 * Bewusst schmal: der Vault-Pfad, der abgeschaltete Idle-Shutdown (wer
 * Autostart einschaltet, will genau den Dauerbetrieb) und ein PATH, der Node
 * findet. Alles Weitere — Embedding-Provider, Modelle, Port — bleibt bei den
 * Einstellungen, die der Daemon ohnehin selbst liest. Ein plist, der jede
 * Option einfriert, wäre bei der nächsten Änderung sofort falsch, und niemand
 * würde es merken.
 */
export function autostartEnv(vaultPath: string, nodeBin: string): Record<string, string> {
  return {
    [MANAGED_MARKER]: "1",
    BASTRA_VAULT_PATH: vaultPath,
    BASTRA_DAEMON_IDLE_SHUTDOWN_MS: "0",
    PATH: `${dirname(nodeBin)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
  };
}

async function writePlistAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

function bootout(uid: string): void {
  spawnSync("/bin/launchctl", ["bootout", `gui/${uid}/${LAUNCH_AGENT_LABEL}`], {
    stdio: "pipe",
    timeout: 15_000,
  });
}

function bootstrap(uid: string, path: string): { ok: boolean; detail: string } {
  const r = spawnSync("/bin/launchctl", ["bootstrap", `gui/${uid}`, path], {
    stdio: "pipe",
    encoding: "utf8",
    timeout: 15_000,
  });
  if (r.status === 0) return { ok: true, detail: "" };
  return { ok: false, detail: (r.stderr || r.stdout || "").trim() || `exit ${r.status}` };
}

function notMacOS(write: (s: string) => void): boolean {
  if (process.platform === "darwin") return false;
  write(
    "bastra autostart is macOS-only right now — it manages a launchd LaunchAgent.\n" +
      "On Linux the daemon still starts on demand through the MCP forwarder; for a\n" +
      "permanent service write a systemd user unit that runs:\n" +
      `  ${process.execPath} ${DAEMON_SCRIPT_PATH}\n`,
  );
  return true;
}

// ─── on ─────────────────────────────────────────────────────────

async function autostartOn(args: ParsedArgs): Promise<number> {
  const write = (s: string) => process.stdout.write(s);
  if (notMacOS(write)) return 1;

  const state = await readState();
  if (state.exists && !state.managed && !args.force) {
    process.stderr.write(
      `error: ${state.path} already exists and was not written by bastra.\n` +
        (state.program.length > 0 ? `  it starts: ${state.program.join(" ")}\n` : "") +
        `  Leaving it alone — a hand-written LaunchAgent usually points somewhere on purpose\n` +
        `  (a source checkout, a custom model setup). Replace it with --force, or remove it first.\n`,
    );
    return 1;
  }

  const vault = await resolveVault({ dryRun: false, vaultPath: args.vaultPath });
  if ("error" in vault) {
    process.stderr.write(`error: ${vault.error}\n`);
    return 2;
  }
  if (!existsSync(DAEMON_SCRIPT_PATH)) {
    process.stderr.write(
      `error: the daemon entry point is missing: ${DAEMON_SCRIPT_PATH}\n` +
        `  Run the build (or reinstall) before enabling autostart.\n`,
    );
    return 2;
  }

  const program = [process.execPath, DAEMON_SCRIPT_PATH];
  const content = renderPlist(autostartEnv(vault.path, process.execPath), program);

  if (args.dryRun) {
    write(`(dry-run — writing nothing)\n\n  would write ${state.path}\n`);
    write(`  would start: ${program.join(" ")}\n  vault: ${vault.path}\n`);
    return 0;
  }

  await writePlistAtomically(state.path, content);
  const uid = String(process.getuid?.() ?? 0);
  // Erst abmelden, dann neu laden: `bootstrap` auf ein bereits geladenes Label
  // scheitert, und ein `on` auf einen laufenden Agenten ist genau der
  // Update-Fall, den dieser Befehl bedienen soll.
  if (state.loaded) bootout(uid);
  const started = bootstrap(uid, state.path);

  write(`✓ autostart on\n`);
  write(`  plist:  ${state.path}\n`);
  write(`  starts: ${program.join(" ")}\n`);
  write(`  vault:  ${vault.path}\n`);
  if (started.ok) {
    write(`  ✓ loaded — the daemon stays up from now on (idle shutdown disabled)\n`);
  } else {
    write(
      `  ✗ launchctl bootstrap failed: ${started.detail}\n` +
        `    The file is written; load it by hand or log out and back in.\n`,
    );
    return 1;
  }
  return 0;
}

// ─── off ────────────────────────────────────────────────────────

async function autostartOff(args: ParsedArgs): Promise<number> {
  const write = (s: string) => process.stdout.write(s);
  if (notMacOS(write)) return 1;

  const state = await readState();
  if (!state.exists) {
    write("autostart is already off — no LaunchAgent installed.\n");
    write("  The daemon still starts on demand when an AI client calls it.\n");
    return 0;
  }
  if (!state.managed && !args.force) {
    process.stderr.write(
      `error: ${state.path} was not written by bastra — leaving it alone.\n` +
        `  Remove it with --force, or delete the file yourself.\n`,
    );
    return 1;
  }
  if (args.dryRun) {
    write(`(dry-run — writing nothing)\n\n  would unload and remove ${state.path}\n`);
    return 0;
  }

  const uid = String(process.getuid?.() ?? 0);
  if (state.loaded) bootout(uid);
  await unlink(state.path).catch(() => {});
  write("✓ autostart off\n");
  write(`  removed ${state.path}\n`);
  write("  The daemon still starts on demand through the MCP forwarder,\n");
  write("  and shuts down again after 30 minutes idle.\n");
  return 0;
}

// ─── status ─────────────────────────────────────────────────────

async function autostartStatus(args: ParsedArgs): Promise<number> {
  const state = await readState();
  const probe = await probeDaemon();

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          platform: process.platform,
          plist_path: state.path,
          installed: state.exists,
          managed_by_bastra: state.managed,
          loaded: state.loaded,
          program: state.program,
          dangling_program: state.danglingProgram,
          daemon_running: probe.ok,
          daemon_version: probe.version ?? null,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  const write = (s: string) => process.stdout.write(s);
  write("→ autostart\n");
  if (process.platform !== "darwin") {
    write("  · macOS-only — this system uses on-demand start through the MCP forwarder\n\n");
    return 0;
  }
  if (!state.exists) {
    write("  off — the daemon starts on demand and shuts down after 30 min idle\n");
    write(`  turn it on with: bastra autostart on\n\n`);
    return 0;
  }
  write(`  ${state.loaded ? "on" : "installed but NOT loaded"} — ${state.path}\n`);
  write(`  owner:  ${state.managed ? "bastra" : "hand-written (bastra will not touch it)"}\n`);
  if (state.program.length > 0) write(`  starts: ${state.program.join(" ")}\n`);
  if (state.danglingProgram) {
    write(
      `  ⚠ that path does not exist any more — the autostart points at an installation\n` +
        `    that was moved or removed. Fix it with: bastra autostart on\n`,
    );
  }
  write(
    probe.ok
      ? `  daemon: running${probe.version ? ` (${probe.version})` : ""}\n\n`
      : `  daemon: not reachable\n\n`,
  );
  return 0;
}

/**
 * Nach einem Update den EIGENEN Autostart auf die neue Installation ziehen.
 *
 * Genau der Schritt, der bisher fehlte: Ein `brew upgrade` legt die neue
 * Version in ein neues Verzeichnis, und ein plist, der auf das alte zeigt,
 * startet danach entweder nichts mehr oder weiter den alten Code. Fremde plists
 * bleiben unangetastet — sie zeigen absichtlich woandershin.
 *
 * Still im Erfolgsfall, laut im Fehlerfall: Der Aufrufer ist `bastra update`,
 * und dort ist das ein Nebenschritt, kein Ergebnis.
 */
export async function refreshManagedAutostart(
  write: (s: string) => void,
): Promise<void> {
  if (process.platform !== "darwin") return;
  const state = await readState();
  if (!state.exists || !state.managed) return;
  const current = [process.execPath, DAEMON_SCRIPT_PATH];
  if (state.program.length === current.length && state.program.every((p, i) => p === current[i])) {
    return; // zeigt schon auf diese Installation
  }
  write(`→ autostart points at ${state.program[1] ?? "an unknown path"} — updating it\n`);
  const vault = await resolveVault({ dryRun: false, vaultPath: null });
  if ("error" in vault) {
    write(`  ✗ cannot update the autostart: ${vault.error}\n`);
    return;
  }
  try {
    await writePlistAtomically(state.path, renderPlist(autostartEnv(vault.path, process.execPath), current));
  } catch (err) {
    write(`  ✗ could not rewrite ${state.path}: ${(err as Error).message}\n`);
    return;
  }
  const uid = String(process.getuid?.() ?? 0);
  if (state.loaded) bootout(uid);
  const started = bootstrap(uid, state.path);
  write(started.ok ? `  ✓ autostart now runs ${current[1]}\n` : `  ✗ reload failed: ${started.detail}\n`);
}

/** Was `bastra doctor` über den Autostart zu sagen hat — `null`, wenn nichts. */
export async function autostartWarning(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const state = await readState();
  if (!state.exists) return null;
  if (state.danglingProgram) {
    return (
      `autostart points at ${state.program[1]}, which does not exist any more — ` +
      (state.managed
        ? `run 'bastra autostart on' to repoint it.`
        : `it is hand-written, so fix it yourself or replace it with 'bastra autostart on --force'.`)
    );
  }
  if (state.exists && !state.loaded) {
    return `a LaunchAgent is installed at ${state.path} but not loaded — run 'bastra autostart on'.`;
  }
  return null;
}

export async function cmdAutostart(args: ParsedArgs): Promise<number> {
  switch (args.surface) {
    case "on":
      return autostartOn(args);
    case "off":
      return autostartOff(args);
    case "status":
    case null:
      return autostartStatus(args);
    default:
      process.stderr.write(
        `error: unknown autostart subcommand '${args.surface}' — use on, off or status\n`,
      );
      return 2;
  }
}
