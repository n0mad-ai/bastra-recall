/**
 * Preflight and build pin for the runner (#582, Codex counter-review 4).
 *
 * THE GAP. `run-arms-v3.mjs` imports `packages/daemon/dist` — never `src` —
 * but the start command never built it and never checked what was already
 * there. Codex found `dist/.build-revision` reading `7bd65b6` while HEAD was
 * at `461ab58`: an unguarded run that morning would have served a stale
 * server and called it the registered one, silently. Worse, the run is taken
 * in HELPINGS across subscription windows (`run_conditions.stretched_run`),
 * so without a check two helpings of the SAME archive could each be served by
 * a different product revision and the report would average them as one.
 *
 * THREE THINGS, checked in order, every invocation:
 *   1. `dist/.build-revision` exists and names HEAD (`preflightBuild`).
 *   2. The worktree is clean over the sources that produced it — a match to a
 *      DIRTY HEAD is not a match to what will be committed.
 *   3. The four `arms.frozen_surface` hashes, recomputed from the BUILT
 *      artefacts (not `src` — `code-graph-affected.test.ts` already guards
 *      that end), still match the registration.
 *
 * All three have to hold before a helping does anything; `preflightBuild`
 * never throws, so a caller prints the message and stops. What passes those
 * three is then PINNED into the archive (`build-pin.json`) on the first
 * helping and CHECKED against on every later one (`checkBuildPin`), the same
 * shape `mutation-gate.mjs`'s `checkPopulation` uses for its own population
 * pin: a mismatch is an error, never a silent re-pin or overwrite.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_REGISTRATION_ID, loadRegistrationById } from "./registration.mjs";

/** Repository root — this file lives at `packages/eval/code-roi/v2/`. */
export const REPO_ROOT = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
/** Where the runner's own imports come from — never `src` (#582). */
export const DIST_DAEMON_DIR = new URL("../../../daemon/dist", import.meta.url).pathname.replace(/\/$/, "");

/** The tracked sources a built `dist` claims to represent. */
export const TRACKED_BUILD_INPUTS = ["packages/daemon/src", "packages/eval"];

export function loadRegistration(id = DEFAULT_REGISTRATION_ID) {
  return loadRegistrationById(id);
}

/**
 * `dist/.build-revision`, the way `scripts/write-build-revision.mjs` writes
 * it: `revision=<sha>\ndirty=<bool>\nbuilt_at=<iso>\n` — key=value lines, not
 * a bare SHA.
 */
export function parseBuildRevision(text) {
  const fields = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  if (!fields.revision) return null;
  return { revision: fields.revision, dirty: fields.dirty === "true", builtAt: fields.built_at ?? null };
}

/** The dist build's own stamp, or `null` when there is none at all. */
export function readBuildRevision(distDaemonDir = DIST_DAEMON_DIR) {
  const path = join(distDaemonDir, ".build-revision");
  if (!existsSync(path)) return null;
  return parseBuildRevision(readFileSync(path, "utf8"));
}

export function gitHeadSha(cwd = REPO_ROOT) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

/** `git status --porcelain`, restricted to the given pathspecs. Empty means clean. */
export function gitPorcelainStatus(cwd = REPO_ROOT, pathspecs = TRACKED_BUILD_INPUTS) {
  return execFileSync("git", ["status", "--porcelain", "--", ...pathspecs], { cwd, encoding: "utf8" })
    .split("\n")
    .filter((l) => l.trim() !== "");
}

/**
 * The four frozen-surface hashes, computed from the BUILT artefacts.
 *
 * The same four numbers `code-graph-affected.test.ts` pins from `src` — this
 * is the runner's own copy of that computation, run against `dist`, because
 * the runner imports `dist` and a source-only check would pass while the
 * built server it actually spawns had already drifted from it.
 */
