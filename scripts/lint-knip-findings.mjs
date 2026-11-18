import { createHash } from "node:crypto";
import { posix } from "node:path";

export const KNIP_VERSION = "6.45.1";
export const KNIP_CATEGORIES = [
  "binaries",
  "catalog",
  "catalogReferences",
  "cycles",
  "dependencies",
  "devDependencies",
  "duplicates",
  "enumMembers",
  "exports",
  "files",
  "namespaceMembers",
  "nsExports",
  "nsTypes",
  "optionalPeerDependencies",
  "subpaths",
  "types",
  "unlisted",
  "unresolved",
];

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected object`);
}

function keys(value, allowed, label) {
  object(value, label);
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label}: unknown field/category`);
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  );
}

export function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function knipPath(value) {
  if (typeof value !== "string" || !value || /[\0\r\n]/.test(value)) throw new Error("Invalid Knip file path");
  const path = value.replaceAll("\\", "/");
  if (path.startsWith("/") || /^[a-z]:/i.test(path) || path.split("/").includes("..")) {
    throw new Error(`Knip path outside repository: ${value}`);
  }
  const normalized = posix.normalize(path);
  if (normalized === ".") throw new Error("Knip file path is empty");
  return normalized;
}

function symbolIdentity(symbol) {
  keys(symbol, ["name", "namespace", "kind", "specifier", "line", "col", "pos"], "Knip symbol");
  if (typeof symbol.name !== "string" || !symbol.name) throw new Error("Knip symbol needs a name");
  if (symbol.namespace !== undefined && typeof symbol.namespace !== "string") throw new Error("Invalid namespace");
  for (const key of ["kind", "specifier"]) {
    if (symbol[key] !== undefined && typeof symbol[key] !== "string") throw new Error(`Invalid symbol ${key}`);
  }
  for (const key of ["line", "col", "pos"]) {
    if (symbol[key] !== undefined && !Number.isSafeInteger(symbol[key])) throw new Error(`Invalid symbol ${key}`);
  }
  return [symbol.namespace ?? "", symbol.name];
}

function issueIdentity(category, issue, file) {
  if (category === "duplicates" || category === "cycles") {
    if (!Array.isArray(issue) || !issue.length) throw new Error(`Invalid ${category} group`);
    return issue.map(symbolIdentity).sort((a, b) => {
      const left = JSON.stringify(a);
      const right = JSON.stringify(b);
      return left === right ? 0 : left < right ? -1 : 1;
    });
  }
  const identity = symbolIdentity(issue);
  if (category === "files") {
    if (knipPath(issue.name) !== file) throw new Error("File issue does not match its row");
    return file;
  }
  return identity;
}

function rowFindings(row, fingerprints) {
  keys(row, ["file", "owners", ...KNIP_CATEGORIES], "Knip row");
  const file = knipPath(row.file);
  if (row.owners !== undefined && !Array.isArray(row.owners)) throw new Error("Invalid owners");
  for (const category of KNIP_CATEGORIES) {
    if (!Array.isArray(row[category])) throw new Error(`Missing/invalid Knip category: ${category}`);
    for (const issue of row[category]) {
      const key = JSON.stringify([category, file, issueIdentity(category, issue, file)]);
      fingerprints[key] = (fingerprints[key] ?? 0) + 1;
    }
  }
}

export function parseKnipReport(value) {
  keys(value, ["issues"], "Knip report");
  if (!Array.isArray(value.issues)) throw new Error("Missing/invalid Knip issues");
  const fingerprints = Object.create(null);
  for (const row of value.issues) rowFindings(row, fingerprints);
  return canonical(fingerprints);
}

function validateFingerprint(key, count) {
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error("Invalid Knip fingerprint count");
  const tuple = JSON.parse(key);
  if (!Array.isArray(tuple) || tuple.length !== 3 || !KNIP_CATEGORIES.includes(tuple[0])) {
    throw new Error("Invalid Knip fingerprint identity");
  }
  if (knipPath(tuple[1]) !== tuple[1]) throw new Error("Noncanonical Knip fingerprint path");
  const [category, file, identity] = tuple;
  const symbol = (item) => {
    if (!Array.isArray(item) || item.length !== 2 || item.some((part) => typeof part !== "string") || !item[1]) {
      throw new Error("Invalid Knip symbol identity");
    }
    return { namespace: item[0], name: item[1] };
  };
  const grouped = category === "duplicates" || category === "cycles";
  const issue = grouped ? identity.map(symbol) : category === "files" ? { name: identity } : symbol(identity);
  if (JSON.stringify([category, file, issueIdentity(category, issue, file)]) !== key) {
    throw new Error("Noncanonical Knip fingerprint");
  }
}

export function validateKnipBaseline(value, config) {
  keys(value, ["schema", "toolVersion", "configDigest", "categories", "source", "fingerprints"], "Knip baseline");
  if (value.schema !== 1 || value.toolVersion !== KNIP_VERSION) throw new Error("Invalid Knip schema/tool version");
  if (value.configDigest !== digest(config)) throw new Error("Knip config digest mismatch");
  if (JSON.stringify(value.categories) !== JSON.stringify(KNIP_CATEGORIES))
    throw new Error("Knip category scope mismatch");
  if (!/^[a-f0-9]{40}$/.test(value.source)) throw new Error("Knip baseline requires its measured source SHA");
  object(value.fingerprints, "Knip fingerprints");
  for (const [key, count] of Object.entries(value.fingerprints)) validateFingerprint(key, count);
  return value.fingerprints;
}

export function assertKnipDownward(before, after, label = "Knip") {
  const added = Object.entries(after).filter(([key, count]) => count > (before[key] ?? 0));
  if (added.length)
    throw new Error(`${label}: new/increased findings (baselines may only shrink): ${JSON.stringify(added)}`);
}
