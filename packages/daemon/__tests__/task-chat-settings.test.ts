import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings } from "../src/settings-file.js";
import { settingEntry, parseSettingValue } from "../src/settings-registry.js";
import { applyTaskChatConsent, inspectTaskChatSetup, taskChatSettings } from "../src/task-chat-settings.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-chat-settings-"));
  return { settingsPath: join(root, "bastra.json"), userPath: join(root, "claude.json"), managedPath: join(root, "managed.json"), managedPolicyPaths: [] as string[] };
}
test("chat activity window belongs to registry and consent cannot be set by generic settings", () => {
  assert.equal(settingEntry("tasks.chatActiveMinutes")?.default, 30);
  assert.equal(parseSettingValue("tasks.chatActiveMinutes", 10), 10);
  for (const value of [0, -1, 1.5, 1441, "30"]) assert.throws(() => parseSettingValue("tasks.chatActiveMinutes", value));
  assert.throws(() => parseSettingValue("tasks.chatConsent", "accepted"));
});
test("no consent is closed; explicit no is persisted and is never asked again", async () => {
  const f = await fixture();
  assert.equal((await inspectTaskChatSetup(f)).ask, true);
  assert.deepEqual(await taskChatSettings(f), { consent: false, activeMinutes: 30 });
  assert.equal((await applyTaskChatConsent(false, f)).answer, "declined");
  assert.equal((await inspectTaskChatSetup(f)).ask, false);
  await assert.rejects(readFile(f.userPath), { code: "ENOENT" });
});
test("an absent or non-boolean answer never silently records no or enables chat", async () => {
  for (const value of [undefined, null, "yes", "no", 1, 0]) {
    const f = await fixture();
    await assert.rejects(applyTaskChatConsent(value as unknown as boolean, f));
    assert.equal((await inspectTaskChatSetup(f)).ask, true);
    await assert.rejects(readFile(f.userPath), { code: "ENOENT" });
  }
});
test("explicit yes writes only accept and preserves unrelated Claude and Recall settings", async () => {
  const f = await fixture();
  const original = '{ "unrelated": { "keep": true } }\n';
  await writeFile(f.userPath, original);
  const r = await applyTaskChatConsent(true, f);
  assert.equal(r.answer, "accepted");
  assert.deepEqual(JSON.parse(await readFile(f.userPath, "utf8")), { unrelated: { keep: true }, crossSessionInbound: "accept" });
  assert.ok(r.backupPath);
  assert.deepEqual(JSON.parse(await readFile(r.backupPath!, "utf8")), { unrelated: { keep: true } });
  assert.equal(await readFile(r.backupPath!, "utf8"), original, "backup preserves the original bytes");
  assert.equal((await taskChatSettings(f)).consent, true);
  assert.equal((await readSettings(f.settingsPath)).tasks?.chatConsent, "accepted");
  await writeFile(f.userPath, '{"crossSessionInbound":"hold"}');
  assert.equal((await taskChatSettings(f)).consent, false, "later restrictive change takes effect immediately");
});
test("concurrent setup answers preserve the first decision and never ask again", async () => {
  const f = await fixture();
  const [no, yes] = await Promise.all([applyTaskChatConsent(false, f), applyTaskChatConsent(true, f)]);
  assert.equal(no.answer, "declined"); assert.equal(yes.answer, "declined");
  await assert.rejects(readFile(f.userPath), { code: "ENOENT" });
  assert.equal((await inspectTaskChatSetup(f)).ask, false);
});
test("hold/refuse and managed directives are preserved even after explicit yes", async () => {
  for (const mode of ["hold", "refuse", "managed-accept", "managed-other"]) {
    const f = await fixture();
    const user = JSON.stringify({ crossSessionInbound: mode.startsWith("managed") ? "accept" : mode });
    await writeFile(f.userPath, user);
    if (mode.startsWith("managed")) await writeFile(f.managedPath, JSON.stringify(mode === "managed-accept" ? { crossSessionInbound: "accept" } : { permissions: {} }));
    assert.equal((await applyTaskChatConsent(true, f)).answer, "blocked");
    assert.equal(await readFile(f.userPath, "utf8"), user);
    assert.equal((await inspectTaskChatSetup(f)).ask, false);
    assert.equal((await taskChatSettings(f)).consent, false);
  }
});
test("corrupt files and symlinks cannot become accept settings", async () => {
  const f = await fixture(); await writeFile(f.userPath, "broken");
  await assert.rejects(applyTaskChatConsent(true, f));
  assert.equal(await readFile(f.userPath, "utf8"), "broken");
  const g = await fixture(); await writeFile(g.managedPath, "{}"); await symlink(g.managedPath, g.userPath);
  await assert.rejects(applyTaskChatConsent(true, g));
  assert.equal(await readFile(g.managedPath, "utf8"), "{}");
});
test("MDM plists, managed drop-ins and remote cache block setup and later delivery without being edited", async () => {
  for (const kind of ["mdm", "drop-ins", "remote-cache"]) {
    const f = await fixture();
    const policy = join(f.userPath + ".policy", kind === "mdm" ? "com.anthropic.claudecode.plist" : kind === "drop-ins" ? "managed-settings.d" : "remote-settings.json");
    f.managedPolicyPaths = [policy];
    await applyTaskChatConsent(true, f);
    assert.equal((await taskChatSettings(f)).consent, true);
    await mkdir(join(f.userPath + ".policy"), { recursive: true });
    if (kind === "drop-ins") await mkdir(policy);
    else await writeFile(policy, "managed opaque policy fixture");
    assert.equal((await taskChatSettings(f)).consent, false, kind);
    const g = await fixture(); g.managedPolicyPaths = [policy];
    assert.equal((await applyTaskChatConsent(true, g)).answer, "blocked", kind);
    await assert.rejects(readFile(g.userPath), { code: "ENOENT" });
    if (kind !== "drop-ins") assert.equal(await readFile(policy, "utf8"), "managed opaque policy fixture");
  }
});
