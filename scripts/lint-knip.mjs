import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertKnipDownward,
  KNIP_CATEGORIES,
  KNIP_VERSION,
  parseKnipReport,
  validateKnipBaseline,
} from "./lint-knip-findings.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

function executeKnip(rootDirectory, file, execute) {
  const cli = join(rootDirectory, "node_modules/knip/bin/knip.js");
  return execute(
    process.execPath,
    [
      cli,
      "--directory",
      rootDirectory,
      "--config",
      join(rootDirectory, "knip.json"),
      "--include",
      KNIP_CATEGORIES.join(","),
      "--reporter",
      "json",
      "--output-file",
      `json=${file}`,
      "--no-exit-code",
      "--no-progress",
    ],
    { cwd: rootDirectory, encoding: "utf8", timeout: 180_000, stdio: ["ignore", "inherit", "inherit"] }
  );
}

function toolFindings(rootDirectory, file, execute) {
  const result = executeKnip(rootDirectory, file, execute);
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  const raw = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (raw !== null) process.stdout.write(`${raw}\n`);
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(
      `Knip failed (${result.status ?? result.signal}): ${result.error?.message ?? "tool/config failure"}`
    );
  }
  if (raw === null) throw new Error("Knip succeeded without producing its required JSON report");
  return parseKnipReport(JSON.parse(raw));
}

export function runKnip(rootDirectory, execute = spawnSync) {
  const metadata = JSON.parse(readFileSync(join(rootDirectory, "node_modules/knip/package.json"), "utf8"));
  if (metadata.version !== KNIP_VERSION) throw new Error(`Expected Knip ${KNIP_VERSION}, got ${metadata.version}`);
  const output = mkdtempSync(join(tmpdir(), "bastra-knip-"));
  try {
    return toolFindings(rootDirectory, join(output, "report.json"), execute);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

export function checkKnip(rootDirectory = root, execute = spawnSync) {
  const read = (file) => JSON.parse(readFileSync(join(rootDirectory, file), "utf8"));
  const config = read("knip.json");
  const budget = validateKnipBaseline(read("knip-baseline.json"), config);
  const actual = runKnip(rootDirectory, execute);
  assertKnipDownward(budget, actual);
  console.log(`Knip: ${Object.values(actual).reduce((sum, count) => sum + count, 0)} findings within frozen budget.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    checkKnip();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
