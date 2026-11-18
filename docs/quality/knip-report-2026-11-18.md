# Knip measurement for #1534 — 18 November 2026

This initial static-analysis report is a candidate list, not removal advice or a new CI gate. No export, dependency, project package manifest, lockfile, or public entry point was changed by the measurement. Export cleanup is deferred until the remaining source refactorings; the CI-versus-report decision remains with the owner.

## Measured state

- Tool: **Knip 6.45.1**, installed with an exact version outside the repository, lifecycle scripts disabled. The installed CLI reported 6.45.1.
- [Official release](https://github.com/webpro-nl/knip/releases/tag/knip%406.45.1), published 11 November 2026; verified through the GitHub release API.
- Node: **v24.16.0**, macOS. Base HEAD: 42cb5b16c6825c152c5ed25f5be8c06663e9bf6d, plus the uncommitted Block 2.2 lint/CI/formatter changes. This is not a measurement of the final release tree.
- Run: 2026-11-18T00:00:21.574669+00:00; exit **0** with --no-exit-code. Findings remain in the JSON; fatal configuration/internal errors would still return 2.
- The main measurement used the shared test lock, nice -n 15, isolated HOME/cache directories, and a 180-second process limit. Starting one-minute load: 4.88. It completed in 1.25 seconds; one observed run is not a performance comparison.
- All **2025** measured source/manifest files had identical before/after hashes. Another worker's documentation-only edits are outside this hash set.
- Configuration SHA-256: 616c41edc71dc94ad8985cd3d6b82c300a553db94908d83c7259ffb819598f9a.

## Findings

Counts are individual JSON records, not distinct files unless stated.

| Category | Candidates |
| --- | ---: |
| Unused files | 36 |
| Unused runtime exports | 255 |
| Unused exported types | 156 |
| Unresolved imports | 22 |
| Dependencies / devDependencies | 3 / 2 |
| Unlisted dependencies / binaries | 38 / 21 |
| Duplicate-export findings | 2 |

The reporter produced **284 file records**. An unresolved import limits the analysis; it is not evidence that the importing code can be removed.

### Exports referenced inside their own module

The ignoreExportsUsedInFile option was omitted. A separate bounded TypeScript-symbol pass over Knip's declarations found **226 runtime-export candidates** and **123 type candidates** with references to the same bound symbol in their own source file. Re-export specifiers were excluded from this supplementary classification.

These are candidates for manual caller checks, not proof of no external use. The local binding pass uses noResolve and cannot repair Knip resolution gaps or model other repositories. It exited 0 within a 60-second process limit. Its sandbox warned “nice: setpriority: Operation not permitted”; no scheduling/performance claim is made for that postprocessing pass. The main Knip run above used priority reduction separately without that warning.

Examples from this measured tree:

| File | Symbol | Same-file reference lines |
| --- | --- | --- |
| packages/daemon/src/import/adapters.ts | MAX_RECALL_WHEN_CHARS | 48, 50, 52, 61 |
| packages/daemon/src/documents-write-shared.ts | isProductDoc | 362 |
| packages/daemon/src/edit-memory-handler.ts | applyBodyOps | 375, 537 |
| packages/daemon/src/code-graph/find-code.ts | MAX_AFFECTED_FILES | 338, 339 |

## Public entry points retained

The debug log confirms one analysis principal covering the root and all five package workspaces.

| Workspace | Explicitly protected surface |
| --- | --- |
| packages/core | Main src/index.ts and source counterparts of all seven package export targets: index, scrub, topics, scope, rrf, platform-paths, runtime-settings. Knip also source-mapped package dist targets. |
| packages/daemon | Main and all 12 manifest bin targets, mapped to source; browser JS/HTML and shims conservatively treated as entries. |
| packages/statusline | Main source, three bin wrappers, and **all published src files**. |
| packages/bastra-recall | Installer bin/bastra.mjs, shared by both manifest bin names. |
| packages/eval | Package script entry files and tests. |

The manifest snapshot is retained with the raw evidence. Core also publishes its source tree; external direct-source consumers cannot be disproved by a local run. No public API was removed.

## Analysis limits and open decisions

- Conservative published/browser entry protection excludes their entry exports from findings. This prevents unsafe deletion advice and can hide dead exports within those surfaces.
- Ordinary Gitignore behavior and selected project globs remain in force. Generated output, local scratch, non-JavaScript/TypeScript assets, and other repositories are not a completeness claim. Tests/scripts can make runtime exports appear used; test-only policy remains in #1522.
- There are **22 unresolved imports**, including browser /ui/js paths in a probe, old assistant-address fixture sibling imports, and UI engine imports. None was patched or dismissed by this measurement.
- Debug output also reports unsuccessful reads of directory-like dynamic paths and packages/daemon/src/cli/task-approval-cmd.ts. These remain visible in the diagnostics. The main run had empty stderr and no fatal plugin/configuration error; exit 0 does not imply complete resolution.
- Runtime-computed paths, hooks, bundled binaries, Mac-app consumers, and external direct-source imports require caller review before any removal. No export keyword was removed, so no removed-export counter-review is claimed.
- Owner question: should Knip become a ratcheted CI gate or remain a reporting tool? This report adds neither a CI stage nor an unused-code baseline.

## Reproduce

From the measured checkout, choose an external measurement directory; install only the pinned tool there, without modifying project dependencies. The recorded command is equivalent to:

```sh
npm install --prefix "$MEASURE_DIR/tool" --no-save --package-lock=false   --ignore-scripts --no-audit --no-fund knip@6.45.1
node "$MEASURE_DIR/tool/node_modules/knip/bin/knip.js" --version
nice -n 15 node "$MEASURE_DIR/tool/node_modules/knip/bin/knip.js"   --directory "$REPO" --config "$MEASURE_DIR/knip.measure.json"   --reporter json --output-file "json=$MEASURE_DIR/knip.raw.json"   --no-exit-code --no-progress --debug
```

The actual runner additionally enforced the shared mkdir/rmdir lock, load below 8, isolated HOME/cache paths, captured stdout/stderr, a 180-second timeout, and source-hash comparisons. MEASURE_DIR and REPO denote task-specific paths.

Save this exact configuration as knip.measure.json:

```json
{
  "includeEntryExports": false,
  "includeSubpathExports": false,
  "workspaces": {
    ".": {
      "entry": [
        "*.mjs",
        "scripts/**/*.{ts,mts,js,mjs}",
        "tools/__tests__/**/*.test.mjs",
        "tools/probes/**/*.{ts,mts,js,mjs}"
      ],
      "project": [
        "*.mjs",
        "scripts/**/*.{ts,mts,js,mjs}",
        "tools/**/*.{ts,mts,js,mjs}"
      ]
    },
    "packages/core": {
      "entry": [
        "__tests__/**/*.{test,spec}.{ts,mts,js,mjs}",
        "scripts/**/*.{ts,mts,js,mjs}",
        "src/index.ts",
        "src/platform-paths.ts",
        "src/rrf.ts",
        "src/runtime-settings.ts",
        "src/scope.ts",
        "src/scrub.ts",
        "src/topics.ts"
      ],
      "project": [
        "src/**/*.{ts,mts,js,mjs}",
        "__tests__/**/*.{ts,mts,js,mjs}",
        "scripts/**/*.{ts,mts,js,mjs}",
        "test/**/*.{ts,mts,js,mjs}",
        "bin/*",
        "webui/**/*.{js,html}",
        "shims/**/*.{js,mjs}"
      ]
    },
    "packages/daemon": {
      "entry": [
        "__tests__/**/*.{test,spec}.{ts,mts,js,mjs}",
        "scripts/**/*.{ts,mts,js,mjs}",
        "shims/**/*.{js,mjs}",
        "src/bash-fail-hook.ts",
        "src/bash-pre-hook.ts",
        "src/bridge.ts",
        "src/cli.ts",
        "src/gate-hook.ts",
        "src/hook.ts",
        "src/index.ts",
        "src/mcp-forwarder.ts",
        "src/prompt-hook.ts",
        "src/session-hook.ts",
        "src/stop-hook.ts",
        "src/todo-hook.ts",
        "webui/**/*.html",
        "webui/**/*.js"
      ],
      "project": [
        "src/**/*.{ts,mts,js,mjs}",
        "__tests__/**/*.{ts,mts,js,mjs}",
        "scripts/**/*.{ts,mts,js,mjs}",
        "test/**/*.{ts,mts,js,mjs}",
        "bin/*",
        "webui/**/*.{js,html}",
        "shims/**/*.{js,mjs}"
      ]
    },
    "packages/statusline": {
      "entry": [
        "__tests__/**/*.{test,spec}.{ts,mts,js,mjs}",
        "bin/*",
        "scripts/**/*.{ts,mts,js,mjs}",
        "src/**/*.{ts,mts,js,mjs}",
        "test/**/*.{ts,mts,js,mjs}"
      ],
      "project": [
        "src/**/*.{ts,mts,js,mjs}",
        "__tests__/**/*.{ts,mts,js,mjs}",
        "scripts/**/*.{ts,mts,js,mjs}",
        "test/**/*.{ts,mts,js,mjs}",
        "bin/*",
        "webui/**/*.{js,html}",
        "shims/**/*.{js,mjs}"
      ]
    },
    "packages/bastra-recall": {
      "entry": [
        "__tests__/**/*.{test,spec}.{ts,mts,js,mjs}",
        "bin/*.mjs",
        "scripts/**/*.{ts,mts,js,mjs}"
      ],
      "project": [
        "src/**/*.{ts,mts,js,mjs}",
        "__tests__/**/*.{ts,mts,js,mjs}",
        "scripts/**/*.{ts,mts,js,mjs}",
        "test/**/*.{ts,mts,js,mjs}",
        "bin/*",
        "webui/**/*.{js,html}",
        "shims/**/*.{js,mjs}"
      ]
    },
    "packages/eval": {
      "entry": [
        "__tests__/**/*.{test,spec}.{ts,mts,js,mjs}",
        "scripts/**/*.{ts,mts,js,mjs}",
        "src/absence-honesty.ts",
        "src/bm25-expansion.ts",
        "src/bridge-transfer.ts",
        "src/candidate-union.ts",
        "src/doc2query-lift.ts",
        "src/evidence-windows-run.ts",
        "src/hook-context-load.ts",
        "src/longmemeval-run.ts",
        "src/marginal-lift.ts",
        "src/persona-lift.ts",
        "src/pool-depth.ts",
        "src/rerank-longmemeval.ts",
        "src/rerank-pool-coverage.ts",
        "src/rerank-replay.ts",
        "src/router-lift.ts",
        "src/rrf-k-beir.ts",
        "src/salience-lift.ts",
        "src/tripwire-usage.ts",
        "src/trust-lift.ts"
      ],
      "project": [
        "src/**/*.{ts,mts,js,mjs}",
        "__tests__/**/*.{ts,mts,js,mjs}",
        "scripts/**/*.{ts,mts,js,mjs}",
        "test/**/*.{ts,mts,js,mjs}",
        "bin/*",
        "webui/**/*.{js,html}",
        "shims/**/*.{js,mjs}"
      ]
    }
  }
}
```

## Retained evidence

The release-work scratch directory scratchpad/bau/block2-knip1534/ contains:

- knip.raw.json, category-specific JSON slices, summary-counts.json.
- knip.measure.json, public-entries-manifest.json, measurement.json, source-before.json.
- knip.stdout.log (debug/source mapping/resolution), knip.stderr.log (empty), install.log, version.txt.
- own-module-candidates.json, classify-local.mjs, classify-local.log, classify-status.json.
- The bounded install.py and measure.py runners.

Raw evidence remains available for the final #1534 issue update; it is not a committed baseline. Only the first-report portion of #1534 is covered. CI policy, later export cleanup, and independent removal review remain open.

## Primary documentation

- [CLI, JSON output, exit semantics](https://knip.dev/reference/cli).
- [Public entries and export configuration](https://knip.dev/reference/configuration).
- [Workspace graph and source mapping](https://knip.dev/features/monorepos-and-workspaces).
