/**
 * The scenario tree and its graph, presented as one repository root (#582).
 *
 * The runner keeps them apart on purpose: `graphify-out` is moved OUT of the
 * tree so that no arm can read the graph as a file. `find_affected_files`
 * needs both — the graph to answer from, and the checkout to read a candidate
 * file's text — so it is handed a private root of symlinks instead. Nothing is
 * written into the tree, and the agent never learns this path.
 */
import { mkdtempSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function scenarioRoot(treeDir, graphDir) {
  const root = mkdtempSync(join(tmpdir(), "code-roi-arm-"));
  for (const entry of readdirSync(treeDir)) symlinkSync(join(treeDir, entry), join(root, entry));
  symlinkSync(join(graphDir, "graphify-out"), join(root, "graphify-out"));
  return root;
}
