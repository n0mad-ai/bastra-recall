/**
 * The compiled hook client on plain npm installs (#350).
 *
 * `npm run build:stub` compiles stub/bastra-hook.ts with deno on hosts that
 * have the toolchain; every other install falls back to `node <thin client>`
 * and pays the interpreter start on each hook call (#344). The release
 * workflow ships the binary per platform as a GitHub Release asset, and the
 * daemon package carries `stub/manifest.json` — the sha256 of every asset,
 * written in the same workflow run that built them, before `npm publish`.
 *
 * This is the installer half: offer the download once, verify it against the
 * manifest this package was installed with, place it where the adapters
 * already look (HOOK_STUB_BIN), and fall back to the node client on anything
 * that is not a verified binary. The answer is remembered in
 * ~/.bastra/hook-stub.json, so `bastra update` — which re-runs install,
 * unattended — neither asks again nor silently loses a client the user chose.
 *
 * Why no Gatekeeper step: the binary never enters the npm tarball (package.json
 * `files`), and this module fetches it with Node's own http client — neither
 * path sets the macOS quarantine attribute, so the ad-hoc signature
 * `deno compile` applies is all the binary needs (measured in #350).
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { HOOK_STUB_BIN } from "./paths.js";
import { VERSION } from "./helpers.js";
import { confirm } from "./prompt.js";
import { isEphemeralInstallPath } from "./stable-runtime.js";

const REPO = "n0mad-ai/bastra-recall";
/** Shown in the prompt — the deno runtime plus ~150 KB of our code; the arm64
 *  macOS binary is 68 MB, the others are in the same range. */
export const STUB_SIZE_HINT = "~70 MB";
export const STUB_QUESTION =
  `Download the compiled hook client (${STUB_SIZE_HINT}, one-time) so hooks start faster than on node?`;

/** The deno target triples the release workflow builds (publish-npm.yml). */
export const STUB_TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
] as const;
export type StubTarget = (typeof STUB_TARGETS)[number];

/** The release asset for this host, or null when none is built for it —
 *  Windows stays on the node client until its milestone (the stub spawns
 *  sh/ps, which do not exist there). */
export function stubTarget(platform: string = process.platform, arch: string = process.arch): StubTarget | null {
  if (platform === "darwin") {
    return arch === "arm64" ? "aarch64-apple-darwin" : arch === "x64" ? "x86_64-apple-darwin" : null;
  }
  if (platform === "linux") {
    return arch === "x64" ? "x86_64-unknown-linux-gnu" : arch === "arm64" ? "aarch64-unknown-linux-gnu" : null;
  }
  return null;
}

export interface StubManifest {
  version: string;
  assets: Record<string, { file: string; sha256: string }>;
}

/** Strict shape check — a manifest that does not parse is the same as none:
 *  the installer then offers nothing rather than downloading unverifiable bytes. */
export function parseStubManifest(raw: string): StubManifest | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.version !== "string" || typeof d.assets !== "object" || d.assets === null) return null;
  const assets: StubManifest["assets"] = {};
  for (const [target, v] of Object.entries(d.assets as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) return null;
    const { file, sha256 } = v as Record<string, unknown>;
    // Asset names are bastra-hook-<triple> and nothing else — the manifest
    // decides what the installer fetches, so it must not be able to name paths.
    if (typeof file !== "string" || !/^bastra-hook-[A-Za-z0-9_.-]+$/.test(file)) return null;
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sha256)) return null;
    assets[target] = { file, sha256: sha256.toLowerCase() };
  }
  return { version: d.version, assets };
}

