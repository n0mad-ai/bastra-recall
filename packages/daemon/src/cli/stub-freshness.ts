/**
 * Is the compiled hook binary the hooks actually run still the one today's
 * sources describe? (#546)
 *
 * The binary installed on the dev host was from 29.08. and had run for two
 * weeks against sources that had moved on through #305, #543 and #545. It
 * wrote telemetry rows without a `session_id` and under the wrong lane, so the
 * whole #305 measurement rested on numbers a fortnight-old build had produced
 * — and nobody noticed, because nothing ever asked. `npm run test:stub` catches
 * that shape in CI since #546; this is the everyday half: the question gets
 * asked on `bastra doctor`, before somebody works for days on wrong figures.
 *
 * Everything here reuses what already exists rather than restating it:
 *
 *  · the digest rule is `scripts/stub-source-digest.mjs`, the same module the
 *    build stamps with and the parity guard compares against — three callers,
 *    one definition of "the stub's sources";
 *  · the answer from the binary is `bastra-hook version` (stub/build-info.ts),
 *    the only way a compiled binary can say which sources it came from.
 *
 * Two things this must NOT do:
 *
 *  · build anything. A stub build costs a deno compile; doctor runs it never.
 *    The stamp is asked for (~25 ms for one `version` call), not produced.
 *  · guess. A Homebrew or npm install has no `stub/*.ts` and no `scripts/`
 *    (package.json `files` ships neither), so there is nothing to compare the
 *    binary against. "Current" and "stale" are both unfounded claims there;
 *    the honest answer is that it cannot be checked here, said out loud — a
 *    check that goes quiet exactly where it cannot see is how the fortnight-old
 *    binary survived in the first place.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DAEMON_PACKAGE_ROOT, HOOK_STUB_BIN } from "./paths.js";

/** What `bastra-hook version` prints (stub/build-info.ts plus the version). */
export interface StubStamp {
  stub_version?: string;
  source_digest?: string;
  revision?: string | null;
  dirty?: boolean;
  built_at?: string | null;
}

/**
 * The five states this check can end in, each a different sentence:
 *
 *  · `ok`              — the binary carries the digest of the sources here.
 *  · `stale`           — it carries a different one: it was built from other
 *                        sources, which is the #546 finding itself.
 *  · `unstamped`       — it answers `version` without a digest (or not at all
 *                        in the shape we expect): a binary from before #546.
 *                        Not "stale" — we do not know that it is — and not
 *                        "ok" either, because it cannot be asked. Its own name.
 *  · `unknown-sources` — no stub sources in this installation. The binary is
 *                        fine to run; whether it is current is not answerable
 *                        HERE, and saying so beats guessing either way.
 *  · `missing`         — the registration points at a path that does not
 *                        exist. The hooks then run nothing at all.
 *  · `unreadable`      — the file is there but `version` failed (not
 *                        executable, wrong architecture, truncated download).
 */
export type StubState = "ok" | "stale" | "unstamped" | "unknown-sources" | "missing" | "unreadable";

export interface StubFinding {
  /** The absolute path the client registrations execute. */
  binary: string;
  /** Which surfaces register it, sorted — `claude-code`, `codex`. */
  surfaces: string[];
  /** True when this is NOT the binary this installation manages
   *  (`HOOK_STUB_BIN`): the user runs hooks out of a different tree than the
   *  one they are looking at. A finding in its own right (#546). */
  foreign: boolean;
  state: StubState;
  /** What the binary said about itself, when it could be asked. */
  stamp: StubStamp | null;
  /** The digest of the sources in this installation, or null when there are
   *  none to compute one from. */
  expectedDigest: string | null;
}

export interface StubFreshnessReport {
  /** The stub binary path this installation owns. */
  own: string;
  /** Could the stub's sources be found here at all? */
  sourcesAvailable: boolean;
  /** One entry per distinct registered binary. Empty means no registration
   *  runs a compiled stub — this host is on the node thin client, which ships
   *  inside `dist` and therefore cannot drift from it. Nothing to report. */
  findings: StubFinding[];
}

/** `npm run build:stub` is only runnable where the sources are. */
export const STUB_REBUILD_HINT = "npm run build:stub -w @bastra-recall/daemon";

// ─── where the registrations live ────────────────────────────────

/**
 * The two files that can register a compiled stub. Claude Desktop and Cursor
 * are MCP-only — they have no hook lanes and therefore no binary to be stale.
 *
 * Parameterised on `home` rather than reusing the module-level constants from
 * `paths.js` so the guard can point the whole check at a temp HOME instead of
 * a developer's real registrations. `stubRegistrationFiles(homedir())` equals
 * `[CLAUDE_CODE_SETTINGS, CODEX_HOOKS]`, and a test pins that.
 */
