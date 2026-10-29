import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { inspectBootstrap, ensureBootstrap, describeBootstrap, BOOTSTRAP_START, BOOTSTRAP_END } from "../src/cli/bootstrap.js";
import { parseArgs } from "../src/cli/commands.js";

const gen = await import(new URL("../../../scripts/build-skill-projections.mjs", import.meta.url).href);
const canonical = await readFile(new URL("../../skill/SKILL.md", import.meta.url), "utf8");
const projection = gen.renderBootstrapBlock(canonical);
const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const oldBody = "Old invented convention; use load_memory.";
const old = `${BOOTSTRAP_START}\n<!-- GENERATED SKILL.md bastra-recall:hash 0123456789abcdef/${hash(oldBody)} -->\n${oldBody}\n${BOOTSTRAP_END}`;
async function fixture(run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "bootstrap-1314-"));
  try { await run(join(dir, "AGENTS.md")); } finally { await rm(dir, { recursive: true, force: true }); }
}
const opts = (path: string) => ({ path, projection, dryRun: false });

test("#1314 canonical bootstrap projection is deterministic, committed and <=600 characters including hash and markers", async () => {
  assert.equal(await readFile(gen.PROJECTIONS.bootstrapBlock, "utf8"), projection);
  assert.equal(gen.renderBootstrapBlock(canonical), projection);
  assert.ok(projection.length <= 600);
  assert.match(projection, /load_memory/);
  assert.match(projection, new RegExp(gen.canonicalHash(canonical)));
  assert.equal(inspectBootstrap(projection, projection).state, "current");
});

test("#1314 consent decline, disabled flag and unattended default leave user bytes intact", async () => fixture(async path => {
  const user = "# Nutzerregel\r\nGrüße, unverändert.";
  await writeFile(path, user);
  let asked = 0;
  const ask = async () => { asked++; return false; };
  for (const extra of [{ interactive: true, ask }, { withBootstrap: false, interactive: true, ask }, { interactive: false, ask }]) {
    assert.equal((await ensureBootstrap("codex", "install", { ...opts(path), ...extra })).changed, false);
    assert.equal(await readFile(path, "utf8"), user);
  }
  assert.equal(asked, 1);
}));

test("#1314 interactive consent shows exact target/content and explicit yes writes once", async () => fixture(async path => {
  const result = await ensureBootstrap("codex", "install", { ...opts(path), interactive: true, ask: async question => {
    assert.ok(question.includes(path)); assert.ok(question.includes(projection)); return true;
  } });
  assert.equal(result.changed, true);
  assert.equal(await readFile(path, "utf8"), projection);
  assert.equal((await ensureBootstrap("codex", "install", { ...opts(path), withBootstrap: true })).changed, false);
}));

test("#1314 update/reinstall/removal preserve CRLF and no-final-newline user bytes around the region", async () => fixture(async path => {
  const before = "# Private Grüße\r\nnever lose this";
  const after = "\r\n## Other instruction\r\n";
  await writeFile(path, before + old + after);
  assert.equal((await ensureBootstrap("codex", "install", { ...opts(path), withBootstrap: true })).changed, true);
  assert.equal(await readFile(path, "utf8"), before + projection + after);
  assert.equal((await ensureBootstrap("codex", "install", { ...opts(path), withBootstrap: true })).changed, false);
  assert.equal((await ensureBootstrap("codex", "uninstall", opts(path))).changed, true);
  assert.equal(await readFile(path, "utf8"), before + after);
  assert.equal((await ensureBootstrap("codex", "uninstall", opts(path))).changed, false);
}));

test("#1314 first append and uninstall round-trip original bytes including missing final newline", async () => fixture(async path => {
  const bytes = Buffer.from("Some user text\r\nü no newline");
  await writeFile(path, bytes);
  await ensureBootstrap("codex", "install", { ...opts(path), withBootstrap: true });
  await ensureBootstrap("codex", "uninstall", opts(path));
  assert.deepEqual(await readFile(path), bytes);
}));

test("#1314 malformed/duplicate markers are diagnosed and untouched for install and uninstall", async () => fixture(async path => {
  for (const content of [BOOTSTRAP_START, BOOTSTRAP_END, projection + projection, BOOTSTRAP_END + BOOTSTRAP_START]) {
    await writeFile(path, content);
    for (const action of ["install", "uninstall"] as const) {
      const result = await ensureBootstrap("codex", action, { ...opts(path), withBootstrap: true });
      assert.equal(result.changed, false); assert.match(result.detail, /malformed/);
      assert.equal(await readFile(path, "utf8"), content);
    }
  }
}));

test("#1314 doctor distinguishes missing, stale and hand-modified blocks without mutation", async () => fixture(async path => {
  for (const [content, state] of [["", "missing"], [old, "stale"], [projection.replace("persistent", "changed"), "modified"], [projection, "current"]]) {
    await writeFile(path, content);
    assert.equal(inspectBootstrap(content, projection).state, state);
    assert.match(await describeBootstrap("codex", { path, projection }), new RegExp(`^${state}:`));
    assert.equal(await readFile(path, "utf8"), content);
  }
}));