export async function frozenSurfaceHashesFromDist(distDaemonDir = DIST_DAEMON_DIR) {
  const { affectedTools } = await import(`${distDaemonDir}/code-graph/find-affected-files.js`);
  const { SERVER_INSTRUCTIONS, CODE_AWARENESS_CLAUSE, serverInstructions } = await import(
    `${distDaemonDir}/mcp-instructions.js`
  );
  const sha = (v) => createHash("sha256").update(v).digest("hex");
  return {
    tool_definition_sha256: sha(JSON.stringify(affectedTools[0])),
    server_instructions_sha256: sha(serverInstructions(true)),
    memory_part_sha256: sha(SERVER_INSTRUCTIONS),
    code_clause_sha256: sha(CODE_AWARENESS_CLAUSE),
  };
}

/**
 * The DELIVERED surface: the prompt-lane block and every compiled code-graph
 * module that can influence whether it fires or what it says (#606).
 *
 * `block_template_sha256` is the rendering function itself, so a reworded lead
 * or a changed attribute list is caught even when the rest of the module moves
 * around it. The bundle hash binds ALL `code-graph/*.js` files in sorted order:
 * intent resolution, cache/reader indexes, affected traversal, narrowing and
 * rendering are one observed surface. Pinning only the three top-level files
 * misses changes in `diff-lines`, `symbol-spans`, `reader` and their peers.
 */
export async function deliveredSurfaceHashesFromDist(distDaemonDir = DIST_DAEMON_DIR) {
  const { renderImpactBlock } = await import(`${distDaemonDir}/code-graph/impact-block.js`);
  const sha = (v) => createHash("sha256").update(v).digest("hex");
  const files = readdirSync(join(distDaemonDir, "code-graph"))
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => `code-graph/${f}`);
  const bundle = files.map((rel) => `${rel}\0${readFileSync(join(distDaemonDir, rel))}`).join("\0");
  return {
    block_template_sha256: sha(renderImpactBlock.toString()),
    code_graph_bundle_sha256: sha(bundle),
  };
}

/**
 * The frozen surface of WHICHEVER registration is being served.
 *
 * `kind` is the registration's own word for what its arms are served: the
 * change-impact registration serves an MCP tool surface, #606 serves a block.
 * A registration that names no kind is the change-impact one, which predates
 * the field and may not be amended to carry it.
 */
export async function frozenSurfaceOf(registration, distDaemonDir = DIST_DAEMON_DIR) {
  const kind = registration.arms?.frozen_surface?.kind ?? "mcp_surface";
  if (kind === "delivered_block") return deliveredSurfaceHashesFromDist(distDaemonDir);
  if (kind === "mcp_surface") return frozenSurfaceHashesFromDist(distDaemonDir);
  throw new Error(`unknown frozen surface kind "${kind}" — the runner cannot check what it cannot compute`);
}

/**
 * Where the built surface differs from what the registration pins, field by
 * field. Every `*_sha256` field of the registration's frozen surface is
 * checked, so a registration that adds one cannot have it silently ignored.
 */
export function frozenSurfaceMismatches(hashes, registration) {
  const frozen = registration.arms.frozen_surface;
  return Object.keys(frozen)
    .filter((field) => field.endsWith("sha256"))
    .filter((field) => hashes[field] !== frozen[field])
    .map((field) => ({ field, registered: frozen[field], built: hashes[field] ?? null }));
}

/**
 * sha256 of the dist artefacts the frozen surface and every arm are actually
 * served from, keyed by their path relative to `dist`. `code-graph/*.js`
 * because that is what `find-affected-files.js` and `find-code.js` pull in
 * transitively; `tool-defs.js` because arm B's ENTIRE surface — not just the
 * two code tools — comes from it (`GRAPH_TOOLS` in `run-arms-v3.mjs`);
 * `mcp-instructions.js` because that is the frozen surface itself.
 */