export function stubRegistrationFiles(home: string = homedir()): Array<{ surface: string; path: string }> {
  return [
    { surface: "claude-code", path: join(home, ".claude", "settings.json") },
    { surface: "codex", path: join(home, ".codex", "hooks.json") },
  ];
}

/**
 * The compiled stub a registered command runs, or null when it runs something
 * else (the node thin client, or a foreign hook entirely).
 *
 * Broader on purpose than `stubLaneCommandPath()` in adapters/claude-code.ts,
 * which answers a different question — "is THIS lane registered on the stub?"
 * — and therefore reads only the leading program token for one named lane.
 * Two registered forms fall outside that and still execute the binary:
 *
 *   BASTRA_HOOK_CLIENT=codex '/…/stub/bastra-hook' prompt   (the codex form)
 *   /…/stub/bastra-hook statusline --style=powerline        (#347)
 *
 * Here the question is only "which binary file is this command going to run",
 * so any token whose basename is the stub counts, whatever precedes or follows
 * it. A lane check that accepted those would be wrong; this one would be blind
 * without them.
 */
export function registeredStubBinary(cmd: string, home: string = homedir()): string | null {
  for (const m of cmd.matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    const path = raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
    const base = basename(path);
    if (base === "bastra-hook" || base === "bastra-hook.exe") return path;
  }
  return null;
}

/** Every `command` string anywhere in a parsed registration file. The two
 *  formats nest differently (Claude: events → matchers → hooks; Codex: events
 *  → entries), and a walk is both shorter than two readers and immune to
 *  either format moving a level. */
function commandStrings(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const v of node) commandStrings(v, out);
    return out;
  }
  if (typeof node === "object" && node !== null) {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "command" && typeof v === "string") out.push(v);
      else commandStrings(v, out);
    }
  }
  return out;
}

/** The distinct stub binaries the registrations point at, with the surfaces
 *  that name them. A file that is absent or unparseable contributes nothing:
 *  a broken registration is the surface adapters' finding, not this one's. */
export async function collectRegisteredStubs(
  home: string = homedir(),
): Promise<Array<{ binary: string; surfaces: string[] }>> {
  const bySurface = new Map<string, Set<string>>();
  for (const { surface, path } of stubRegistrationFiles(home)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    for (const cmd of commandStrings(parsed)) {
      const binary = registeredStubBinary(cmd, home);
      if (!binary) continue;
      const set = bySurface.get(binary) ?? new Set<string>();
      set.add(surface);
      bySurface.set(binary, set);
    }
  }
  return [...bySurface.entries()]
    .map(([binary, surfaces]) => ({ binary, surfaces: [...surfaces].sort() }))
    .sort((a, b) => a.binary.localeCompare(b.binary));
}

// ─── the two sides of the comparison ─────────────────────────────

/**
 * The digest of the stub sources in THIS installation, or null when it has
 * none.
 *
 * Loaded dynamically, and that is the point rather than a workaround: the
 * digest module lives in `scripts/`, which `package.json` `files` does not
 * ship, just like `stub/*.ts`. On an npm or Homebrew install the import would
 * be a hard failure at load time for a check that is supposed to answer "there
 * is nothing here to compare against" and move on. Both files are probed
 * first, so the absence is a state, not an exception.
 */
export async function localStubSourceDigest(root: string = DAEMON_PACKAGE_ROOT): Promise<string | null> {
  const digestModule = join(root, "scripts", "stub-source-digest.mjs");
  const stubEntry = join(root, "stub", "bastra-hook.ts");
  if (!existsSync(digestModule) || !existsSync(stubEntry)) return null;
  try {
    const mod = (await import(pathToFileURL(digestModule).href)) as {
      stubSourceDigest?: () => string;
    };
    const digest = mod.stubSourceDigest?.();
    return typeof digest === "string" && digest.length > 0 ? digest : null;
  } catch {
    // A checkout whose digest module cannot run is indistinguishable, for this
    // check, from one that has none: either way there is no reference value.
    return null;
  }
}

/**
 * Ask a compiled binary which sources it came from.
 *
 * One short-lived process, no stdin, hard-capped — doctor must stay quick, and
 * a binary that hangs on `version` must not take the diagnostics with it.
 * `null` means it could not be asked at all; a stamp without `source_digest`
 * means it was asked and predates the stamp (#546).
 */
export function readStubStamp(binary: string, timeoutMs = 5_000): StubStamp | null {
  const r = spawnSync(binary, ["version"], { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] });
  if (r.error || r.status !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(r.stdout);
    return typeof parsed === "object" && parsed !== null ? (parsed as StubStamp) : null;
  } catch {
    return null;
  }
}

// ─── the check ───────────────────────────────────────────────────

export interface StubFreshnessIo {
  home?: string;
  /** This installation's own stub path — injectable so the guard can point at
   *  a temp tree instead of the developer's live binary. */
  ownBinary?: string;
  /** The package root the stub sources would be under. */
  packageRoot?: string;
  exists?: (path: string) => boolean;
  stamp?: (binary: string) => StubStamp | null;
}