test("#1314 Claude skips any unmanaged Recall line even with explicit consent; managed updates still work", async () => fixture(async path => {
  const user = "# Existing\nUse bastra-recall myself\n";
  for (const content of [user, user + old]) {
    await writeFile(path, content);
    const result = await ensureBootstrap("claude-code", "install", { ...opts(path), withBootstrap: true });
    assert.equal(result.changed, false); assert.match(result.detail, /unmanaged/);
    assert.equal(await readFile(path, "utf8"), content);
  }
  await writeFile(path, old);
  assert.equal((await ensureBootstrap("claude-code", "install", { ...opts(path), withBootstrap: true })).changed, true);
  assert.equal(await readFile(path, "utf8"), projection);
}));

test("#1314 doctor reports override shadowing and bootstrap exceeding configured byte budget", async () => fixture(async path => {
  await writeFile(path, "ü".repeat(100) + projection);
  await writeFile(join(path, "..", "AGENTS.override.md"), "Override\n");
  await writeFile(join(path, "..", "config.toml"), 'project_doc_max_bytes = 128\nproject_doc_fallback_filenames = ["TEAM.md"]\n');
  const report = await describeBootstrap("codex", { path, projection });
  assert.match(report, /SHADOWED/); assert.match(report, /beyond budget/); assert.match(report, /TEAM.md/);
  assert.match(report, /runtime loading and compliance unverified/);
}));

test("#1314 dry-run previews exact authorized region without changing the file", async () => fixture(async path => {
  await writeFile(path, "user text");
  const result = await ensureBootstrap("codex", "install", { ...opts(path), dryRun: true, withBootstrap: true });
  assert.match(result.detail, /would write/); assert.ok(result.detail.includes(projection));
  assert.equal(await readFile(path, "utf8"), "user text");
}));

test("#1314 invalid UTF8 and symlinks cannot corrupt unmanaged bytes", async () => fixture(async path => {
  await writeFile(path, Buffer.from([255, 254]));
  assert.equal((await ensureBootstrap("codex", "install", { ...opts(path), withBootstrap: true })).error, true);
  assert.deepEqual(await readFile(path), Buffer.from([255, 254]));
  if (process.platform !== "win32") {
    await symlink(path, path + ".link");
    assert.equal((await ensureBootstrap("codex", "install", { ...opts(path + ".link"), withBootstrap: true })).error, true);
  }
}));

test("#1314 CLI consent is independent from --yes and recognized by install", () => {
  assert.equal(parseArgs(["install", "codex", "--yes"]).withBootstrap, undefined);
  const enabled = parseArgs(["install", "codex", "--with-bootstrap"]);
  assert.equal(enabled.withBootstrap, true); assert.deepEqual(enabled.errors, []);
  assert.equal(parseArgs(["install", "codex", "--no-bootstrap"]).withBootstrap, false);
});


test("#1314 consent cannot overwrite user edits made while the prompt is open", async () => fixture(async path => {
  await writeFile(path, "before consent");
  const result = await ensureBootstrap("codex", "install", { ...opts(path), interactive: true, ask: async () => {
    await writeFile(path, "edited during consent"); return true;
  } });
  assert.equal(result.changed, false); assert.equal(result.error, true);
  assert.match(result.detail, /changed while awaiting/);
  assert.equal(await readFile(path, "utf8"), "edited during consent");
}));


test("#1314 bootstrap uses active Codex and Claude profile roots, never the default profile", async () => fixture(async path => {
  const module = new URL("../src/cli/bootstrap.ts", import.meta.url).href;
  const codexHome = join(path, "..", "other-codex");
  const claudeHome = join(path, "..", "other-claude");
  const program = `const {bootstrapPath}=await import(${JSON.stringify(module)});process.stdout.write(JSON.stringify([bootstrapPath('codex'),bootstrapPath('claude-code')]));`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], {
    encoding: "utf8", timeout: 10000,
    env: { ...process.env, HOME: join(path, ".."), USERPROFILE: join(path, ".."), CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [join(codexHome, "AGENTS.md"), join(claudeHome, "CLAUDE.md")]);
}));


test("#1314 declined and unattended installs do no instruction or optional-projection I/O", async () => fixture(async path => {
  const invalid = Buffer.from([255, 254]);
  await writeFile(path, invalid);
  const paths = [path];
  if (process.platform !== "win32") { await symlink(path, path + ".link"); paths.push(path + ".link"); }
  for (const target of paths) {
    for (const consent of [{ withBootstrap: false, interactive: true }, { interactive: false }]) {
      const result = await ensureBootstrap("codex", "install", {
        path: target, dryRun: false, ...consent,
        // Models an absent optional asset: this getter must never be reached.
        get projection(): string { throw Object.assign(new Error("missing optional projection"), { code: "ENOENT" }); },
      });
      assert.equal(result.error, undefined, result.detail);
      assert.equal(result.changed, false);
      assert.deepEqual(await readFile(path), invalid);
    }
  }
}));
