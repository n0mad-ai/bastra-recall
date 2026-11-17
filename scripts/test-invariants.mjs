/**
 * `npm run test:invariants` — runs exactly the tests docs/invariants.md names (#1570).
 *
 * The catalog is the single list: every test file it names is run, and inside
 * those files only the tests whose title starts with an invariant ID (`INV-…`).
 * The catalog check (tools/__tests__/invariants-catalog.test.mjs) runs along, so
 * a catalog that drifted from its tests fails here as well.
 *
 * Extra arguments are passed to `node --test` (for example `--test-reporter=dot`).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = readFileSync(join(root, "docs", "invariants.md"), "utf8");

/** Test files named in the catalog's table rows, in catalog order, once each. */
const files = [
  ...new Set(
    [...catalog.matchAll(/^\|\s*INV-[A-Z0-9]+-\d{2}\s*\|.*$/gm)].flatMap((row) =>
      [...row[0].matchAll(/`((?:packages|tools)\/[^`]+\.test\.(?:ts|mjs))`/g)].map((m) => m[1])
    )
  ),
];
if (files.length === 0) {
  console.error("test:invariants: docs/invariants.md names no test files");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--import",
    "./scripts/test-env.mjs",
    "--test",
    "--test-concurrency=2",
    "--test-name-pattern=^INV-",
    ...process.argv.slice(2),
    "tools/__tests__/invariants-catalog.test.mjs",
    ...files,
  ],
  { cwd: root, stdio: "inherit" }
);
process.exit(result.status ?? 1);