export async function readStubManifest(path: string): Promise<StubManifest | null> {
  try {
    return parseStubManifest(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export function stubManifestPath(stubBin: string = HOOK_STUB_BIN): string {
  return join(dirname(stubBin), "manifest.json");
}

export function stubAssetUrl(version: string, file: string): string {
  return `https://github.com/${REPO}/releases/download/v${version}/${file}`;
}

// ─── the remembered answer ───────────────────────────────────────

export function stubMarkerPath(): string {
  return process.env.BASTRA_HOOK_STUB_MARKER_PATH ?? join(homedir(), ".bastra", "hook-stub.json");
}

interface StubMarker {
  optIn: boolean;
  decidedAt: string;
  target?: string;
  version?: string;
}

/** true/false = a remembered decision; null = never asked. */
export async function readStubOptIn(path: string = stubMarkerPath()): Promise<boolean | null> {
  try {
    const d = JSON.parse(await readFile(path, "utf8")) as Partial<StubMarker>;
    return typeof d.optIn === "boolean" ? d.optIn : null;
  } catch {
    return null;
  }
}

async function writeStubMarker(path: string, marker: StubMarker): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`);
  } catch {
    // Best effort — a missing marker only means the question is asked again.
  }
}

// ─── decision ────────────────────────────────────────────────────

/** `--stub` = yes, `--no-stub` = skip, flag absent = ask (once). */
export type StubMode = "ask" | "yes" | "skip";
export type StubDecision =
  | "present"
  | "skip"
  | "ephemeral"
  | "no-manifest"
  | "unsupported"
  | "dry-run"
  | "download"
  | "declined"
  | "non-interactive"
  | "ask";

/**
 * Pure — exported for tests.
 *
 * Precedence (#537): the explicit flag beats the remembered choice, which beats
 * mere artifact presence. `present` used to be checked first, so `--no-stub`
 * against an already downloaded binary reported "compiled hook client present"
 * and every adapter went on registering that binary — the documented opt-out
 * could not be taken once the download had happened, and neither could the
 * remembered no be honoured. Presence now decides only what an unforced run
 * does, and only after both explicit answers are out of the way.
 *
 * Retaining the file and selecting it are different concerns: nothing here
 * deletes a downloaded binary, `--stub` simply selects it again.
 */
export function decideStubAction(i: {
  present: boolean;
  mode: StubMode;
  ephemeral: boolean;
  manifest: boolean;
  target: boolean;
  dryRun: boolean;
  remembered: boolean | null;
  interactive: boolean;
}): StubDecision {
  if (i.mode === "skip") return "skip";
  // An earlier no is never asked again — and, since #537, never overruled by a
  // binary that is merely lying there. Only `--stub` reverses it.
  if (i.mode !== "yes" && i.remembered === false) return "declined";
  if (i.present) return "present";
  if (i.ephemeral) return "ephemeral";
  if (!i.manifest) return "no-manifest";
  if (!i.target) return "unsupported";
  if (i.dryRun) return "dry-run";
  if (i.mode === "yes" || i.remembered === true) return "download";
  if (!i.interactive) return "non-interactive";
  return "ask";
}

// ─── download ────────────────────────────────────────────────────

/** Streams the asset to `<dest>.partial`, hashing as it goes; only a digest
 *  that matches the manifest is renamed into place. Anything else — HTTP
 *  error, mismatch, a dropped connection — leaves no file behind. */
export async function downloadVerified(
  url: string,
  expectedSha256: string,
  dest: string,
  io: { fetch?: typeof fetch } = {},
): Promise<{ ok: true; bytes: number } | { ok: false; reason: string }> {
  const partial = `${dest}.partial`;
  try {
    const resp = await (io.fetch ?? fetch)(url);
    if (!resp.ok || !resp.body) return { ok: false, reason: `HTTP ${resp.status}` };
    await mkdir(dirname(dest), { recursive: true });
    const hash = createHash("sha256");
    let bytes = 0;
    await pipeline(
      Readable.fromWeb(resp.body as WebReadableStream),
      async function* (source) {
        for await (const chunk of source as AsyncIterable<Uint8Array>) {
          hash.update(chunk);
          bytes += chunk.byteLength;
          yield chunk;
        }
      },
      createWriteStream(partial),
    );
    if (hash.digest("hex") !== expectedSha256) {
      await rm(partial, { force: true });
      return { ok: false, reason: "sha256 mismatch against the package manifest — download discarded" };
    }
    await rename(partial, dest);
    await chmod(dest, 0o755);
    return { ok: true, bytes };
  } catch (err) {
    await rm(partial, { force: true }).catch(() => undefined);
    return { ok: false, reason: (err as Error).message };
  }
}

// ─── the install step ────────────────────────────────────────────

export interface StubStepResult {
  status: "present" | "installed" | "skipped" | "failed";
  detail: string;
  /**
   * Which hook client this registration run must use (#537). The adapters used
   * to probe the disk for themselves, which is why `--no-stub` still produced
   * stub hook commands. Now the decision is made once, here, and handed down
   * through InstallOpts.useStub — true only when a verified binary is both
   * present and selected.
   */
  useStub: boolean;
}

/**
 * Runs before the Claude Code adapter plans its hook entries — registration
 * prefers the stub only when the binary already exists on disk. Never throws
 * and never fails the install: every outcome short of a verified binary is a
 * one-line reason plus the node client. `io` is injectable for tests.
 */
export async function ensureHookStub(
  i: {
    dryRun: boolean;
    mode: StubMode;
    interactive: boolean;
    version?: string;
    target?: StubTarget | null;
    stubBin?: string;
    markerPath?: string;
  },
  io: {
    ask?: (question: string, opts: { defaultYes?: boolean }) => Promise<boolean>;
    fetch?: typeof fetch;
    log?: (line: string) => void;
  } = {},
): Promise<StubStepResult> {
  const stubBin = i.stubBin ?? HOOK_STUB_BIN;
  const markerPath = i.markerPath ?? stubMarkerPath();
  const version = i.version ?? VERSION;
  const target = i.target === undefined ? stubTarget() : i.target;
  const manifest = await readStubManifest(stubManifestPath(stubBin));
  const asset = target && manifest ? manifest.assets[target] : undefined;
  const decision = decideStubAction({
    present: existsSync(stubBin),
    mode: i.mode,
    ephemeral: isEphemeralInstallPath(stubBin),
    manifest: manifest !== null,
    target: asset !== undefined,
    dryRun: i.dryRun,
    remembered: await readStubOptIn(markerPath),
    interactive: i.interactive,
  });
  const onNode = "hooks run on the node client";

  switch (decision) {
    case "present":
      // `--stub` on an installation that had opted out is a reversal, not a
      // no-op: persist it, or the next unattended `bastra update` would read
      // the stale no and put the hooks back on the node client (#537).
      if (i.mode === "yes" && !i.dryRun) {
        await writeStubMarker(markerPath, { optIn: true, decidedAt: new Date().toISOString(), target: target ?? undefined, version });
      }
      return { status: "present", detail: `compiled hook client present (${stubBin})`, useStub: true };
    case "skip":
      if (!i.dryRun) await writeStubMarker(markerPath, { optIn: false, decidedAt: new Date().toISOString() });
      return {
        status: "skipped",
        useStub: false,
        detail: existsSync(stubBin)
          ? `--no-stub: ${onNode} (remembered; the downloaded binary is kept — pass --stub to use it again)`
          : `--no-stub: ${onNode} (remembered; pass --stub to change)`,
      };
    case "ephemeral":
      return {
        status: "skipped",
        useStub: false,
        detail: `npx runtime — the compiled hook client needs a permanent install (npm install -g bastra-recall); ${onNode}`,
      };
    case "no-manifest":
      return {
        status: "skipped",
        useStub: false,
        detail: `no stub manifest in this package (source checkout? build it with \`npm run build:stub\`); ${onNode}`,
      };
    case "unsupported":
      return { status: "skipped", useStub: false, detail: `no compiled hook client for ${process.platform}/${process.arch}; ${onNode}` };
    case "dry-run":
      return { status: "skipped", useStub: false, detail: `~ would offer the compiled hook client for ${target} (${STUB_SIZE_HINT}) (dry-run)` };
    case "declined":
      return { status: "skipped", useStub: false, detail: `compiled hook client declined earlier; ${onNode} (pass --stub to download)` };
    case "non-interactive":
      return { status: "skipped", useStub: false, detail: `non-interactive: pass --stub to download the compiled hook client; ${onNode}` };
    case "ask": {
      const accepted = await (io.ask ?? confirm)(STUB_QUESTION, { defaultYes: true });
      if (!accepted) {
        await writeStubMarker(markerPath, { optIn: false, decidedAt: new Date().toISOString() });
        return { status: "skipped", useStub: false, detail: `declined; ${onNode} (re-run with --stub to download later)` };
      }
      break;
    }
    case "download":
      break;
  }
  if (!target || !asset) return { status: "skipped", useStub: false, detail: `no compiled hook client for this host; ${onNode}` };

  // The decision is the user's, not the download's: remembered before the
  // fetch, so a transient failure retries on the next install instead of
  // being mistaken for a no.
  await writeStubMarker(markerPath, { optIn: true, decidedAt: new Date().toISOString(), target, version });
  const log = io.log ?? ((line: string) => process.stdout.write(line));
  log(`  · hook client: downloading ${asset.file} (${STUB_SIZE_HINT}) from GitHub releases…\n`);
  const r = await downloadVerified(stubAssetUrl(version, asset.file), asset.sha256, stubBin, { fetch: io.fetch });
  if (!r.ok) return { status: "failed", useStub: false, detail: `could not fetch the compiled hook client (${r.reason}); ${onNode}` };
  return {
    status: "installed",
    useStub: true,
    detail: `compiled hook client installed (${(r.bytes / 1_048_576).toFixed(0)} MB, sha256 verified against the package manifest)`,
  };
}
