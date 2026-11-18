import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const workflowPath = ".github/workflows/ci.yml";

function checkedSha(value, label) {
  if (!/^[a-f0-9]{40}$/.test(value ?? "")) throw new Error(`Invalid ${label} commit SHA.`);
  return value;
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function isAncestor(cwd, ancestor, head) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, head], { cwd });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`Cannot verify lint baseline ancestry: ${ancestor}. Fetch the complete history.`);
}

function trustedRun(run, repository, workflowId) {
  return (
    run.workflow_id === workflowId &&
    run.path === workflowPath &&
    run.head_branch === "main" &&
    run.head_repository?.full_name?.toLowerCase() === repository.toLowerCase() &&
    ["push", "workflow_dispatch"].includes(run.event) &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    Number.isSafeInteger(run.run_number) &&
    run.run_number > 0 &&
    /^[a-f0-9]{40}$/.test(run.head_sha ?? "")
  );
}

function githubApi(endpoint, paginate = false) {
  const args = ["api", endpoint];
  if (paginate) args.push("--paginate", "--slurp");
  return JSON.parse(
    execFileSync("gh", args, {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    })
  );
}

function mainBaseline(repository, head, cwd, readGithub) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("Invalid GitHub repository.");
  const endpoint = `repos/${repository}/actions/workflows/ci.yml`;
  const workflow = readGithub(endpoint);
  if (workflow.path !== workflowPath || !Number.isSafeInteger(workflow.id) || workflow.id <= 0) {
    throw new Error("The CI workflow identity could not be verified.");
  }
  const pages = readGithub(`${endpoint}/runs?branch=main&status=success&per_page=100`, true);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page.workflow_runs))) {
    throw new Error("Invalid successful CI run response.");
  }
  const runs = pages
    .flatMap((page) => page.workflow_runs)
    .filter((run) => trustedRun(run, repository, workflow.id))
    .sort((a, b) => b.run_number - a.run_number);
  // Main may have moved on while this run was queued. A newer success on that
  // descendant is not a valid baseline for the older checkout.
  const baseline = runs.find((run) => isAncestor(cwd, run.head_sha, head));
  if (!baseline)
    throw new Error("No successful ancestor CI run on main. The lint ratchet cannot run without a trusted anchor.");
  return baseline.head_sha;
}

export function resolveLintBaseline(
  { eventName, event, sha, ref, repository, cwd = process.cwd() },
  readGithub = githubApi
) {
  const head = checkedSha(sha, "checked-out");
  if (git(cwd, "rev-parse", "HEAD") !== head) throw new Error("The checkout does not match the CI commit.");
  if (eventName === "pull_request") {
    const base = checkedSha(event.pull_request?.base?.sha, "pull-request base");
    return checkedSha(git(cwd, "merge-base", base, head), "merge-base");
  }
  if (!["push", "workflow_dispatch"].includes(eventName) || ref !== "refs/heads/main") {
    throw new Error("Lint baseline resolution requires a main run or a pull request.");
  }
  return mainBaseline(repository, head, cwd, readGithub);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const sha = resolveLintBaseline({
      eventName: process.env.GITHUB_EVENT_NAME,
      event,
      sha: process.env.GITHUB_SHA,
      ref: process.env.GITHUB_REF,
      repository: process.env.GITHUB_REPOSITORY,
    });
    process.stdout.write(`sha=${sha}\n`);
  } catch (error) {
    console.error(`Cannot resolve trusted lint baseline: ${error.message}`);
    process.exitCode = 1;
  }
}
