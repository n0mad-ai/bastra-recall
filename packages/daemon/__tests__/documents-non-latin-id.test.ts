/**
 * document ids came from a private ASCII slugify, so two different
 * Cyrillic filenames in one folder collapsed onto one id and the second save
 * was rejected as "taken".
 * Regression: put `/[^a-z0-9]+/g` back in documents-write-handler.ts's
 * slugify and the Cyrillic/CJK tests go red; the Latin control stays green.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "@bastra-recall/core";
import { saveDocument } from "../src/documents-write-handler.js";
import { resetAuditLogCache } from "../src/audit-trail.js";

async function twoDocs(a: string, b: string): Promise<string[]> {
  resetAuditLogCache();
  const dir = await mkdtemp(join(tmpdir(), "docid-scripts-"));
  try {
    const vault = new Vault(join(dir, "vault"));
    await vault.init();
    const out: string[] = [];
    for (const name of [a, b]) {
      const src = join(dir, name);
      await writeFile(src, `bytes of ${name}`);
      try {
        const r = await saveDocument(vault, {
          original_path: src,
          folder_path: "Inbox",
          title: name,
          tags: ["x"],
          category: "vertrag" as const,
          linked_file: false,
          overwrite: false,
        });
        out.push(`ok:${(r as { id?: string }).id ?? JSON.stringify(r).slice(0, 80)}`);
      } catch (e) {
        out.push(`err:${(e as Error).message.slice(0, 120)}`);
      }
    }
    return out;
  } finally {
    resetAuditLogCache();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

for (const [label, a, b] of [
  ["Latin control", "invoice.pdf", "contract.pdf"],
  ["Cyrillic", "счёт.pdf", "договор.pdf"],
  ["CJK", "发票.pdf", "合同.pdf"],
] as const) {
  test(`two ${label}-named files in one folder get distinct doc ids`, async () => {
    const r = await twoDocs(a, b);
    assert.ok(r.every((x) => x.startsWith("ok:")), r.join(" | "));
    assert.notEqual(r[0], r[1], r.join(" | "));
  });
}

test("ASCII and umlaut filenames keep the id they always had", async () => {
  const r = await twoDocs("Größe Übersicht.pdf", "plain.pdf");
  assert.equal(r[0], "ok:doc-inbox-groesse-uebersicht-pdf");
});

test("accented Latin filenames still fold the accent, composed or decomposed", async () => {
  const r = await twoDocs("Café.pdf", "Cafe\u0301 menu.pdf");
  assert.equal(r[0], "ok:doc-inbox-cafe-pdf");
  assert.equal(r[1], "ok:doc-inbox-cafe-menu-pdf");
});

test("marks on non-Latin letters are kept, so и and й do not collide", async () => {
  const r = await twoDocs("и.pdf", "й.pdf");
  assert.ok(r.every((x) => x.startsWith("ok:")), r.join(" | "));
  assert.notEqual(r[0], r[1]);
});
