import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bridgeId, type Bridge } from "../src/learned-recall/bridges.js";
import { writeBridges } from "../src/learned-recall/harvest.js";

for (const term of ["straße", "İstanbul"]) for (const archived of [false, true]) {
  test(`normalization upgrade reuses ${archived ? "archived" : "active"} legacy ${term} bridge`, async t => {
    const root = await mkdtemp(join(tmpdir(), "bridge-upgrade-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const norm = (xs: string[]) => [...new Set(xs.map(x => x.toLowerCase()))].sort().join(" ");
    const terms = [term], expansion = ["routing"];
    const id = createHash("sha256").update(`de\n${norm(terms)}\n${norm(expansion)}`).digest("hex").slice(0, 16);
    const legacy: Bridge = { id, lang: "de", trigger_terms: terms, expansion_terms: expansion, evidence: 5,
      first_seen: "2026-01-01T00:00:00.000Z", demoted_at: "2026-02-01T00:00:00.000Z" };
    const dir = join(root, "bridges", ...(archived ? ["archive"] : []), "de");
    await mkdir(dir, { recursive: true }); await writeFile(join(dir, `${id}.json`), JSON.stringify(legacy));
    const current = { ...legacy, id: bridgeId("de", terms, expansion), evidence: 1, first_seen: "2026-10-17T00:00:00.000Z" };
    assert.notEqual(current.id, id);
    assert.equal(await writeBridges(root, [current]), archived ? 0 : 1);
    assert.deepEqual(await readdir(dir), [`${id}.json`]);
    if (archived) await assert.rejects(readdir(join(root, "bridges", "de")), { code: "ENOENT" });
    else {
      const saved = JSON.parse(await readFile(join(dir, `${id}.json`), "utf8"));
      assert.equal(saved.id, id); assert.equal(saved.evidence, 5);
      assert.equal(saved.first_seen, legacy.first_seen); assert.equal(saved.demoted_at, legacy.demoted_at);
    }
  });
}