export function distArtifactHashes(distDaemonDir = DIST_DAEMON_DIR) {
  const files = [
    "tool-defs.js",
    "mcp-instructions.js",
    ...readdirSync(join(distDaemonDir, "code-graph"))
      .filter((f) => f.endsWith(".js"))
      .sort()
      .map((f) => `code-graph/${f}`),
  ];
  return Object.fromEntries(
    files.map((rel) => [
      rel,
      createHash("sha256").update(readFileSync(join(distDaemonDir, rel))).digest("hex"),
    ]),
  );
}

/**
 * The fail-fast gate, run once before the first arm of every helping.
 *
 * Never throws — a caller prints `.message` and stops — because the whole
 * point is a clean abort before any money is spent, not a stack trace half
 * way through a scenario.
 */
export async function preflightBuild({
  repoRoot = REPO_ROOT,
  distDaemonDir = DIST_DAEMON_DIR,
  registrationId = DEFAULT_REGISTRATION_ID,
  registration = loadRegistration(registrationId),
} = {}) {
  if (registration.status === "numbers_registered_population_pending") {
    return {
      ok: false,
      reason: "population_pending",
      message: `${registrationId}: the amended truth rule has not been re-mined and frozen; no arm may start`,
    };
  }
  // #607: `run_completed` (introduced by registration_version 6 of the
  // change-impact file, reused by registration_version 3 here) is terminal —
  // `no_further_changes` in the registration means exactly that. Before this
  // check, nothing stopped an accidental re-run from starting a new arm under
  // an id whose numbers are already reported; the frozen-surface check below
  // would then also start refusing every unrelated later edit to
  // `packages/daemon/src`, which is not what it is for once the run is done.
  if (registration.status === "run_completed") {
    return {
      ok: false,
      reason: "run_completed",
      message: `${registrationId}: registration_version ${registration.registration_version} already completed its run (no_further_changes) — no further arm may start under this id`,
    };
  }
  const headSha = gitHeadSha(repoRoot);
  const distRevision = readBuildRevision(distDaemonDir);
  if (distRevision === null) {
    return {
      ok: false,
      reason: "no_build_revision",
      message:
        `packages/daemon/dist has no .build-revision — run \`npm run build\` before starting an arm. ` +
        `The runner imports dist directly; an unbuilt or hand-copied dist has no record of which ` +
        `source it came from.`,
    };
  }
  if (distRevision.revision !== headSha) {
    return {
      ok: false,
      reason: "stale_build",
      message:
        `dist is built from ${distRevision.revision} but HEAD is ${headSha} — run \`npm run build\` ` +
        `and retry. Without this check, two helpings of the same archive could each be served by a ` +
        `different product revision and the report would average them as one.`,
    };
  }
  if (distRevision.dirty) {
    return {
      ok: false,
      reason: "dirty_build",
      message:
        `packages/daemon/dist was built from a dirty worktree at ${headSha} — run \`npm run build\` ` +
        `from the clean registered checkout and retry. A matching revision does not prove that the ` +
        `emitted JavaScript came from that revision when the build stamp itself says otherwise.`,
    };
  }
  const dirty = gitPorcelainStatus(repoRoot, TRACKED_BUILD_INPUTS);
  if (dirty.length > 0) {
    return {
      ok: false,
      reason: "dirty_worktree",
      message:
        `uncommitted changes in ${TRACKED_BUILD_INPUTS.join(", ")} — commit or stash them first. ` +
        `dist matching HEAD proves nothing when HEAD itself is not what is on disk:\n${dirty.join("\n")}`,
    };
  }
  const frozenSurface = await frozenSurfaceOf(registration, distDaemonDir);
  const mismatches = frozenSurfaceMismatches(frozenSurface, registration);
  if (mismatches.length > 0) {
    return {
      ok: false,
      reason: "frozen_surface_drift",
      message:
        `the built frozen surface no longer matches arms.frozen_surface in the registration:\n` +
        mismatches.map((m) => `  ${m.field}: registered ${m.registered}, built ${m.built}`).join("\n"),
    };
  }
  const pin = {
    headSha,
    distRevision,
    frozenSurface,
    artifactHashes: distArtifactHashes(distDaemonDir),
    // WHICH registration, not just which version of it: two registrations now
    // share this archive layout and a helping started against the wrong one
    // would otherwise differ in nothing the pin can see (#606).
    registrationId,
    registrationVersion: registration.registration_version,
    computedAt: new Date().toISOString(),
  };
  return { ok: true, pin };
}

