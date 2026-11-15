/**
 * Tests for the first-run vault step of `bastra install` (#178): the pure
 * TTY/flag decision matrix, the ~/BastraVault creation helper, and the step's
 * refusal / failed-creation paths (non-zero exit, today's error text).
 *
 * The step is exercised with injected ask/create so no test needs a TTY and
 * nothing ever touches the real HOME.
 *
 * Run: npx tsx --test packages/daemon/__tests__/install-vault-firstrun.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  createVaultAt,
  decideFirstRunVaultAction,
  defaultVaultPath,
  DEFAULT_VAULT_DIRNAME,
  VAULT_REQUIRED_ERROR,
} from "../src/cli/helpers.js";
import { installVaultFirstRunStep, FIRST_RUN_VAULT_QUESTION } from "../src/cli/commands.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-vault-firstrun-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** Captures stdout+stderr for the duration of fn. */
async function withCapture<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// ─── decision matrix (pure, no TTY needed) ───────────────────────────────────

test("first-run vault: a resolvable vault wins over every flag — never ask", () => {
  for (const interactive of [true, false]) {
    for (const yes of [true, false]) {
      for (const dryRun of [true, false]) {
        const a = decideFirstRunVaultAction({ vaultConfigured: true, interactive, yes, dryRun });
        assert.equal(a, "proceed");
      }
    }
  }
});

test("first-run vault: interactive TTY without flags → ask once", () => {
  const a = decideFirstRunVaultAction({ vaultConfigured: false, interactive: true, yes: false, dryRun: false });
  assert.equal(a, "prompt");
});

test("first-run vault: non-TTY never prompts — today's deterministic error", () => {
  const a = decideFirstRunVaultAction({ vaultConfigured: false, interactive: false, yes: false, dryRun: false });
  assert.equal(a, "error");
});

test("first-run vault: --yes suppresses the prompt — today's deterministic error", () => {
  const a = decideFirstRunVaultAction({ vaultConfigured: false, interactive: true, yes: true, dryRun: false });
  assert.equal(a, "error");
});

test("first-run vault: interactive --dry-run reports the offer, creates nothing", () => {
  const a = decideFirstRunVaultAction({ vaultConfigured: false, interactive: true, yes: false, dryRun: true });
  assert.equal(a, "would-create");
});

test("first-run vault: --yes/non-TTY beat --dry-run (a dry-run reports what the real invocation would do)", () => {
  assert.equal(
    decideFirstRunVaultAction({ vaultConfigured: false, interactive: true, yes: true, dryRun: true }),
    "error"
  );
  assert.equal(
    decideFirstRunVaultAction({ vaultConfigured: false, interactive: false, yes: false, dryRun: true }),
    "error"
  );
});

// ─── vault-creation helper (temp HOME) ───────────────────────────────────────

test("defaultVaultPath: <home>/BastraVault", () => {
  assert.equal(defaultVaultPath("/tmp/home-x"), resolve("/tmp/home-x", DEFAULT_VAULT_DIRNAME));
});

test("createVaultAt: creates the folder plus a README that explains what it holds", async () => {
  await withTempDir(async (home) => {
    const target = defaultVaultPath(home);
    const r = await createVaultAt(target);
    assert.ok(!("error" in r), `expected success, got ${JSON.stringify(r)}`);
    assert.equal((r as { path: string }).path, target);
    const readme = await readFile(join(target, "README.md"), "utf8");
    assert.match(readme, /memory vault/);
    assert.match(readme, /--vault <path>/);
  });
});

test("createVaultAt: idempotent — an existing README is never overwritten", async () => {
  await withTempDir(async (home) => {
    const target = defaultVaultPath(home);
    await createVaultAt(target);
    await writeFile(join(target, "README.md"), "user-edited\n", "utf8");
    const r = await createVaultAt(target);
    assert.ok(!("error" in r));
    assert.equal(await readFile(join(target, "README.md"), "utf8"), "user-edited\n");
  });
});

