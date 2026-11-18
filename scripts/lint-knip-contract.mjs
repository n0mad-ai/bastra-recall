import { assertKnipDownward, digest, KNIP_VERSION, validateKnipBaseline } from "./lint-knip-findings.mjs";

// N51 initial freeze: measured complete 62ada834 + Knip + Eval candidate after
// a clean workspace build. The source SHA is the precommit base; dirty source
// and all new helpers/tests are bound in the local source-attestation receipt.
// Main adoption and fresh CI remain required. No environment flag can bootstrap.
export const KNIP_BOOTSTRAP = {
  "source": "62ada8348b2bf955719b3da33a96de4aeeaf3f69",
  "configDigest": "5ada164275a4e9077e292e8170cca4c7be915a597c3f6d36378ac4dbd60eda67",
  "fingerprintsDigest": "9654a2fabce655a53408bbe981045b16508c0dd8e88c4bac6b337d2a02b92812",
};
export const KNIP_SCRIPT = "node scripts/lint-knip.mjs";

export function knipPackageAllowed(before, after) {
  const previous = JSON.parse(before);
  const candidate = JSON.parse(after);
  const expected = previous.devDependencies?.knip;
  if (expected !== undefined && expected !== KNIP_VERSION) return false;
  return candidate.devDependencies?.knip === KNIP_VERSION && candidate.scripts?.["lint:knip"] === KNIP_SCRIPT;
}

export function assertKnipWorkflow(source) {
  const job = source.match(/^  build-and-test:\n([\s\S]*?)(?=^  [a-zA-Z][\w-]*:|$(?![\s\S]))/m)?.[1];
  if (!job) throw new Error("Missing mandatory build-and-test job");
  const header = job.split(/^    steps:\s*$/m)[0];
  if (/^    (?:if|continue-on-error):/m.test(header)) throw new Error("Conditional/optional mandatory job");
  const steps = job.split(/^      - /m).slice(1);
  const build = steps.findIndex((step) => /\n        run: npm run build\s*$/.test(step.trimEnd()));
  const gates = steps.filter((step) => /npm run lint:knip/.test(step));
  const expected = [
    "name: Unused code (Knip, shrinking baseline)",
    "        env:",
    "          LINT_BASE_REF: ${{ steps.lint-baseline.outputs.sha }}",
    "        run: npm run lint:knip",
  ].join("\n");
  if (build < 0 || gates.length !== 1 || gates[0].trimEnd() !== expected || steps.indexOf(gates[0]) <= build) {
    throw new Error("Knip must run unconditionally after Build in the existing mandatory job");
  }
}

export function assertKnipLock(lock) {
  const root = lock.packages?.[""]?.devDependencies?.knip;
  const tool = lock.packages?.["node_modules/knip"];
  if (root !== KNIP_VERSION || tool?.version !== KNIP_VERSION || !/^sha512-/.test(tool?.integrity ?? "")) {
    throw new Error("Knip lock must pin the exact reviewed tool with integrity");
  }
  return { version: tool.version, integrity: tool.integrity, resolved: tool.resolved };
}

export function assertKnipBudget(candidate, config, previous, previousConfig, bootstrap = KNIP_BOOTSTRAP) {
  const budget = validateKnipBaseline(candidate, config);
  if (previous) {
    if (digest(config) !== digest(previousConfig)) throw new Error("Knip configuration change needs explicit review");
    const trusted = validateKnipBaseline(previous, previousConfig);
    assertKnipDownward(trusted, budget, "Knip baseline");
    return;
  }
  if (
    !bootstrap ||
    candidate.source !== bootstrap.source ||
    candidate.configDigest !== bootstrap.configDigest ||
    digest(budget) !== bootstrap.fingerprintsDigest
  ) {
    throw new Error("Knip initial baseline awaits a fresh inventory and exact reviewed bootstrap");
  }
}

function currentPackage(read, packageBefore, required) {
  try {
    return read("package.json");
  } catch (error) {
    if (required || JSON.parse(packageBefore).devDependencies?.knip) throw error;
    return "{}";
  }
}

export function verifyKnipContract(read, readBase) {
  const before = readBase("knip-baseline.json");
  const configBefore = readBase("knip.json");
  const packageBefore = readBase("package.json") ?? "{}";
  const packageAfter = currentPackage(read, packageBefore, before || configBefore);
  const enabled =
    [before, configBefore].some(Boolean) ||
    [packageAfter, packageBefore].some((value) => JSON.parse(value).devDependencies?.knip);
  if (!enabled) return;
  const config = JSON.parse(read("knip.json"));
  const candidate = JSON.parse(read("knip-baseline.json"));
  const previous = before && JSON.parse(before);
  const previousConfig = before && JSON.parse(configBefore);
  assertKnipBudget(candidate, config, previous, previousConfig);
  if (!knipPackageAllowed(packageBefore, packageAfter)) throw new Error("Knip package contract weakened");
  assertKnipWorkflow(read(".github/workflows/ci.yml"));
  const lock = assertKnipLock(JSON.parse(read("package-lock.json")));
  if (!before) return;
  const oldLock = assertKnipLock(JSON.parse(readBase("package-lock.json")));
  if (digest(lock) !== digest(oldLock)) throw new Error("Knip locked tool changed without review");
  const contractBefore = readBase("scripts/lint-knip-contract.mjs");
  if (!contractBefore || contractBefore !== read("scripts/lint-knip-contract.mjs")) {
    throw new Error("Knip bootstrap/contract changes need explicit review");
  }
}