/**
 * A pin's fields, flattened and EXCLUDING `computedAt` — that changes on
 * every invocation and is not a fact about the build, so including it would
 * make every resumed helping "drift" against its own archive.
 */
export function pinFields(pin) {
  const fields = {
    // `registrationId` is deliberately NOT here, and neither is it in
    // `pinSignature` below. Adding a field to the signature would change the
    // signature of every build — including the one the v6 archive's transcripts
    // were stamped with — and `mixed_builds` would turn true across a finished
    // measurement that never changed. It is checked on its own in
    // `checkBuildPin` instead, where a missing value means the registration
    // that predates the field (#606).
    headSha: pin.headSha,
    "distRevision.revision": pin.distRevision.revision,
    "distRevision.dirty": String(pin.distRevision.dirty),
    registrationVersion: String(pin.registrationVersion),
  };
  for (const [k, v] of Object.entries(pin.frozenSurface)) fields[`frozenSurface.${k}`] = v;
  for (const [k, v] of Object.entries(pin.artifactHashes)) fields[`artifactHashes.${k}`] = v;
  return fields;
}

/** A stable signature over everything that makes two pins the SAME build. */
export function pinSignature(pin) {
  const fields = pinFields(pin);
  const canonical = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Every field where a recorded pin and the current one disagree — ALL of
 * them, not just the first. An abort message that named only one differing
 * field would hide a second (the dist revision moved AND a hash moved), which
 * is exactly the kind of partial diff `arms.frozen_surface`'s own
 * `$amendment_clause_hash` was written to stop happening again.
 */
export function diffBuildPin(recorded, current) {
  const a = pinFields(recorded);
  const b = pinFields(current);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diff = [];
  for (const key of [...keys].sort()) {
    if (a[key] !== b[key]) diff.push({ field: key, recorded: a[key] ?? null, current: b[key] ?? null });
  }
  return diff;
}

/**
 * Pin the build on the first helping, check it on every later one.
 *
 * Mirrors `mutation-gate.mjs`'s `checkPopulation`: `recorded === null` means
 * "first run, go ahead and write it"; any other mismatch is `ok: false` and
 * NEVER `write: true` — a resumed helping cannot quietly re-pin itself to
 * whatever build happens to be sitting in `dist` that day.
 */
export function checkBuildPin(recorded, current) {
  if (recorded === null) return { ok: true, write: true, diff: [] };
  const diff = diffBuildPin(recorded, current);
  // The registration this archive belongs to, checked beside the build. An
  // archive started under one registration and resumed under another would
  // otherwise pass every hash check and still be two measurements in one
  // directory (#606).
  const recordedId = recorded.registrationId ?? DEFAULT_REGISTRATION_ID;
  const currentId = current.registrationId ?? DEFAULT_REGISTRATION_ID;
  if (recordedId !== currentId) {
    diff.unshift({ field: "registrationId", recorded: recordedId, current: currentId });
  }
  return diff.length === 0 ? { ok: true, write: false, diff: [] } : { ok: false, write: false, diff };
}

export function buildPinPath(outDir) {
  return join(outDir, "build-pin.json");
}

/** The archive's recorded pin, or `null` when this is the first helping. */
export function readBuildPin(outDir) {
  const path = buildPinPath(outDir);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function formatBuildPinDiff(diff) {
  return diff.map((d) => `  ${d.field}: pinned ${d.recorded}, now ${d.current}`).join("\n");
}
