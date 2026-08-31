import { readFile } from "node:fs/promises";
import { saveMemory } from "../../src/save.js";
import { MEMORY_WRITE_CONFLICT } from "../../src/save-schema.js";
import type { SaveMemoryInput } from "../../src/save-schema.js";

const [vault, body, expectedFile] = process.argv.slice(2);

try {
  const expectedTarget = await readFile(expectedFile, "utf8");
  await saveMemory(
    vault,
    {
      id: "shared-memory",
      title: "Shared Memory",
      type: "lesson",
      summary: `summary ${body}`,
      body,
      topic_path: ["concurrency"],
      tags: ["save"],
      scope: "race",
      recall_when: ["when testing concurrent saves"],
      overwrite: true,
    } as SaveMemoryInput,
    { expectedTarget },
  );
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
} catch (err) {
  const error = err as Error & { code?: string };
  process.stdout.write(
    `${JSON.stringify({ name: error.name, code: error.code, message: error.message })}\n`,
  );
  process.exitCode = error.code === MEMORY_WRITE_CONFLICT ? 2 : 1;
}
