/** Isolated feature driver host. Without a published driver, writes an honest pending manifest. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { PROACTIVE_CASES, summarizeObservations, type Observation, type ProactiveCase } from "./proactive-measurement.js";

export interface FeatureDriver {
  metadata: { feature_commit: string; contract_prs: Record<string, number>; design_sha256: string; adapter: string; client: string; profile: string };
  /** Each run must reset state and derive observables from the real feature; no model verdicts. */
  run(c: ProactiveCase, context: { root: string; port: number; reference_instant: string; repetition: number; feature_root: string }): Promise<Observation>;
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
async function privatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ok); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no isolated port");
  const port = address.port;
  await new Promise<void>((ok, fail) => server.close(error => error ? fail(error) : ok()));
  if (port === 6723) return privatePort();
  return port;
}
async function main() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--out-dir", "--driver", "--feature-root"].includes(args[i]) || !args[i + 1] || opts[args[i]]) throw new Error("usage: --out-dir PRIVATE_ARCHIVE_CHILD [--driver module --feature-root isolated-checkout]");
    opts[args[i]] = args[i + 1];
  }
  if (!opts["--out-dir"] || Boolean(opts["--driver"]) !== Boolean(opts["--feature-root"])) throw new Error("out-dir required; driver and feature-root must be supplied together");
  const archive = realpathSync(join(homedir(), ".bastra", "eval-runs"));
  const out = resolve(opts["--out-dir"]);
  // Resolve the existing parent to prevent symlink escapes before exclusive mkdir.
  const parent = realpathSync(resolve(out, ".."));
  const rel = relative(archive, parent);
  if (rel.startsWith("..") || isAbsolute(rel) || out === archive) throw new Error("output must be a fresh private eval-run archive child");
  const registration = [402, 598, 410].map(issue => {
    const text = readFileSync(new URL(`../registrations/proactive-${issue}.json`, import.meta.url), "utf8");
    const reg = JSON.parse(text);
    if (reg.status !== "numbers_registered" || !Number.isSafeInteger(reg.registration_version) || reg.registration_version < 1) throw new Error("unregistered protocol revision; update runner before running");
    return { issue, registration_version: reg.registration_version, sha256: hash(text) };
  });
  const evalRoot = resolve(new URL("../../..", import.meta.url).pathname);
  const evalCommit = git(evalRoot, "rev-parse", "HEAD");
  const runnerHash = hash(readFileSync(new URL("./proactive-measurement.ts", import.meta.url), "utf8") + readFileSync(new URL("./proactive-measurement-run.ts", import.meta.url), "utf8"));
  let driver: FeatureDriver | undefined;
  let featureRoot: string | undefined;
  if (opts["--driver"]) {
    featureRoot = realpathSync(opts["--feature-root"]);
    const worktrees = realpathSync(join(homedir(), ".codex", "worktrees"));
    const featureRelative = relative(worktrees, featureRoot);
    if (!featureRelative || featureRelative.startsWith("..") || isAbsolute(featureRelative)) throw new Error("feature root must be an isolated Codex worktree");
    const clean = git(featureRoot, "status", "--porcelain", "--untracked-files=no");
    if (clean) throw new Error("feature checkout has tracked modifications; pin a clean commit");
    driver = (await import(pathToFileURL(resolve(opts["--driver"])).href)).default as FeatureDriver;
    if (!driver || typeof driver.run !== "function" || !/^[a-f0-9]{40}$/.test(driver.metadata?.feature_commit ?? "") || driver.metadata.feature_commit !== git(featureRoot, "rev-parse", "HEAD")
      || !/^[a-f0-9]{64}$/.test(driver.metadata.design_sha256)
      || !Number.isSafeInteger(driver.metadata.contract_prs.P0) || driver.metadata.contract_prs.P0 < 1)
      throw new Error("driver needs a pinned feature head, P0 design hash and published P0 PR");
  }
  mkdirSync(out, { mode: 0o700 });
  const write = (name: string, value: unknown) => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  const started = new Date().toISOString();
  const manifest = { started_at: started, evidence_class: "synthetic_functional_only", eval_commit: evalCommit, runner_sha256: runnerHash,
    driver_sha256: opts["--driver"] ? hash(readFileSync(opts["--driver"], "utf8")) : null,
    registration, dataset_sha256: hash(JSON.stringify(PROACTIVE_CASES)), runtime: process.version,
    feature: driver?.metadata ?? null, longitudinal_window_started_at: null };
  write("manifest.json", manifest); // Persist identity before any feature call.
  const rows: Observation[] = [];
  try {
    if (driver && featureRoot) for (const c of PROACTIVE_CASES.filter(c => c.dependencies.every(p => Number.isSafeInteger(driver!.metadata.contract_prs[p]) && driver!.metadata.contract_prs[p] > 0))) for (let repetition = 1; repetition <= 3; repetition++) {
      const root = mkdtempSync(join(tmpdir(), "bastra-proactive-measurement-"));
      const row = await driver.run(c, { root, port: await privatePort(), reference_instant: "2026-10-11T12:00:00Z", repetition, feature_root: featureRoot });
      if (row.case_id !== c.id || row.repetition !== repetition) throw new Error("driver returned the wrong case/repetition");
      write(`${c.id}-${repetition}.json`, row); // Retain each row even if the next call crashes.
      rows.push(row);
    }
    const summary = summarizeObservations(rows);
    const { results: _privateResults, ...aggregate } = summary;
    write("results.json", { ...manifest, ...summary });
    // Public output deliberately excludes driver strings, roots, receipt contents and errors.
    console.log(JSON.stringify({ ...aggregate, feature_commit: driver?.metadata.feature_commit ?? null, registration, runner_sha256: runnerHash, dataset_sha256: manifest.dataset_sha256 }, null, 2));
    if (summary.functional_verdict === "failed" || summary.functional_verdict === "not_evaluable") process.exitCode = 1;
  } catch (error) {
    write("aborted.json", { verdict: "not_evaluable", completed_rows: rows.length, error: String(error) });
    console.error("Measurement aborted; private artifacts preserved. No passed verdict.");
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error("Measurement setup rejected; no feature run started."); process.exitCode = 1; });