test("createVaultAt: creation failure returns an error instead of throwing", async () => {
  await withTempDir(async (home) => {
    // A FILE occupies the target path → mkdir fails (EEXIST/ENOTDIR).
    const target = join(home, DEFAULT_VAULT_DIRNAME);
    await writeFile(target, "in the way\n", "utf8");
    const r = await createVaultAt(target);
    assert.ok("error" in r);
    assert.ok((r as { error: string }).error.length > 0);
  });
});

// ─── the step itself (injected ask/create — no TTY, no real HOME) ────────────

test("install step: accepted prompt creates the vault and hands the path to the install opts", async () => {
  const asked: string[] = [];
  const { result, out } = await withCapture(() =>
    installVaultFirstRunStep(
      { vaultConfigured: false, interactive: true, yes: false, dryRun: false },
      {
        ask: async (q) => {
          asked.push(q);
          return true;
        },
        create: async () => ({ path: "/tmp/home-x/BastraVault" }),
      }
    )
  );
  assert.deepEqual(asked, [FIRST_RUN_VAULT_QUESTION]);
  assert.equal(result.vaultPath, "/tmp/home-x/BastraVault");
  assert.equal(result.exit, null);
  assert.match(out, /✓ created \/tmp\/home-x\/BastraVault/);
});

test("install step: refusal prints today's error text and keeps the non-zero exit", async () => {
  const { result, err } = await withCapture(() =>
    installVaultFirstRunStep(
      { vaultConfigured: false, interactive: true, yes: false, dryRun: false },
      {
        ask: async () => false,
        create: async () => {
          throw new Error("must not create on refusal");
        },
      }
    )
  );
  assert.equal(result.vaultPath, null);
  assert.equal(result.exit, 1);
  assert.ok(err.includes(`error: ${VAULT_REQUIRED_ERROR}`));
});

test("install step: failed creation falls back to today's error, non-zero exit", async () => {
  const { result, err } = await withCapture(() =>
    installVaultFirstRunStep(
      { vaultConfigured: false, interactive: true, yes: false, dryRun: false },
      { ask: async () => true, create: async () => ({ error: "EACCES: permission denied" }) }
    )
  );
  assert.equal(result.vaultPath, null);
  assert.equal(result.exit, 1);
  assert.match(err, /could not create ~\/BastraVault: EACCES/);
  assert.ok(err.includes(`error: ${VAULT_REQUIRED_ERROR}`));
});

test("install step: dry-run prints the would-line and never asks or creates", async () => {
  const { result, out } = await withCapture(() =>
    installVaultFirstRunStep(
      { vaultConfigured: false, interactive: true, yes: false, dryRun: true },
      {
        ask: async () => {
          throw new Error("must not ask under --dry-run");
        },
        create: async () => {
          throw new Error("must not create under --dry-run");
        },
      }
    )
  );
  assert.equal(result.vaultPath, null);
  assert.equal(result.exit, null);
  assert.match(out, /~ would prompt to create ~\/BastraVault \(dry-run\): no vault configured yet/);
});

test("install step: non-TTY/--yes fall through silently (per-surface error unchanged)", async () => {
  for (const i of [
    { vaultConfigured: false, interactive: false, yes: false, dryRun: false },
    { vaultConfigured: false, interactive: true, yes: true, dryRun: false },
  ]) {
    const { result, out, err } = await withCapture(() =>
      installVaultFirstRunStep(i, {
        ask: async () => {
          throw new Error("must not ask");
        },
        create: async () => {
          throw new Error("must not create");
        },
      })
    );
    assert.equal(result.vaultPath, null);
    assert.equal(result.exit, null);
    assert.equal(out, "");
    assert.equal(err, "");
  }
});

test("install step: exact prompt wording (first-run onboarding, #178)", () => {
  assert.equal(FIRST_RUN_VAULT_QUESTION, "No memory vault configured yet. Create one at ~/BastraVault?");
});
