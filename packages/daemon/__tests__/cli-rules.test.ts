/**
 * `bastra rules cursor` (#7) — the Cursor convention layer, per project.
 *
 * The design constraint this encodes: Cursor has no global rules file. User
 * Rules live in its settings UI, project rules are `.cursor/rules/*.mdc` in
 * the repo. So this command writes into a directory the user named, and
 * `bastra install` never writes rules into whatever happened to be the
 * working directory.
 *
 * Runner: `tsx --test __tests__/cli-rules.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdRules } from "../src/cli/rules-cmd.js";
import { CURSOR_RULES_SOURCE_PATH, CURSOR_RULES_RELATIVE } from "../src/cli/paths.js";
import type { ParsedArgs } from "../src/cli/types.js";

function args(positional: string[], dryRun = false): ParsedArgs {
  return {
    command: "rules",
    surface: positional[1] ?? null,
    dryRun,
    vaultPath: null,
    showHelp: false,
    showVersion: false,
    json: false,
    quiet: false,
    yes: false,
    fix: false,
    withStopHook: true,
    staged: false,
    ollama: null,
    origin: null,
    extension: false,
    exclude: [],
    follow: false,
    since: null,
    source: null,
    lines: null,
    positional,
  };
}

async function withProject(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-rules-"));
  // `cmdRules` reports progress on stdout, and under `node --test` the child's
  // stdout is the same pipe that carries the runner's v8-serialized result
  // frames. Node <= 22.23.2 / 24.19.0 read the frame length signed, so a
  // non-ASCII byte landing where a length is expected crashes the parent's
  // decoder (nodejs/node#64061). Capturing the output keeps it off that pipe.
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await fn(dir);
  } finally {
    process.stdout.write = origWrite;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("rules: the shipped template is a valid always-apply Cursor rule", async () => {
  assert.ok(CURSOR_RULES_SOURCE_PATH, "the .mdc template must ship with the package");
  const body = await readFile(CURSOR_RULES_SOURCE_PATH, "utf8");
  // Cursor only recognises .mdc with frontmatter; alwaysApply is what makes it
  // fire without an @-mention. Get either wrong and the file is inert.
  assert.ok(body.startsWith("---\n"), "must open with frontmatter");
  assert.match(body, /^alwaysApply: true$/m);
  assert.match(body, /^description: .+/m);
  // It has to name the tools, or the agent has no idea what it may call.
  for (const tool of ["recall", "load_memory", "save_memory"]) {
    assert.ok(body.includes(tool), `template never mentions ${tool}`);
  }
});

test("rules: writes into the named project, not the working directory", async () => {
  await withProject(async (dir) => {
    const rc = await cmdRules(args(["rules", "cursor", dir]));
    assert.equal(rc, 0);
    const written = await readFile(join(dir, CURSOR_RULES_RELATIVE), "utf8");
    const source = await readFile(CURSOR_RULES_SOURCE_PATH!, "utf8");
    assert.equal(written, source);
    // The extension matters: Cursor ignores .md in that folder outright.
    assert.ok(CURSOR_RULES_RELATIVE.endsWith(".mdc"));
  });
});

test("rules: running twice changes nothing the second time", async () => {
  await withProject(async (dir) => {
    await cmdRules(args(["rules", "cursor", dir]));
    const before = await readdir(join(dir, ".cursor", "rules"));
    const rc = await cmdRules(args(["rules", "cursor", dir]));
    assert.equal(rc, 0);
    const after = await readdir(join(dir, ".cursor", "rules"));
    assert.deepEqual(after, before, "an idempotent re-run must not leave a backup behind");
    assert.equal(after.length, 1);
  });
});

test("rules: an edited file is backed up, never silently overwritten", async () => {
  await withProject(async (dir) => {
    const target = join(dir, CURSOR_RULES_RELATIVE);
    await mkdir(join(dir, ".cursor", "rules"), { recursive: true });
    await writeFile(target, "---\nalwaysApply: true\n---\n\nmy own wording\n", "utf8");

    const rc = await cmdRules(args(["rules", "cursor", dir]));
    assert.equal(rc, 0);

    const files = await readdir(join(dir, ".cursor", "rules"));
    const backup = files.find((f) => f.includes(".bak-"));
    assert.ok(backup, "the user's version must survive somewhere");
    const kept = await readFile(join(dir, ".cursor", "rules", backup), "utf8");
    assert.match(kept, /my own wording/);
  });
});

test("rules: refuses to replace an edited file when the backup cannot be made", async () => {
  await withProject(async (dir) => {
    const target = join(dir, CURSOR_RULES_RELATIVE);
    await mkdir(join(dir, ".cursor", "rules"), { recursive: true });
    const mine = "---\nalwaysApply: true\n---\n\nirreplaceable\n";
    await writeFile(target, mine, "utf8");

    // Occupy the exact backup path this run will derive. Standing in for the
    // real hazard: a predictable name someone else can get to first. Without
    // "wx" the backup write would follow it and the user's version would be
    // gone with nothing kept.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await writeFile(`${target}.bak-${stamp}`, "squatter", "utf8");

    const rc = await cmdRules(args(["rules", "cursor", dir]));

    // Either the backup path was taken (refuse, rc=1) or the timestamp had
    // already ticked (proceed, rc=0) — the invariant that must hold in both
    // cases is that the user's wording still exists somewhere.
    const files = await readdir(join(dir, ".cursor", "rules"));
    const bodies = await Promise.all(
      files.map((f) => readFile(join(dir, ".cursor", "rules", f), "utf8")),
    );
    assert.ok(
      bodies.some((b) => b.includes("irreplaceable")),
      `rc=${rc}: the user's version vanished — files: ${files.join(", ")}`,
    );
  });
});

test("rules: dry-run writes nothing at all", async () => {
  await withProject(async (dir) => {
    const rc = await cmdRules(args(["rules", "cursor", dir], true));
    assert.equal(rc, 0);
    await assert.rejects(() => readdir(join(dir, ".cursor")), "dry-run must not create the folder");
  });
});

test("rules: remove takes it back out", async () => {
  await withProject(async (dir) => {
    await cmdRules(args(["rules", "cursor", dir]));
    const rc = await cmdRules(args(["rules", "remove", "cursor", dir]));
    assert.equal(rc, 0);
    assert.deepEqual(await readdir(join(dir, ".cursor", "rules")), []);
    // Removing what is not there is a success, not an error — uninstall paths
    // get run twice all the time.
    assert.equal(await cmdRules(args(["rules", "remove", "cursor", dir])), 0);
  });
});

test("rules: refuses surfaces that have no rules layer, and missing directories", async () => {
  // Claude surfaces use the skill; saying "ok" here would be a silent no-op.
  assert.equal(await cmdRules(args(["rules", "claude-code"])), 2);
  assert.equal(await cmdRules(args(["rules"])), 2);
  assert.equal(await cmdRules(args(["rules", "cursor", join(tmpdir(), "bastra-nope-4f2a")])), 2);
});
