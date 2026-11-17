// Stored task failure and review texts are English (#1602); the web UI shows them in
// the user's language by code or exact stored text, and keeps unknown texts as stored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

type Catalog = Record<string, string>;
const catalog = async (lang: string): Promise<Catalog> =>
  ((await import(new URL(`../webui/v22/js/i18n/tasks-${lang}.js`, import.meta.url).href)) as { default: Catalog })
    .default;
const de = await catalog("de");
const en = await catalog("en");

async function tasksApi(catalog: Record<string, string>) {
  const source = await readFile(new URL("../webui/v22/js/sections/tasks-api.js", import.meta.url), "utf8");
  return runInNewContext(
    source.replace(/^import .*;$/gm, "").replace(/^export /gm, "") + "\n({ failureText, reviewText, failureReason })",
    { t: (key: string) => catalog[key] ?? key, LANG: "de", Intl, Date, localStorage: undefined }
  );
}

test("v22 tasks: stored failure codes and review texts are shown in German", async () => {
  const m = await tasksApi(de);
  assert.equal(
    m.failureText({ code: "source_timeout", message: "Source time budget exceeded" }),
    de["tk.reason.source_timeout"]
  );
  assert.equal(
    m.failureText({ code: "source_budget", message: "Memory scan limit exceeded" }),
    de["tk.reason.memory_scan"],
    "two texts share source_budget; the stored text picks the finer one"
  );
  assert.equal(
    m.failureText({
      code: "decision_binding_revised",
      message: "Bound decision/assumption requires explicit owner review",
    }),
    de["tk.reason.decision_binding_revised"]
  );
  assert.equal(m.reviewText("decision_binding_inactive"), de["tk.reason.decision_binding_inactive"]);
  assert.equal(m.reviewText("Explicit owner review required"), de["tk.review.explicit"]);
  assert.equal(m.reviewText("Reconciliation required: execution outcome unknown"), de["tk.card.reconcileUnknown"]);
  assert.equal(
    m.failureReason({ state: "pending", archive_failure: "Execution failed or reconciliation required" }, {}),
    de["tk.reason.archive_failed"]
  );
});

test("v22 tasks: an unknown code or text from an older version stays as stored", async () => {
  const m = await tasksApi(de);
  assert.equal(m.failureText({ code: "new_code", message: "Something new" }), "Something new");
  assert.equal(m.failureText({ code: "new_code", message: "" }), "new_code");
  assert.equal(m.reviewText("Quell-Bytegrenze überschritten"), "Quell-Bytegrenze überschritten");
  assert.equal(m.failureReason({ state: "pending", archive_failure: "other" }, {}), "other");
});

test("v22 tasks: every stored text the UI translates has a German and an English entry", async () => {
  const source = await readFile(new URL("../webui/v22/js/sections/tasks-api.js", import.meta.url), "utf8");
  const keys = new Set([...source.matchAll(/"(tk\.(?:reason|review|card)\.[\w]+)"/g)].map((x) => x[1]!));
  const src = await readFile(new URL("../src/task-events.ts", import.meta.url), "utf8");
  for (const code of ["history_capacity", "source_timeout", "source_budget", "source_unavailable"]) {
    assert.ok(src.includes(`"${code}"`), `${code} is still a code the daemon writes`);
    keys.add(`tk.reason.${code}`);
  }
  for (const key of keys) {
    assert.ok(de[key], `${key} missing in German`);
    assert.ok(en[key], `${key} missing in English`);
  }
});

test("v22 tasks: the stored texts the UI recognises are still the ones the daemon writes", async () => {
  const { readdir } = await import("node:fs/promises");
  const ui = await readFile(new URL("../webui/v22/js/sections/tasks-api.js", import.meta.url), "utf8");
  const block = ui.slice(ui.indexOf("const STORED = {"), ui.indexOf("};", ui.indexOf("const STORED = {")));
  const texts = [...block.matchAll(/^\s+"([^"]+)": "tk\./gm)].map((x) => x[1]!);
  assert.ok(texts.length > 5);
  const dir = new URL("../src/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.startsWith("task-") && f.endsWith(".ts"));
  const src = (await Promise.all(files.map((f) => readFile(new URL(f, dir), "utf8")))).join("\n");
  // Kept for tasks stored by an older version.
  const legacy = new Set(["Edited binding requires explicit owner review"]);
  for (const text of texts)
    if (!legacy.has(text)) assert.ok(src.includes(text), `the daemon no longer writes "${text}"`);
});
