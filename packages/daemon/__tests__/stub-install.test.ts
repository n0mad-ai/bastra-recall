/**
 * Tests for the compiled hook client on npm installs (#350):
 *   - stubTarget — host → release asset
 *   - parseStubManifest — strict shape; anything else reads as "no manifest"
 *   - decideStubAction — the full decision table
 *   - ensureHookStub — download verified against the manifest, fallback on
 *     mismatch/HTTP error, the remembered answer, dry-run
 *   - stub-manifest.mjs — checksum files → manifest the installer reads
 *   - --stub / --no-stub parsing
 *
 * Runner: `tsx --test __tests__/stub-install.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideStubAction,
  ensureHookStub,
  parseStubManifest,
  readStubOptIn,
  stubAssetUrl,
  stubTarget,
} from "../src/cli/stub-install.js";
import { buildManifest, parseChecksumFile } from "../scripts/stub-manifest.mjs";
import { parseArgs } from "../src/cli/commands.js";

const HEX = "a".repeat(64);

test("stubTarget maps the four shipped hosts and nothing else", () => {
  assert.equal(stubTarget("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(stubTarget("darwin", "x64"), "x86_64-apple-darwin");
  assert.equal(stubTarget("linux", "x64"), "x86_64-unknown-linux-gnu");
  assert.equal(stubTarget("linux", "arm64"), "aarch64-unknown-linux-gnu");
  assert.equal(stubTarget("win32", "x64"), null, "Windows stays on the node client until its milestone");
  assert.equal(stubTarget("linux", "ia32"), null);
});

test("parseStubManifest is strict — a malformed manifest reads as no manifest", () => {
  const good = {
    version: "1.2.3",
    assets: { "aarch64-apple-darwin": { file: "bastra-hook-aarch64-apple-darwin", sha256: HEX.toUpperCase() } },
  };
  const parsed = parseStubManifest(JSON.stringify(good));
  assert.equal(parsed?.version, "1.2.3");
  assert.equal(parsed?.assets["aarch64-apple-darwin"]?.sha256, HEX, "digests normalize to lowercase");
  assert.equal(parseStubManifest("not json"), null);
  assert.equal(parseStubManifest(JSON.stringify({ assets: {} })), null, "version is required");
  assert.equal(
    parseStubManifest(JSON.stringify({ version: "1", assets: { t: { file: "bastra-hook-t", sha256: "short" } } })),
    null,
  );
  assert.equal(
    parseStubManifest(JSON.stringify({ version: "1", assets: { t: { file: "../evil", sha256: HEX } } })),
    null,
    "asset names are bastra-hook-* only — the manifest must not be able to name paths",
  );
});

test("stubAssetUrl is version-locked to the GitHub release", () => {
  assert.equal(
    stubAssetUrl("0.9.1", "bastra-hook-x86_64-unknown-linux-gnu"),
    "https://github.com/n0mad-ai/bastra-recall/releases/download/v0.9.1/bastra-hook-x86_64-unknown-linux-gnu",
  );
});

test("decideStubAction — the explicit flag, then the remembered answer, then what is present", () => {
  const base = {
    present: false,
    mode: "ask" as const,
    ephemeral: false,
    manifest: true,
    target: true,
    dryRun: false,
    remembered: null,
    interactive: true,
  };
  // #537: the explicit opt-out is read BEFORE the binary on disk. This line
  // used to assert "present" — that is the defect: `--no-stub` could not be
  // taken once a download had happened.
  assert.equal(decideStubAction({ ...base, present: true, mode: "skip" }), "skip");
  assert.equal(decideStubAction({ ...base, mode: "skip" }), "skip");
  assert.equal(
    decideStubAction({ ...base, present: true, remembered: false }),
    "declined",
    "#537: a remembered no also outranks a binary that is merely lying there",
  );
  assert.equal(decideStubAction({ ...base, ephemeral: true, mode: "yes" }), "ephemeral");
  assert.equal(decideStubAction({ ...base, manifest: false, mode: "yes" }), "no-manifest");
  assert.equal(decideStubAction({ ...base, target: false, mode: "yes" }), "unsupported");
  assert.equal(decideStubAction({ ...base, dryRun: true, mode: "yes" }), "dry-run");
  assert.equal(decideStubAction({ ...base, mode: "yes", interactive: false }), "download");
  assert.equal(
    decideStubAction({ ...base, remembered: true, interactive: false }),
    "download",
    "an earlier yes re-downloads unattended — bastra update re-runs install",
  );
  assert.equal(decideStubAction({ ...base, remembered: false }), "declined", "an earlier no is never asked again");
  assert.equal(decideStubAction({ ...base, interactive: false }), "non-interactive");
  assert.equal(decideStubAction(base), "ask");
});

// ─── ensureHookStub against a temp package root ──────────────────

const TARGET = "x86_64-unknown-linux-gnu";
const BODY = Buffer.from("#!/bin/sh\necho '{}'\n");
const manifestFor = (sha256: string) => ({
  version: "9.9.9",
  assets: { [TARGET]: { file: `bastra-hook-${TARGET}`, sha256 } },
});

async function fixture(manifest?: object) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-stub-"));
  await mkdir(join(dir, "stub"), { recursive: true });
  if (manifest) await writeFile(join(dir, "stub", "manifest.json"), JSON.stringify(manifest));
  return { stubBin: join(dir, "stub", "bastra-hook"), markerPath: join(dir, "home", "hook-stub.json") };
}

const fetchReturning = (bytes: Buffer, status = 200) =>
  (async (url: string | URL | Request) => {
    assert.equal(String(url), stubAssetUrl("9.9.9", `bastra-hook-${TARGET}`));
    return new Response(status === 200 ? bytes : null, { status });
  }) as unknown as typeof fetch;

const inputs = (f: { stubBin: string; markerPath: string }, mode: "ask" | "yes" | "skip", interactive: boolean, dryRun = false) => ({
  dryRun,
  mode,
  interactive,
  version: "9.9.9",
  target: TARGET as const,
  stubBin: f.stubBin,
  markerPath: f.markerPath,
});

test("ensureHookStub: a verified download lands at the stub path, executable, and the yes is remembered", async () => {
  const f = await fixture(manifestFor(createHash("sha256").update(BODY).digest("hex")));
  const lines: string[] = [];
  const r = await ensureHookStub(inputs(f, "ask", true), {
    ask: async () => true,
    fetch: fetchReturning(BODY),
    log: (l) => lines.push(l),
  });
  assert.equal(r.status, "installed", r.detail);
  assert.equal(await readFile(f.stubBin, "utf8"), BODY.toString());
  assert.ok((await stat(f.stubBin)).mode & 0o111, "executable");
  assert.equal(await readStubOptIn(f.markerPath), true);
  assert.match(lines.join(""), /downloading bastra-hook-x86_64-unknown-linux-gnu/);
  assert.equal(existsSync(`${f.stubBin}.partial`), false);
});

test("ensureHookStub: a checksum mismatch discards the download and leaves the node client", async () => {
  const f = await fixture(manifestFor(HEX));
  const r = await ensureHookStub(inputs(f, "yes", false), { fetch: fetchReturning(BODY), log: () => undefined });
  assert.equal(r.status, "failed");
  assert.match(r.detail, /sha256 mismatch/);
  assert.equal(existsSync(f.stubBin), false);
  assert.equal(existsSync(`${f.stubBin}.partial`), false);
  assert.equal(await readStubOptIn(f.markerPath), true, "--stub is the user's decision; the next install retries");
});

test("ensureHookStub: an HTTP error is a visible fallback, not a crash", async () => {
  const f = await fixture(manifestFor(HEX));
  const r = await ensureHookStub(inputs(f, "yes", false), { fetch: fetchReturning(BODY, 404), log: () => undefined });
  assert.equal(r.status, "failed");
  assert.match(r.detail, /HTTP 404/);
  assert.equal(existsSync(f.stubBin), false);
});

test("ensureHookStub: no manifest (source checkout) offers nothing and never asks or fetches", async () => {
  const f = await fixture();
  const r = await ensureHookStub(inputs(f, "ask", true), {
    ask: async () => {
      throw new Error("must not ask");
    },
    fetch: (async () => {
      throw new Error("must not fetch");
    }) as unknown as typeof fetch,
  });
  assert.equal(r.status, "skipped");
  assert.match(r.detail, /no stub manifest/);
});

test("ensureHookStub: a declined offer is remembered, --no-stub records the opt-out, a present binary short-circuits", async () => {
  const f = await fixture(manifestFor(HEX));
  let asked = 0;
  const declined = await ensureHookStub(inputs(f, "ask", true), {
    ask: async () => {
      asked++;
      return false;
    },
  });
  assert.equal(declined.status, "skipped");
  assert.equal(await readStubOptIn(f.markerPath), false);
  const again = await ensureHookStub(inputs(f, "ask", true), {
    ask: async () => {
      asked++;
      return false;
    },
  });
  assert.equal(again.status, "skipped");
  assert.match(again.detail, /declined earlier/);
  assert.equal(asked, 1, "asked exactly once");

  const g = await fixture(manifestFor(HEX));
  const optOut = await ensureHookStub(inputs(g, "skip", true));
  assert.equal(optOut.status, "skipped");
  assert.match(optOut.detail, /--no-stub/);
  assert.equal(await readStubOptIn(g.markerPath), false);

  // #537: the binary now exists, but the remembered no still decides — the
  // artifact is kept, it is simply not registered.
  await writeFile(g.stubBin, BODY);
  const stillDeclined = await ensureHookStub(inputs(g, "ask", true));
  assert.equal(stillDeclined.status, "skipped");
  assert.equal(stillDeclined.useStub, false);
  assert.equal(existsSync(g.stubBin), true, "the downloaded binary must not be deleted");

  const h = await fixture(manifestFor(HEX));
  await writeFile(h.stubBin, BODY);
  const present = await ensureHookStub(inputs(h, "ask", true));
  assert.equal(present.status, "present");
  assert.equal(present.useStub, true);
});

test("ensureHookStub: dry-run describes the offer and writes nothing", async () => {
  const f = await fixture(manifestFor(HEX));
  const r = await ensureHookStub(inputs(f, "yes", false, true));
  assert.equal(r.status, "skipped");
  assert.match(r.detail, /would offer/);
  assert.equal(existsSync(f.markerPath), false);
});

test("ensureHookStub: a host without an asset is a one-line skip, even with --stub", async () => {
  const f = await fixture(manifestFor(HEX));
  const r = await ensureHookStub({ ...inputs(f, "yes", false), target: null });
  assert.equal(r.status, "skipped");
  assert.match(r.detail, /no compiled hook client for/);
});

// ─── stub-manifest.mjs ───────────────────────────────────────────

test("stub-manifest.mjs: checksum files become the manifest; the asset name comes from the file name", () => {
  const e = parseChecksumFile("bastra-hook-aarch64-apple-darwin.sha256", `${HEX}  bastra-hook-aarch64-apple-darwin\n`);
  assert.deepEqual(e, { target: "aarch64-apple-darwin", file: "bastra-hook-aarch64-apple-darwin", sha256: HEX });
  assert.equal(parseChecksumFile("bastra-hook-aarch64-apple-darwin.sha256", "<html>404</html>"), null);
  assert.equal(parseChecksumFile("notes.sha256", HEX), null);
  assert.equal(
    parseChecksumFile("bastra-hook-x86_64-unknown-linux-gnu.sha256", `${"B".repeat(64)}  x`)?.sha256,
    "b".repeat(64),
  );
  assert.ok(e);
  const m = buildManifest("1.2.3", [e]);
  assert.equal(
    parseStubManifest(JSON.stringify(m))?.assets["aarch64-apple-darwin"]?.file,
    "bastra-hook-aarch64-apple-darwin",
    "what the script writes, the installer reads",
  );
});

test("--stub / --no-stub parse; absent means ask once", () => {
  assert.equal(parseArgs(["install", "claude-code", "--stub"]).stub, "yes");
  assert.equal(parseArgs(["install", "claude-code", "--no-stub"]).stub, "skip");
  assert.equal(parseArgs(["install", "claude-code"]).stub, null);
});
