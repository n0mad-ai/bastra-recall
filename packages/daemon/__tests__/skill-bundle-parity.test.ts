/**
 * #456 — one bundle revision, compared everywhere: the installed skill against
 * the shipped source (doctor), the packaged copy against the canonical source,
 * the plugin payload against the same.
 *
 * Run: npx tsx --test packages/daemon/__tests__/skill-bundle-parity.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copySkill, describeSkillInstall, inspectSkillInstall, skillBundleRevision } from "../src/cli/skill.js";
import { cursorRuleState } from "../src/cli/adapters/cursor.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = resolve(HERE, "..");
const REPO = resolve(DAEMON, "..", "..");
const CANONICAL = resolve(REPO, "packages", "skill");

async function seed(dir: string): Promise<void> {
  await mkdir(join(dir, "agents"), { recursive: true });
  await writeFile(join(dir, "SKILL.md"), "# skill\nsee taxonomy.md\n", "utf8");
  await writeFile(join(dir, "taxonomy.md"), "# taxonomy\n", "utf8");
  await writeFile(join(dir, "agents", "openai.yaml"), "interface: {}\n", "utf8");
  await writeFile(join(dir, "cursor-rules.mdc"), "not payload\n", "utf8");
}

test("#456: an installed copy is measured against the source — up to date, stale, missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "bastra-bundle-"));
  try {
    const src = join(root, "src");
    const dst = join(root, "dst");
    await seed(src);
    const missing = await inspectSkillInstall(src, dst);
    assert.equal(missing.status, "missing");
    assert.equal(describeSkillInstall(missing, dst), "missing");

    await copySkill({ dryRun: false }, { sourceDir: src, targetDir: dst });
    const fresh = await inspectSkillInstall(src, dst);
    assert.equal(fresh.status, "up-to-date");
    assert.equal(fresh.revision, await skillBundleRevision(src));
    assert.match(describeSkillInstall(fresh, dst), /up to date \(bundle [0-9a-f]{12}/);

    // The installed client keeps an older SKILL.md and lost a reference file.
    await writeFile(join(dst, "SKILL.md"), "# older skill\n", "utf8");
    await rm(join(dst, "taxonomy.md"));
    const stale = await inspectSkillInstall(src, dst);
    assert.equal(stale.status, "stale");
    assert.deepEqual(stale.stale, ["SKILL.md"]);
    assert.deepEqual(stale.missing, ["taxonomy.md"]);
    assert.match(describeSkillInstall(stale, dst), /^STALE — stale: SKILL\.md; missing: taxonomy\.md/);

    // `--fix` path: install refreshes exactly the differing files.
    const fix = await copySkill({ dryRun: false }, { sourceDir: src, targetDir: dst });
    assert.equal(fix.status, "installed");
    assert.equal((await inspectSkillInstall(src, dst)).status, "up-to-date");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("#456: the bundle revision changes with any payload byte and ignores non-payload neighbours", async () => {
  const root = await mkdtemp(join(tmpdir(), "bastra-bundle-rev-"));
  try {
    await seed(root);
    const a = await skillBundleRevision(root);
    await writeFile(join(root, "cursor-rules.mdc"), "changed but not payload\n", "utf8");
    assert.equal(await skillBundleRevision(root), a, "the Cursor rule is not part of the installed bundle");
    await writeFile(join(root, "taxonomy.md"), "# taxonomy v2\n", "utf8");
    assert.notEqual(await skillBundleRevision(root), a);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#456: the Cursor rule of a project is reported as up to date, stale or not installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "bastra-cursor-rule-"));
  try {
    const shipped = join(root, "shipped.mdc");
    await writeFile(shipped, "rule v2\n", "utf8");
    assert.match(await cursorRuleState(root, shipped), /^not in this project/);
    await mkdir(join(root, ".cursor", "rules"), { recursive: true });
    await writeFile(join(root, ".cursor", "rules", "bastra-recall.mdc"), "rule v1\n", "utf8");
    assert.match(await cursorRuleState(root, shipped), /^STALE/);
    await writeFile(join(root, ".cursor", "rules", "bastra-recall.mdc"), "rule v2\n", "utf8");
    assert.match(await cursorRuleState(root, shipped), /^present, up to date/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#456: the daemon package ships the canonical bundle — every payload file byte-identical, plus the generated Cursor rule", async () => {
  // prepare-package-assets runs on every build (CI builds before testing).
  const shipped = resolve(DAEMON, "skill");
  if (!existsSync(join(shipped, "SKILL.md"))) {
    execFileSync(process.execPath, [resolve(DAEMON, "scripts", "prepare-package-assets.mjs")], { stdio: "ignore" });
  }
  const names = (await readdir(CANONICAL, { withFileTypes: true }))
    .filter((e) => e.isFile() && (e.name.endsWith(".md") || e.name === "cursor-rules.mdc"))
    .map((e) => e.name);
  for (const name of [...names, join("agents", "openai.yaml")]) {
    const [a, b] = await Promise.all([readFile(join(CANONICAL, name), "utf8"), readFile(join(shipped, name), "utf8")]);
    assert.equal(a, b, `packaged skill/${name} differs from packages/skill/${name}`);
  }
  assert.equal(await skillBundleRevision(shipped), await skillBundleRevision(CANONICAL));
  const pkg = JSON.parse(await readFile(join(DAEMON, "package.json"), "utf8")) as { files: string[] };
  assert.ok(pkg.files.includes("skill"), "package.json must ship the skill directory");
});

test("#456: `npm pack` lists the skill payload, the Cursor rule and the OpenAI metadata", () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: DAEMON,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const files = new Set((JSON.parse(out)[0].files as Array<{ path: string }>).map((f) => f.path));
  for (const required of ["skill/SKILL.md", "skill/taxonomy.md", "skill/topology.md", "skill/intake.md", "skill/commons.md", "skill/cursor-rules.mdc", "skill/agents/openai.yaml"]) {
    assert.ok(files.has(required), `npm pack does not ship ${required}`);
  }
});
