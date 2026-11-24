import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { readSizeSettings, thresholdsFor } from "../src/file-size-check.js";
import { bastraDataDir } from "../src/platform-paths.js";
import { runtimeFeatureSetting } from "../src/runtime-feature-settings.js";
import * as defaults from "../src/settings-defaults.js";
import { settingEntry } from "../src/settings-registry.js";

const src = fileURLToPath(new URL("../src/", import.meta.url));

function sourceFile(file: string, text = readFileSync(file, "utf8")): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function registryDefault(key: string): unknown {
  const entry = settingEntry(key);
  assert.ok(entry, `${key} is read outside the registry and must have a registry entry`);
  return entry.default;
}

function fieldsRead(source: ts.SourceFile, receiver: string): Set<string> {
  const fields = new Set<string>();
  walk(source, (node) => {
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return;
    let object: ts.Expression = node.expression;
    while (ts.isAsExpression(object) || ts.isParenthesizedExpression(object)) object = object.expression;
    if (object.getText(source) !== receiver) return;
    if (ts.isPropertyAccessExpression(node)) fields.add(node.name.text);
    else {
      assert.ok(ts.isStringLiteralLike(node.argumentExpression), `${receiver} needs a literal settings key`);
      fields.add(node.argumentExpression.text);
    }
  });
  return fields;
}

function storedFeatureKeys(): Set<string> {
  const reader = sourceFile(join(src, "runtime-feature-settings.ts"));
  const keys = new Set<string>();
  for (const group of fieldsRead(reader, "stored")) {
    const fields = fieldsRead(reader, `stored.${group}`);
    // The task block is unpacked by storedTasks(tasks).
    if (group === "tasks") for (const field of fieldsRead(reader, "tasks")) fields.add(field);
    assert.ok(fields.size > 0, `track the settings fields read from the ${group} block`);
    for (const field of fields) keys.add(`${group}.${field}`);
  }
  return keys;
}

/** Inspect arguments at the actual call sites, including new consumers. */
function* featureReads() {
  for (const name of readdirSync(src, { recursive: true, encoding: "utf8" })) {
    if (!name.endsWith(".ts")) continue;
    const file = join(src, name);
    const text = readFileSync(file, "utf8");
    if (!text.includes("runtimeFeatureSetting")) continue;
    const source = sourceFile(file, text);
    const names = new Set(["runtimeFeatureSetting"]);
    walk(source, (node) => {
      if (ts.isImportSpecifier(node) && node.propertyName?.text === "runtimeFeatureSetting") names.add(node.name.text);
    });
    const calls: ts.CallExpression[] = [];
    walk(source, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText(source);
      if (names.has(name)) calls.push(node);
    });
    for (const call of calls) {
      const [feature, fallback] = call.arguments;
      const location = `${name}:${source.getLineAndCharacterOfPosition(call.getStart()).line + 1}`;
      assert.ok(feature && ts.isStringLiteralLike(feature), `${location} needs a literal settings group`);
      assert.ok(fallback, `${location} needs a fallback`);
      const value = fallback.getText(source);
      const defaultValue = value === "true" || value === "false" ? value === "true" : Reflect.get(defaults, value);
      assert.ok(typeof defaultValue === "boolean", `${location} fallback must be a boolean or shared default`);
      yield { feature: feature.text, fallback: defaultValue, location };
    }
  }
}

test("#1510 thin-client feature reads use the registered keys and defaults", (t) => {
  const home = mkdtempSync(join(tmpdir(), "bastra-hook-settings-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const data = bastraDataDir(home, { env: {} });
  mkdirSync(data, { recursive: true });
  const isolated = { HOME: home, USERPROFILE: home, LOCALAPPDATA: "", BASTRA_DB_PATH: join(data, "missing.db") };
  for (const [key, value] of Object.entries(isolated)) {
    const original = process.env[key];
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
    process.env[key] = value;
  }

  const reads = [...featureReads()];
  const storedKeys = storedFeatureKeys();
  for (const key of storedKeys) registryDefault(key);
  for (const { feature, fallback, location } of reads) {
    const key = `${feature}.enabled`;
    const registered = registryDefault(key);
    assert.equal(fallback, registered, `${location} fallback for ${key}`);

    // Each database path gets a fresh snapshot. Invert the fallback to prove
    // that the hook reader really reads the corresponding persisted key.
    const name = feature as Parameters<typeof runtimeFeatureSetting>[0];
    process.env.BASTRA_DB_PATH = join(data, "missing.db");
    assert.equal(runtimeFeatureSetting(name, fallback), registered, `${key} without stored settings`);
    writeFileSync(join(data, "cli-settings.json"), JSON.stringify({ [feature]: { enabled: !fallback } }));
    process.env.BASTRA_DB_PATH = join(data, `${feature}-stored.db`);
    assert.equal(runtimeFeatureSetting(name, fallback), !fallback, `${key} with a stored value`);
    rmSync(join(data, "cli-settings.json"));
  }
  assert.deepEqual(
    storedKeys,
    new Set(reads.map(({ feature }) => `${feature}.enabled`)),
    "every stored feature key must have a caller fallback"
  );
});

test("#1510 the write hook's slim size reader uses registered keys and defaults", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bastra-hook-size-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, BASTRA_DB_PATH: join(root, "missing.db") };
  delete env.BASTRA_SIZE_GUIDE;
  delete env.BASTRA_SIZE_CRITICAL;
  t.mock.property(process, "env", env);

  const source = sourceFile(join(src, "file-size-check.ts"));
  const keys = fieldsRead(source, "parsed.size");
  let exemptPaths: string[] | undefined;
  walk(source, (node) => {
    if (ts.isParameter(node) && node.name.getText(source) === "exemptPaths") {
      assert.ok(
        node.initializer && ts.isArrayLiteralExpression(node.initializer),
        "exemptPaths needs an array fallback"
      );
      exemptPaths = node.initializer.elements.map((element) => {
        assert.ok(ts.isStringLiteralLike(element), "exemptPaths fallback items must be strings");
        return element.text;
      });
    }
  });
  const settingsFile = join(root, "cli-settings.json");
  writeFileSync(settingsFile, "{}");
  const settings = await readSizeSettings(settingsFile);
  const actual = { ...thresholdsFor("example.ts", settings), exemptPaths: settings.exemptPaths ?? exemptPaths };
  for (const field of keys)
    assert.deepEqual(Reflect.get(actual, field), registryDefault(`size.${field}`), `size.${field}`);
  assert.deepEqual([...keys].sort(), Object.keys(actual).sort(), "every file-size fallback must be covered");
});
