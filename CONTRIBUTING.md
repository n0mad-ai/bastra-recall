# Contributing to Bastra Recall

Thanks for considering a contribution. Bastra is solo-maintained, so the
workflow is light — but a few conventions keep things smooth.

## Before you start

- **Version 1.0.** Open an issue before a large PR so we can
  agree on scope and avoid duplicate work.
- **One maintainer.** Response times vary; a clear example or reproduction helps.
- **Scope rule:** the OSS core must stay fully functional **without** the
  paid Mac app. Don't propose changes that move OSS features behind a tier.
  What is free stays free. Writing documents (`save_document`) and text
  recognition (OCR) were never part of the free feature set: document writing
  has been off behind `BASTRA_DOCUMENT_WRITE=1` since it was added, and both
  belong to the paid tier, Recall Pulse ([README](./README.md#free-and-recall-pulse)).

## Ways to contribute

| Type | How |
|---|---|
| 🐛 Bug | [Open a bug report](https://github.com/n0mad-ai/bastra-recall/issues/new?template=bug_report.yml) — the form pre-fills the required context (`bastra doctor`, surface, OS, logs) |
| 💡 Feature | [Suggest a feature](https://github.com/n0mad-ai/bastra-recall/issues/new?template=feature_request.yml) — please describe the **problem**, not the solution |
| 💬 Question | [Start a discussion](https://github.com/n0mad-ai/bastra-recall/discussions) |
| 🔧 Code | See "Development setup" below |
| 💖 Sponsor | [github.com/sponsors/n0mad-ai](https://github.com/sponsors/n0mad-ai) — credited in [SUPPORTERS.md](./SUPPORTERS.md) |

## Claiming an issue

If you'd like to work on something — especially a `good first issue` —
drop a short comment on the issue:

> Hi! I'd like to work on this.

You'll be assigned (usually within a day) so nobody duplicates the work.
Once assigned, the issue is yours. If you can't get to it within ~2 weeks,
please leave a note so it can free up for someone else.

Already a few commits in by the time you comment? Even better — link the
branch in your fork.

## Development setup

### Requirements

- Node ≥ 24.16 (`node --version`) — the runtime floor in the workspace
  `engines` field and `MIN_NODE_VERSION` in
  `packages/daemon/src/node-support.ts`; CI tests Node 24 and 26. Node 22
  is no longer supported
- macOS for the full experience (Linux works for daemon + CLI; some
  adapters are macOS-only)
- npm (comes with Node)

### Clone, install, build

```bash
git clone https://github.com/n0mad-ai/bastra-recall.git
cd bastra-recall
npm install
npm run build
```

The repo is an npm workspace — `npm install` at the root pulls every
package's dependencies; `npm run build` compiles every workspace.

For a source-checkout deployment, run `npm run build:deploy` before `bastra update`.
This builds every workspace, compiles the host hook binary (Deno required), and
verifies both its hook sources and embedded statusline. Ordinary `npm run build`
remains a development build; it does not replace the hook binary. Source updates
refuse activation when a compiled hook they would use is stale or unverifiable.
The release workflow compiles every target and verifies the native executable
against the current source and statusline digests before uploading artifacts.

Für ein Deployment aus dem Checkout vor `bastra update` zuerst
`npm run build:deploy` ausführen (Deno erforderlich). Der Befehl baut alle
Workspaces und das Hook-Binary und prüft dessen Quellen sowie die eingebettete
Statuszeile. `npm run build` bleibt ein Entwicklungsbuild ohne Austausch des
Hook-Binarys. Ein Source-Update bricht vor Registrierung und Neustart ab, wenn
es ein veraltetes oder nicht prüfbares Hook-Binary verwenden würde.
Der Release-Workflow kompiliert alle Targets und prüft vor dem Hochladen der
Artefakte das native Binary gegen die aktuellen Quellen- und Statusline-Digests.


### Type-check (no emit)

```bash
npm run check:types
```

### Run tests

Run `npm test` from the repo root for the full suite. CI always runs the full
suite; the optional coverage map is for faster local feedback on small edits
in a POSIX checkout:

```bash
npm run build
npm run test:map      # on a clean tree: record which test files execute each line
# edit code
npm run test:changed  # run the tests that executed the changed lines
```

The generated `.test-map/` directory is git-ignored. Map construction runs each
test file under coverage, so expect it to take longer than an ordinary test run.
After changing `packages/core/src`, run `npm run build` before `test:changed`:
the selected tests can import built packages, and this command does not rebuild.

`test:changed` prints its selection and anything it cannot vouch for, such as
uncovered lines, unseen files, or a map built on a dirty tree. Exit 3 means the
selected tests passed but did not cover the whole change; a missing map or a
map whose commit is unavailable exits 2. Run `npm test` for full validation,
or rebuild with `npm run test:map` on a clean tree when the map needs refreshing.
An older map is compared against its recorded commit, so intervening changes
are included. Global files (for example `package.json`) and test fixtures
already select the full suite. Other uncertainties do not automatically trigger
a full run: they stay visible and nonzero, keeping the local command predictable.

### Invariants

[docs/invariants.md](docs/invariants.md) lists the promises bastra-recall makes
to its users: no silent data loss, the security boundaries, honest answers and
the external contracts. `npm run test:invariants` builds core and daemon and
runs exactly the tests that hold them, in about ten seconds; run it before
you hand in a change. They also run in `npm test`.

Add an invariant when a change creates a promise whose breach would harm a
user (lost or overwritten data, an opened boundary, a wrong answer, a broken
client contract) and no listed invariant covers it. Implementation details and
"nice to have" checks do not belong there. If an existing test already holds
the promise, prefix its title with the new ID instead of writing a second test;
otherwise write the test in a `*.invariant.test.ts` file in the package's
`__tests__` folder. Then add the row to the catalog.

An invariant test is never weakened, skipped or deleted on its own. If a promise
really changes, change or remove its catalog entry first, on purpose, and say
why in the commit message. `tools/__tests__/invariants-catalog.test.mjs` fails
when the catalog and the tests disagree.

### Run the daemon locally

```bash
cd packages/daemon
npm run dev
```

Listens on `127.0.0.1:6723`. Logs go to stdout/stderr.

### Use a test vault, not your real one

The daemon mutates files in the vault. Always set
`BASTRA_VAULT_PATH` to a throwaway folder while developing:

```bash
BASTRA_VAULT_PATH=/tmp/bastra-dev-vault npm run dev
```

### Smoke-test

```bash
npm run smoke
```

This uses the public `fixtures/sample-vault` so a fresh clone can verify recall
quality without private data.

### Package check

```bash
npm run pack:check
```

This runs npm pack dry-runs for the publishable workspaces and catches missing
runtime assets such as the packaged Skill or statusline bundle.

## Project structure

```
packages/
  core/       Vault parsing, search index, save logic — no I/O surface
  daemon/     MCP server, HTTP REST, hooks, `bastra` CLI
  skill/      SKILL.md + its reference files, shared across supported clients
distribution/
  homebrew/   Homebrew formula
  install.sh               curl installer, mirrored to bastra.io/install
  Install Bastra.command   macOS installer (right-click → Open)
  Uninstall Bastra.command Double-click uninstaller (never touches the vault)
scripts/      One-off telemetry / eval / backfill scripts
```

### Where your change probably lives

- **Search / recall behavior** → `packages/core/`
- **New MCP tool / new REST endpoint** → `packages/daemon/src/`
- **New AI-client adapter** → `packages/daemon/src/cli/adapters/`
- **Skill content / hook prompts** → `packages/skill/`

## Coding conventions

- **TypeScript strict.** `noUnusedLocals`, `noImplicitReturns`, etc. — see
  `packages/daemon/tsconfig.json`.
- **ESM imports need `.js` extensions** (NodeNext module resolution):
  ```ts
  import { foo } from "./helpers.js"; // ✓
  import { foo } from "./helpers";    // ✗ — won't run
  ```
- **Small files.** Soft ceiling ~800 lines of code per file (comments and
  blank lines don't count). If a file grows past that, propose a split (or
  implement one in your PR).
- **Formatting and linting are enforced.** CI runs `npm run format:check`
  (Prettier) and `npm run lint` (ESLint). Run `npm run format` before you
  commit; don't reformat files your change doesn't touch.
- **Structure limits:** `npm run lint` checks classic cyclomatic complexity ≤15
  and nesting depth ≤4, including `webui/app`. Functions above 100 code lines
  (comments and blank lines excluded) produce a warning only. Import cycles
  are forbidden everywhere; type-only and dynamic imports are excluded.
  Existing violations are frozen by stable function identity and individual metric
  value, or by exact cycle edge. Existing over-limit functions may change without
  increasing either metric; lower values require a baseline reduction. New
  functions and functions already within the limits must stay within 15/4.
  Refactor legacy functions through their dedicated refactoring issue; a small
  bug fix does not require a simultaneous complete rewrite. Split responsibilities using
  existing modules and useful interfaces; do not chop code into tiny helpers
  merely to satisfy a number or add suppression comments.
- **One root lint configuration:** all `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`,
  `.mts`, `.cts`, and `.tsx` files are checked throughout the repository,
  including new directories outside `packages`, `scripts`, and `tools`.
  Hidden directories directly under the repository root contain session or
  hosting metadata and are excluded. Root files and hidden subdirectories below
  visible product directories remain covered. The structure runner pins
  `eslint.config.mjs` and rejects additional `eslint.config.*` files outside the
  excluded root directories. Directly supplied unconfigured source files fail.
  Shared exclusions in `scripts/lint-scope.mjs` name actual generated, vendor,
  and frozen-data paths; a directory named `build`, `vendor`, `coverage`, or
  `goldset` is not automatically exempt. Other languages keep their existing
  checks; this does not introduce a blanket ban on CSS, HTML, or Python files.
- **Copies:** the same lint command runs jscpd (`npm run lint:clones`): production
  clones need at least 20 lines and 150 tokens; test-inclusive clones need 40
  lines and 300 tokens. Import blocks, generated/vendor code and frozen fixtures
  are excluded. Inspect a finding for a suitable existing helper; do not merge
  code automatically. A domain-correct copy requires a documented, reviewed
  exception. Never manually expand a baseline to get a new violation through.
- **Copy-detector limit and counter-review:** the current jscpd configuration
  uses `mode: weak` without identifier normalization. Renaming variables,
  functions or types can therefore hide a copy; passing lint does not establish
  that two implementations are independent. In counter-review, compare their
  control flow, data transformations and error paths even when the names differ,
  and check for a suitable existing implementation before accepting a new one.
  Keep the current mode for this change: jscpd's optional
  [`ignoreIdentifiers`](https://jscpd.dev/reference/config-file) changes matching
  semantics and clone fingerprints. Its additional findings and runtime cost
  have not been compared for this repository, so enabling it needs that
  comparison first. Switching among `weak`, `mild` and `strict` alone does not
  enable identifier normalization. This limitation stays on the counter-review
  checklist until a measured replacement is adopted.
- **Lower the baseline after cleanup:** run `npm run lint:prune` and commit the
  smaller baseline files with the cleanup. This command refuses new violations.
  Normal lint fails on obsolete entries; CI also compares all baselines against
  the PR merge base or the last successful ancestor CI run on `main`, and
  rejects additions/increased counts. A cancelled or failed push cannot become
  that trusted anchor. A justified new copy needs a separate explicit owner
  policy decision, as described below.
  Area/public-interface boundaries will be added with the folder changes in #1519.
- **No new dependencies without an issue first.** Every dependency is a
  long-term cost.

### A justified lint exception

Record the affected finding, its exact scope and the reason it is appropriate
for the domain. The owner's instruction in chat is the authorization: record
the session or message reference and the instruction with that reason in the
issue and in a separate exception commit. Keep this policy change separate
from the code change; do not infer permission from a failing lint run.

The automatic guards still reject baseline growth and weaker configuration;
they do not read chat. If the decision requires a guard or policy change,
include that precise change in the reviewed exception commit rather than
adding a general bypass or silently editing a baseline. This documentation
grants no exception and adds no approval step beyond the owner's instruction.

## Commit messages

Format: `<scope>: <imperative summary>`. Scopes match what's changing:

- `cli:` — `bastra` CLI / adapters
- `daemon:` — MCP server / HTTP / hooks
- `core:` — vault, schema, search
- `skill:` — `SKILL.md`, hook prompts
- `docs:` — README, PLAN, SUPPORTERS
- `chore:` — tooling, deps, repo plumbing
- `fix:` — bug fix
- `feat:` — user-facing capability

Body explains **why**, not what — the diff already shows what.

## Pull requests

- **From a fork:** fork the repo, branch from `dev` in your fork, then
  open the PR against `n0mad-ai/bastra-recall:dev`. `main` carries releases. (You don't need
  write access — the standard GitHub fork-PR flow works.)
- Reference the issue: `Fixes #N` or `Refs #N` in the PR body.
- Include a short **test plan** — what you ran, what you saw. A
  paste of CLI output or a screenshot is enough for most changes.
- Run `npm run check:types` and `npm run build` before opening.
- Smaller PRs land faster — split if you can.
- WIP / draft PRs are welcome; open them as **Draft** PRs (the GitHub
  button) rather than `[WIP]` in the title.

## License

Bastra Recall is MIT-licensed. By contributing, you agree that your
contribution is released under the same MIT license. No CLA, no extra
forms — we trust the standard inbound = outbound model.

## Recognition

- Every contributor appears in the [GitHub Contributors graph](https://github.com/n0mad-ai/bastra-recall/graphs/contributors).
- [Sponsors are listed in SUPPORTERS.md](./SUPPORTERS.md) by tier.
- Significant feature contributors get a `## Contributors` mention in the
  matching release notes.

## Code of Conduct

Be excellent to each other. Disagreements over technical decisions are
welcome; disrespect for people is not. The maintainer reserves the right
to moderate comments and close discussions that don't follow this rule.
