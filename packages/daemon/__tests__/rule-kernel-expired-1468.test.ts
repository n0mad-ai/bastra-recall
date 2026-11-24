/**
 * #1468 (owner decision 24.11.2026): a rule past its own `valid_until` is not
 * hidden and not in force. The rule kernel names it in a short block of its
 * own, in the user's language, until the user decides.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, saveMemory } from "@bastra-recall/core";
import { renderRuleKernel } from "../src/rule-kernel.js";
import { cachedRulebookCatalog, rulebookPage, type KernelEntry } from "../src/rulebook-catalog.js";
import { indexedConventionSource, readConventionSource } from "../src/convention-source.js";
import {
  beginRulebookRound,
  recordRulebookCheck,
  recordRulebookLoad,
  roundCorrespondence,
} from "../src/rulebook-check.js";
import { loadSessionState } from "../src/session-state.js";
import { refreshStopValidators } from "../src/stop-validator-source.js";
import { runTaskStep } from "../src/prompt-task.js";

const entry = (id: string, rulebook: "always" | "on-demand", extra: Partial<KernelEntry> = {}): KernelEntry => ({
  id,
  title: `Invented ${id}`,
  group: "explicit",
  revision: "rev-1",
  updated: null,
  stale_status: "fresh",
  body: rulebook === "always" ? `Body of ${id}.` : "",
  rulebook,
  applies_when: `When ${id} applies`,
  ...extra,
});
const candidates = {
  entries: [
    entry("current-always", "always"),
    entry("expired-always", "always", { expired_on: "2026-11-01" }),
    entry("current-on-demand", "on-demand"),
    entry("expired-on-demand", "on-demand", { expired_on: "2026-10-15" }),
  ],
  omitted: 0,
};

test("an expired rule leaves the Always texts and the index and appears in its own block", () => {
  const en = renderRuleKernel(candidates, { trigger: "after startup" });
  assert.match(en.text, /Body of current-always\./);
  assert.doesNotMatch(en.text, /Body of expired-always\./, "an expired Always text is not in force");
  assert.deepEqual(en.full, ["current-always"]);
  assert.match(en.text, /^current-on-demand — /m);
  assert.doesNotMatch(en.text, /^expired-on-demand — /m, "not listed as a current rule");
  assert.match(en.text, /Expired – please decide with the user \(2\)/);
  assert.match(en.text, /- expired-always — Invented expired-always — expired on 2026-11-01/);
  assert.match(en.text, /- expired-on-demand — Invented expired-on-demand — expired on 2026-10-15/);
  assert.match(en.text, /Catalog end: hash=/, "the catalog positions still add up");

  const de = renderRuleKernel(candidates, { trigger: "after startup", language: "de" });
  assert.match(de.text, /Abgelaufen – bitte mit dem Nutzer entscheiden \(2\)/);
  assert.match(de.text, /expired-always — Invented expired-always — abgelaufen am 2026-11-01/);

  const none = renderRuleKernel({ entries: [entry("current-always", "always")], omitted: 0 }, { trigger: "x" });
  assert.doesNotMatch(none.text, /Expired|Abgelaufen/);
});

test("the catalog marks a rule past its own end date, and list_rules says so", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rule-kernel-expired-"));
  const vault = new Vault(dir);
  after(async () => {
    await vault.stop();
    await rm(dir, { recursive: true, force: true });
  });
  await vault.init();
  for (const [id, valid_until] of [
    ["ended-rule", "2020-01-31"],
    ["running-rule", "2999-12-31"],
    ["open-rule", undefined],
  ] as const) {
    const m = await saveMemory(vault.root, {
      id,
      title: "Invented rule",
      summary: "Invented scope",
      body: "Invented body",
      type: "workflow",
      scope: "all-projects",
      write_origin: "user-directed",
      rulebook: "on-demand",
      applies_when: "For invented output",
      tags: ["fixture"],
      topic_path: ["fixture"],
      recall_when: ["invented-trigger"],
      ...(valid_until ? { valid_until } : {}),
    });
    await vault.reindexFile(m.file_path);
  }
  for (const mode of ["content", "ids"] as const) {
    const c = await cachedRulebookCatalog(vault, { project: null, active: [], mode });
    const byId = new Map(c.entries.map((e) => [e.id, e]));
    assert.equal(byId.get("ended-rule")?.expired_on, "2020-01-31", mode);
    assert.equal(byId.get("running-rule")?.expired_on, undefined, mode);
    assert.equal(byId.get("open-rule")?.expired_on, undefined, mode);
  }
  const page = rulebookPage(await cachedRulebookCatalog(vault, { project: null, active: [] }));
  const rules = new Map(page.rules.map((r) => [r.id, r as { expired_on?: string }]));
  assert.equal(rules.get("ended-rule")?.expired_on, "2020-01-31");
  assert.equal(rules.get("open-rule")?.expired_on, undefined);
  assert.equal(indexedConventionSource(vault.get("ended-rule")).expired, true);
  assert.equal((await readConventionSource(vault.get("ended-rule"))).expired, true);
  assert.equal(indexedConventionSource(vault.get("running-rule")).expired, undefined);
  assert.equal((await readConventionSource(vault.get("running-rule"))).expired, undefined);
});

test("expired correspondence rules stay out of task and Stop validators", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "expired-rule-state-"));
  const oldStateDir = process.env.BASTRA_HOOK_STATE_DIR;
  process.env.BASTRA_HOOK_STATE_DIR = dir;
  t.after(async () => {
    if (oldStateDir === undefined) delete process.env.BASTRA_HOOK_STATE_DIR;
    else process.env.BASTRA_HOOK_STATE_DIR = oldStateDir;
    await rm(dir, { recursive: true, force: true });
  });
  const validator = { tool: "validate_artifact", channel: "fixture-copy", limit: 12, unit: "utf16" } as const;
  const current = entry("active-copy-rule", "on-demand", { validator });
  const prior = entry("ended-copy-rule", "on-demand", { validator });
  const expired = { ...prior, expired_on: "2020-01-31" };
  const catalog = { entries: [current, expired], omitted: 0 };
  const session = { session_id: "expiry-check", bastra_client: "claude-code" };
  const state = () => loadSessionState(session.session_id);
  const conventionOf = async (id: string) => ({
    revision: prior.revision,
    validator,
    ...(id === prior.id ? { expired: true as const } : {}),
  });

  const notice = await beginRulebookRound(session, catalog);
  assert.match(notice, /active-copy-rule/);
  assert.doesNotMatch(notice, /ended-copy-rule/);
  await recordRulebookLoad(session.session_id, prior.id, undefined, await conventionOf(prior.id));
  assert.equal(roundCorrespondence(await state(), session).rules.length, 0);

  const reported = { applicable: [current.id, prior.id], task: "draft-for-review" as const };
  await recordRulebookCheck(session.session_id, reported, catalog);
  assert.deepEqual(
    (await state()).activeConventions?.map((r) => r.id),
    [current.id]
  );
  assert.deepEqual(
    roundCorrespondence(await state(), session).rules.map((r) => r.id),
    [current.id]
  );

  // The rule was active when originally loaded, and now expires without a new write.
  await recordRulebookCheck(session.session_id, reported, { ...catalog, entries: [current, prior] });
  await refreshStopValidators(session.session_id, conventionOf, Date.now() + 1000, session);
  assert.deepEqual(
    roundCorrespondence(await state(), session)
      .rules.filter((r) => r.validator)
      .map((r) => r.id),
    [current.id]
  );
  const active = await runTaskStep({
    sessionId: session.session_id,
    snapshot: await state(),
    conventionOf,
    surface: session.bastra_client,
  });
  assert.match(active ?? "", /active-copy-rule/);
  assert.doesNotMatch(active ?? "", /ended-copy-rule/);
});
