/**
 * #1510: the thin-client feature read (tasks, telemetry) per stored shape, pinned
 * before it moves to the shared data path. A missing settings record uses the
 * feature default; an unreadable or malformed one keeps tasks closed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runtimeFeatureSetting } from "../src/runtime-feature-settings.js";

/** Each case gets its own HOME: the reader caches per path. */
async function read(content: string | "missing" | "directory") {
  const home = await mkdtemp(join(tmpdir(), "bastra-runtime-features-"));
  const saved = { HOME: process.env.HOME, DB: process.env.BASTRA_DB_PATH };
  process.env.HOME = home;
  delete process.env.BASTRA_DB_PATH;
  try {
    const file = join(home, ".bastra", "cli-settings.json");
    await mkdir(join(home, ".bastra"), { recursive: true });
    if (content === "directory") await mkdir(file);
    else if (content !== "missing") await writeFile(file, content);
    return {
      tasksOn: runtimeFeatureSetting("tasks", true),
      tasksOff: runtimeFeatureSetting("tasks", false),
      telemetryOn: runtimeFeatureSetting("telemetry", true),
      telemetryOff: runtimeFeatureSetting("telemetry", false),
    };
  } finally {
    process.env.HOME = saved.HOME;
    if (saved.DB !== undefined) process.env.BASTRA_DB_PATH = saved.DB;
    await rm(home, { recursive: true, force: true });
  }
}

const defaults = { tasksOn: true, tasksOff: false, telemetryOn: true, telemetryOff: false };
const closed = { ...defaults, tasksOn: false };

const CASES: Array<[string, string, typeof defaults]> = [
  ["no settings", "missing", defaults],
  ["not a file", "directory", closed],
  ["corrupt JSON", "{", closed],
  ["an array", "[]", closed],
  ["empty object", "{}", defaults],
  ["tasks without enabled", '{"tasks":{}}', defaults],
  ["tasks enabled", '{"tasks":{"enabled":true}}', { ...defaults, tasksOff: true }],
  ["tasks disabled", '{"tasks":{"enabled":false}}', closed],
  ["tasks enabled not a boolean", '{"tasks":{"enabled":"yes"}}', closed],
  ["tasks not an object", '{"tasks":true}', closed],
  ["tasks null", '{"tasks":null}', closed],
  ["tasks an array", '{"tasks":[]}', closed],
  ["telemetry off", '{"telemetry":{"enabled":false}}', { ...defaults, telemetryOn: false }],
  ["telemetry on", '{"telemetry":{"enabled":true}}', { ...defaults, telemetryOff: true }],
  ["telemetry not a boolean", '{"telemetry":{"enabled":1}}', defaults],
  ["telemetry a string", '{"telemetry":"on"}', defaults],
];

for (const [name, content, expected] of CASES)
  test(`#1510 runtime feature read: ${name}`, async () => {
    assert.deepEqual(await read(content), expected);
  });
