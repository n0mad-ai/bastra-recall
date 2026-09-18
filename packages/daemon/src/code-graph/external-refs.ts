/**
 * Putting the package boundary back into the graph (#582).
 *
 * MEASURED, not assumed. On the 44 scenario graphs of the code-roi v3 sample
 * and on this repository's own graph, Graphify emits a node for every import
 * target it cannot place in the tree it analysed. Two shapes exist, and they
 * need different treatment:
 *
 *   {"id": "ref_bastra_recall_core",         "external": true, "source_file": ""}
 *   {"id": "ref_bastra_recall_core_scope",   "external": true, "source_file": ""}
 *       A BARE SPECIFIER: `@bastra-recall/core`, `@bastra-recall/core/scope`.
 *       The id is the specifier with every non-alphanumeric character turned
 *       into `_`, prefixed `ref_`. No symbol granularity at all — the edge
 *       says "this file imports that module", nothing more.
 *
 *   {"id": "packages_core_dist_index_savememory", "external": true, "source_file": ""}
 *   {"id": "packages_core_src_save_savememoryinput", ...}
 *       A RESOLVED PATH plus a lowercased SYMBOL name. Graphify did resolve
 *       the specifier (here through core's `main: ./dist/index.js`), but the
 *       target file is a build artifact or otherwise outside the analysed
 *       set, so the node carries no source file.
 *
 * Both are dropped by `validate.ts`, and they carry between a quarter and a
 * third of all import edges in this repository (3260 of 21442). Every
 * core→daemon relation lived in there, which is why the file-level diagnosis
 * missed six of its eight cases in `packages/core`.
 *
 * NOTHING IS INVENTED HERE. A path-shaped id is only accepted when both its
 * directory prefix and its trailing symbol name exist in the graph, and the
 * symbol must live under that directory. A bare specifier is only accepted
 * when a workspace package.json claims that exact name and its entry file
 * exists on disk (`workspace-packages.ts`). Anything else stays dropped: a
 * guessed edge is a blast radius over code the change never touched.
 */

import type { SafeNode } from "./validate.js";
import type { WorkspaceModules } from "./workspace-packages.js";

/** What an external node turned out to mean, once resolved. */
export interface ResolvedExternals {
  /** External node id -> the real symbol ids it stands for. */
  symbols: Map<string, string[]>;
  /** External node id -> the repo-relative entry file of that module. */
  modules: Map<string, string>;
}

/** An external node as it survives the read: id only, everything else dropped. */
export interface ExternalRef {
  id: string;
}

/**
 * Resolve the external nodes of one graph.
 *
 * @param externals  ids of nodes marked external / carrying no source file.
 * @param nodes      the code nodes that WERE kept, by id.
 * @param idsByLabel lowercased bare label -> node ids (the reader's index).
 * @param modules    specifier -> entry source file, from the workspace manifests.
 */
export function resolveExternals(
  externals: readonly string[],
  nodes: ReadonlyMap<string, SafeNode>,
  idsByLabel: ReadonlyMap<string, string[]>,
  modules: WorkspaceModules,
): ResolvedExternals {
  const symbols = new Map<string, string[]>();
  const moduleEntries = new Map<string, string>();
  if (externals.length === 0) return { symbols, modules: moduleEntries };

  const bySpecifierKey = new Map<string, string>();
  for (const [specifier, file] of modules) bySpecifierKey.set(underscored(specifier), file);

  // Every directory that holds at least one indexed file, in the same
  // underscored spelling the ids use. `packages/core/src/save.ts` contributes
  // `packages`, `packages_core` and `packages_core_src`.
  const dirs = new Set<string>();
  for (const node of nodes.values()) {
    const parts = node.file.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(underscored(parts.slice(0, i).join("/")));
  }

  for (const id of externals) {
    const key = id.toLowerCase();
    if (key.startsWith("ref_")) {
      const file = bySpecifierKey.get(key.slice(4));
      if (file !== undefined) moduleEntries.set(id, file);
      continue;
    }
    const resolved = resolveSymbolRef(key, dirs, nodes, idsByLabel);
    if (resolved !== null) symbols.set(id, resolved);
  }
  return { symbols, modules: moduleEntries };
}

/**
 * A path-shaped external id split into "directory" and "symbol name".
 *
 * The split is not derivable — `_` is both the path separator in these ids and
 * a legal character in a symbol name (`AUTO_RELATED_END` appears as
 * `..._auto_related_end`). So both halves are checked against the graph: the
 * LONGEST directory prefix that really exists, then the LONGEST remaining
 * suffix that is really a symbol label of a file under it. Longest first, so
 * `..._auto_related_end` resolves to `AUTO_RELATED_END` and not to a symbol
 * called `end` somewhere else in the package.
 */
function resolveSymbolRef(
  key: string,
  dirs: ReadonlySet<string>,
  nodes: ReadonlyMap<string, SafeNode>,
  idsByLabel: ReadonlyMap<string, string[]>,
): string[] | null {
  let dir: string | null = null;
  for (const candidate of dirs) {
    if (!key.startsWith(`${candidate}_`)) continue;
    if (dir === null || candidate.length > dir.length) dir = candidate;
  }
  if (dir === null) return null;

  const prefix = `${dir}_`;
  const tokens = key.slice(prefix.length).split("_");
  for (let i = 0; i < tokens.length; i++) {
    const name = tokens.slice(i).join("_");
    const hits = (idsByLabel.get(name) ?? []).filter((nodeId) => {
      const node = nodes.get(nodeId);
      return node !== undefined && underscored(node.file).startsWith(prefix);
    });
    if (hits.length > 0) return hits;
  }
  return null;
}

/**
 * Graphify's id spelling: every character that is not a letter or a digit
 * becomes `_`, lowercased, and a leading run of them is dropped — `@` in
 * `@bastra-recall/core` would otherwise leave the key starting with `_`.
 */
function underscored(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/^_+/, "");
}