export async function stubFreshness(io: StubFreshnessIo = {}): Promise<StubFreshnessReport> {
  const home = io.home ?? homedir();
  const own = io.ownBinary ?? HOOK_STUB_BIN;
  const exists = io.exists ?? existsSync;
  const stampOf = io.stamp ?? ((b: string) => readStubStamp(b));
  const expectedDigest = await localStubSourceDigest(io.packageRoot ?? DAEMON_PACKAGE_ROOT);

  const findings: StubFinding[] = [];
  for (const { binary, surfaces } of await collectRegisteredStubs(home)) {
    const foreign = binary !== own;
    if (!exists(binary)) {
      findings.push({ binary, surfaces, foreign, state: "missing", stamp: null, expectedDigest });
      continue;
    }
    const stamp = stampOf(binary);
    if (stamp === null) {
      findings.push({ binary, surfaces, foreign, state: "unreadable", stamp: null, expectedDigest });
      continue;
    }
    const digest = typeof stamp.source_digest === "string" ? stamp.source_digest : "";
    if (digest === "") {
      findings.push({ binary, surfaces, foreign, state: "unstamped", stamp, expectedDigest });
      continue;
    }
    if (expectedDigest === null) {
      findings.push({ binary, surfaces, foreign, state: "unknown-sources", stamp, expectedDigest });
      continue;
    }
    findings.push({
      binary,
      surfaces,
      foreign,
      state: digest === expectedDigest ? "ok" : "stale",
      stamp,
      expectedDigest,
    });
  }
  return { own, sourcesAvailable: expectedDigest !== null, findings };
}

// ─── how it reads ────────────────────────────────────────────────

function builtFrom(stamp: StubStamp | null): string {
  if (!stamp) return "";
  const at = typeof stamp.built_at === "string" ? stamp.built_at.slice(0, 10) : null;
  const rev = typeof stamp.revision === "string" ? stamp.revision.slice(0, 7) : null;
  if (at && rev) return ` (built ${at} from ${rev}${stamp.dirty ? ", uncommitted" : ""})`;
  if (at) return ` (built ${at})`;
  if (rev) return ` (from ${rev})`;
  return "";
}

/**
 * The lines of the `→ hook binary` block, in doctor's existing vocabulary:
 * `✓ ok` for a verified match, `⚠` for something to act on, `·` for a fact
 * that is neither. Empty when nothing registers a compiled stub.
 *
 * The rebuild hint appears only where it can be carried out. Telling a
 * Homebrew user to run a workspace npm script would be advice they cannot
 * take, and advice that cannot be taken teaches people to skip the message.
 */
export function stubFreshnessLines(report: StubFreshnessReport): string[] {
  const lines: string[] = [];
  for (const f of report.findings) {
    const who = f.surfaces.join(", ");
    const rebuild = report.sourcesAvailable ? ` — rebuild it with \`${STUB_REBUILD_HINT}\`` : "";
    switch (f.state) {
      case "ok":
        lines.push(`✓ ok: ${f.binary} matches the sources in this checkout${builtFrom(f.stamp)}`);
        break;
      case "stale":
        lines.push(
          `⚠ stale hook binary: ${f.binary}${builtFrom(f.stamp)} was built from different sources than the ones` +
            ` in this checkout. Every hook call on ${who} runs that older code — this is how a two-week-old` +
            ` binary wrote telemetry nobody could fold (#546)${rebuild}`,
        );
        break;
      case "unstamped":
        lines.push(
          `⚠ unstamped hook binary: ${f.binary} answers \`version\` without a source digest, so it predates` +
            ` #546 and cannot say which sources it came from. That is not the same as current${rebuild}`,
        );
        break;
      case "unknown-sources":
        lines.push(
          `· ${f.binary}${builtFrom(f.stamp)} — this installation ships no stub sources, so whether the binary` +
            ` is still current cannot be decided here. Check it in a source checkout.`,
        );
        break;
      case "missing":
        lines.push(
          `⚠ missing hook binary: ${who} registers ${f.binary}, and no such file exists —` +
            ` those hook lanes run nothing. Re-run \`bastra install ${f.surfaces[0]}\``,
        );
        break;
      case "unreadable":
        lines.push(
          `⚠ unusable hook binary: ${f.binary} is there but \`${basename(f.binary)} version\` did not answer` +
            ` — an interrupted download or a binary for another architecture. Re-run \`bastra install ${f.surfaces[0]}\``,
        );
        break;
    }
    if (f.foreign) {
      lines.push(
        `⚠ ${who} runs ${f.binary}, not this installation's ${report.own} —` +
          ` the hooks execute a different build than the one you are looking at.` +
          ` \`bastra install ${f.surfaces[0]}\` re-registers this one`,
      );
    }
  }
  return lines;
}
