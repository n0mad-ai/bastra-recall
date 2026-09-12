# bastra-recall v1.0 release gate — Codex review

Date: 2026-09-12  
Reviewed revision: `a4c0896f463edd8fb6560263be3432c6e37ceb53` (`main`, identical to `origin/main` at review start)  
Verdict: **NO-GO** until every P0 and P1 item below is closed and independently re-verified.

This is the handoff for Claude Code Max and the checklist for the final Codex counter-review. It records the release decision, not a request to repeat the discovery phase.

## Review-continuity incident — what actually interrupted the review

The user-visible interruptions were ChatGPT platform verification warnings triggered while raw defensive test payloads were being replayed in the review context. Automatic continuation then reintroduced the same payload vocabulary and made the interruption recur. Once verification completed and further security probing stopped, the non-security review continued normally.

A separate stale Codex goal flag also existed (`status: usageLimited` while account limits showed available capacity), but that was not the warning the user was seeing. The paused heartbeat must therefore not be described as having solved the platform warning.

Claude cannot change ChatGPT's platform verifier from this repository and must not attempt to evade it. The recall-side task is narrower: measure whether hooks, injected session blocks, pending suggestions, oversized recall payloads or retry wording unnecessarily duplicate raw fixture text and inflate the chance that the same review payload is replayed. Use context-tax telemetry and issues #354, #457, #462, #479, #484, #487 and #510 as evidence. Keep generated handoffs and fixtures neutral by using issue ids and semantic placeholders instead of copying raw payload strings. If recall materially amplified the replay, file/fix a measured issue; otherwise record the evidence-backed negative result in Claude's handoff.

## Executive release decision

The repository is in unusually good mechanical condition: type checks, all runnable tests, smoke tests, package validation, dependency audit, current CI, CodeQL and secret scanning are green. The package can be packed, installed from its tarballs, started with an isolated vault, and used for an immediate save/recall round trip.

It is nevertheless not ready for v1.0. Three P0 trust-boundary defects contradict the product's privacy/security promise, and 24 additional P1 release-contract, data-integrity or user-path failures remain open. These are not speculative backlog items; each is tied to an observed code path, a dynamic reproduction, an upstream status check, or a contradiction in the binding v1 contract.

The user stopped further security variant hunting on 2026-09-12. The three already-proven security findings remain release blockers. This report does not claim that every possible security variant beyond those findings was exhausted.

## What passed

- `npm run check:types`
- `npm test`: 2,488 tests; 2,486 passed, 0 failed, 1 skipped, 1 todo
- `npm run pack:check`
- `npm audit --audit-level=low`: 0 vulnerabilities across 268 dependencies
- `npm run smoke`: 7/7
- `npm run smoke:telemetry`
- `npm run test:update`: 11/11
- GitHub CI and CodeQL on the reviewed revision
- GitHub security inventory: 0 open CodeQL, Dependabot or secret-scanning alerts
- Coverage: 87.54% lines, 84.60% branches, 82.01% functions; the main core paths are predominantly 95–100%
- All five workspace tarballs packed and installed together in an empty temporary prefix
- Packaged CLI returned version `0.9.2` and complete help
- Packaged daemon contained its 50 skill/web assets; the wrapper remained executable
- Packaged `bastra install all --dry-run --vault <temp>` enumerated Claude Code, Codex/ChatGPT, Cursor and Claude Desktop with the expected hooks/skills
- Packaged daemon started against an isolated BM25 vault; REST save followed by immediate recall succeeded
- Release 0.9.2 carries all four native stub archives/checksums, the MCP bundle and installer scripts
- GitHub Actions use commit-SHA-pinned actions
- Packed tarballs showed no obvious secrets, personal files or temporary build debris
- A real isolated-home install registered Claude Desktop, Claude Code, Codex/ChatGPT and Cursor; `doctor all` validated every written adapter artifact; `uninstall all --yes` removed the registrations and shared skills while preserving user data. The requested Node-hook opt-out did not take effect and is tracked in #537
- Repeating the same real four-client install left all active config/skill hashes unchanged, created no additional backup and reported every surface already installed
- The packaged Map served its HTML and JavaScript, UI import staged candidates, the import hook returned the same count, UI onboarding saved profile memories and language settings, and `/vault/count` reconciled the result
- All 199 repository Markdown files were checked for local-link targets; after excluding intentional GitHub Wiki links and archived worktrees, the only broken local link is the one tracked in #523
- 195 installed dependency packages had declared permissive licenses; `npm outdated` found only routine patch/minor updates and no release-blocking dependency migration

## P0 — fix before any v1.0 release candidate

### #464 — private access is self-granted and hidden records are writable

Issue: <https://github.com/n0mad-ai/bastra-recall/issues/464>

Confirmed on the reviewed revision:

- A private memory returns `memory not found` through ordinary `load_memory`.
- The same external dispatch can pass `allow_private: true` and receive the full private body. `dispatchApi()` does not attach or verify a trusted Mac-app capability; the request body grants the privilege itself.
- Without reading the record, the same caller can use `save_memory(overwrite: true)` to replace its complete body. The `private` label survives, making the destructive change invisible afterward.
- `save_document(overwrite)`, `recategorize_document` and `move_document` have the same missing authorization boundary. Existing identity-safety tests currently prove that private sidecars can be changed by these handlers while checking only that their label survives.
- The earlier archive-only fix remains valid but did not complete the write-path audit required by the original issue.

Required design: establish a transport-bound trusted capability for the Mac app. No public MCP/REST argument may manufacture it. Apply the same decision to read, archive, overwrite, recategorize and move. Negative tests must prove that refused calls leave the original bytes and paths unchanged.

### #520 — a generic OpenAI key silently turns on cloud embeddings

Issue: <https://github.com/n0mad-ai/bastra-recall/issues/520>

`resolveEmbeddingChoice()` currently gives a generic `OPENAI_API_KEY` precedence as an implicit provider choice. A user who never opted recall into a cloud provider can therefore send recall queries, saved memories and the embedding backfill corpus to OpenAI, contradicting the local-only promise.

Required design: provider consent must be explicit. A generic key alone must remain BM25/local-only. Add a diagnostic/migration path for existing installations and negative egress tests. Rewrite the absolute privacy wording so it distinguishes vault-content egress from optional metadata/network features such as weather/geocoding, update checks and Commons sync.

### #526 — tokenless loopback exemption trusts the socket instead of the request

Issue: <https://github.com/n0mad-ai/bastra-recall/issues/526>

Packaged-daemon reproduction:

- `/health` with a foreign Host returned 403.
- `/api/v1/recall` with a foreign Origin returned 403.
- `/api/v1/recall` with a foreign Host and no Origin returned 200 without a token.
- `/api/v1/graph/node?id=...` under the same conditions returned 200 with the complete non-private body.

The API routes are excluded from the Host gate, then the token check is skipped solely because `remoteAddress` is loopback. DNS rebinding and local tunnels/reverse proxies inherit that exemption.

Required design: tokenless access requires both a loopback peer and a loopback Host. A foreign/public Host requires the correct token even when the proxy socket is loopback. Add same-origin/no-Origin DNS-rebinding and tunnel integration tests.

## P1 — required for the v1.0 release contract

### Reliability and user paths

- **#305 — current automatic-hook delivery misses the release bar**  
  <https://github.com/n0mad-ai/bastra-recall/issues/305>  
  Fresh seven-day telemetry has 1,083 hook calls, 110 timeouts and 19 unreachable/error results (12% combined). The assertion lane is n=274, median 420 ms, p90 685 ms, max 1,017 ms and 37 timeouts against a 600 ms budget. Separate deliberate restart periods, classify the current failure bands and meet an explicit packaged-client release threshold; do not defer the live absence rate under the old V2 router decision.

- **#62 — Claude Code long-body save loss**  
  <https://github.com/n0mad-ai/bastra-recall/issues/62>  
  The linked upstream Claude Code issue was closed stale/not-planned, not fixed. Prove the current Claude Code transport under repeated long multiline saves or add a safe idempotent mitigation. A single happy-path save is insufficient.

- **#308 — session onboarding is delivered but not performed**  
  <https://github.com/n0mad-ai/bastra-recall/issues/308>  
  Map and CLI onboarding work, but the known real-session path ignores the injected block while README/USAGE promise that an AI session offers the interview. Make the behavior deterministic and prove it on every advertised client, or narrow the public promise to Map and CLI.

- **#506 — promised todo/plan hook is wired to a retired event**  
  <https://github.com/n0mad-ai/bastra-recall/issues/506>  
  The lane produced no real event in seven days. Current Claude Code documentation says `TodoWrite` was replaced by `TaskCreate`, `TaskUpdate`, `TaskGet` and `TaskList`; this Codex desktop surface exposes no `update_plan` tool either. Bind each supported client to a real event and prove automatic emission, or narrow the promise and remove the dead lane.

- **#519 — partial memory edits bypass the safe save path**  
  <https://github.com/n0mad-ai/bastra-recall/issues/519>  
  Deliver the promised partial-edit primitive (replace/append/frontmatter patch) through the same locking, audit, index and sensitivity rules as full saves. Agents must not need direct filesystem edits for ordinary updates.

- **#521 — bash tripwire blocks harmless heredoc prose**  
  <https://github.com/n0mad-ai/bastra-recall/issues/521>  
  A heredoc written to a data sink still fires when its prose merely mentions a destructive-command phrase. Preserve real command detection without blocking documentation or memory bodies.

- **#529 — concurrent imports report success while losing almost all input**  
  <https://github.com/n0mad-ai/bastra-recall/issues/529>  
  Dynamic results: 80 concurrent `stageImport()` calls reported 80 staged candidates but persisted 1; 80 concurrent `buildQueue()` calls reported 80 queued conversations but persisted 1. Serialize and crash-harden both import stores, with durable result counts.

- **#531 — diagnostics mix different daemon endpoints**  
  <https://github.com/n0mad-ai/bastra-recall/issues/531>  
  With an empty vault on configured port 26723 and the real vault on default port 6723, `status --json` reported the default vault's size (`1193`) while claiming the custom-port Map was reachable. The installer also fails to persist the endpoint into client registrations, and managed autostart drops the chosen port. Use and preserve one endpoint contract across registration, status, doctor, autostart, embeddings and update hints.

- **#532 — concurrent pending suggestions silently collapse**  
  <https://github.com/n0mad-ai/bastra-recall/issues/532>  
  Forty overlapping unique writes produced one durable pending suggestion although the documented cap is five. Coordinate writers and consumption; keep hooks non-blocking without making lost state invisible.

- **#533 — concurrent skill declarations silently collapse**  
  <https://github.com/n0mad-ai/bastra-recall/issues/533>  
  Forty successful unique `addSkill()` calls left one registry entry. Apply the transaction serialization already used by the floor registry and enforce the cap against durable state.

- **#534 — concurrent settings changes discard unrelated fields**  
  <https://github.com/n0mad-ai/bastra-recall/issues/534>  
  `Promise.all(setUpdateMode("off"), setDocsMode("auto"))` resolved successfully but persisted only one field. Atomic rename is not transaction serialization; all settings setters need one same-process and cross-process contract.

- **#536 — unknown flags warn and then perform the mutation**  
  <https://github.com/n0mad-ai/bastra-recall/issues/536>  
  In an isolated profile, `uninstall cursor --dryrun` warned that the misspelled flag was ignored, then removed the real registration and exited 0. Reject unknown and command-inapplicable options before dispatch; a typo in `--dry-run` must leave every target byte-identical.

- **#537 — `--no-stub` cannot opt back into Node hooks**  
  <https://github.com/n0mad-ai/bastra-recall/issues/537>  
  With a compiled hook present, explicit `install all --no-stub` reported the binary present and registered every Claude/Codex hook to it. Explicit mode must beat artifact presence and remembered choice, while `--stub` must remain able to reverse the selection.

### Measurement truth and the binding architecture contract

- **#425 — persisted experiment settings are discarded**  
  <https://github.com/n0mad-ai/bastra-recall/issues/425>  
  Reproduced with a valid settings file: `readSettings()` drops `experiment`, so `getExperimentConfig()` returns null. Persist and round-trip the complete supported experiment/evidence configuration.

- **#437 — arm statistics publish rates below minimum N**  
  <https://github.com/n0mad-ai/bastra-recall/issues/437>  
  The reporter needs the contract's minimum-sample enforcement and an explicit `not_evaluable`/underpowered result rather than authoritative-looking rates.

- **#439 — experiment telemetry loses registration identity**  
  <https://github.com/n0mad-ai/bastra-recall/issues/439>  
  Store enough experiment, registration and version identity on emitted rows to reproduce historical results after configuration changes.

- **#447 — merged gold and labels can drift without failing `--check`**  
  <https://github.com/n0mad-ai/bastra-recall/issues/447>  
  A binding reproducible-measurement artifact must revalidate the merged gold against its labels. Current checking can bless a stale pairing and thereby invalidate release evidence without a failing command.

- **#522 — live global budget was deferred while governing docs still require it**  
  <https://github.com/n0mad-ai/bastra-recall/issues/522>  
  Choose one honest contract before release: ship the live cumulative cross-lane budget from #458, or amend the governing German architecture document first and then synchronize the English architecture, README, PLAN and milestone description to promise only the shadow ledger. The milestone description also incorrectly says #270 belongs to v1 while the issue is assigned to V2.

### Release mechanics

- **#435 — Homebrew update can repoint autostart to the old keg**  
  <https://github.com/n0mad-ai/bastra-recall/issues/435>  
  The public current update path can leave launchd targeting the old Homebrew keg. Re-register against the installed keg and prove the active service path/version after update.

- **#441 — staged update leaves the managed LaunchAgent on the old keg**  
  <https://github.com/n0mad-ai/bastra-recall/issues/441>  
  Staged updates must refresh managed service ownership/path before reporting completion; a restart alone is not enough when the plist still names the old runtime.

- **#524 — the stable release recipe creates a prerelease and publishing is not resumable**  
  <https://github.com/n0mad-ai/bastra-recall/issues/524>  
  Stable bump output always recommends `gh release create ... --prerelease`; the workflow still publishes npm `latest`, while Homebrew consumes GitHub `/releases/latest`, which excludes prereleases. The workflow also exposes an already-published release while npm and independent asset jobs are still incomplete; the Finder installer can therefore install the old npm `latest` from a new 1.0 page. Stage, verify and promote one coherent release set, and make partial npm publication resumable.

- **#527 — Finder uninstaller stops an unrelated service**  
  <https://github.com/n0mad-ai/bastra-recall/issues/527>  
  The script terminates every listener on hard-coded port 6723 without establishing Bastra process identity. It also says Bastra was removed while leaving the package installed. Stop only a positively identified configured daemon and make unregister/package/data wording precise.

- **#528 — source update dry-run promises a build the real command never runs**  
  <https://github.com/n0mad-ai/bastra-recall/issues/528>  
  Dry-run prints `git pull && npm ci && npm run build`; real source mode executes none of those and can re-register/restart old `dist`. Make the source-checkout action match its plan and verify the built revision before success.

- **#535 — one-click installer reports success after a failed upgrade**  
  <https://github.com/n0mad-ai/bastra-recall/issues/535>  
  Both public scripts continue on an old Homebrew install after `brew upgrade` fails, then print the normal `Done` banner if old-version setup/doctor pass. Preserve the working installation, but return a distinct incomplete result and verify the requested version before re-registration.

## P2 — should follow immediately, but does not by itself block a corrected v1 binary

- **#523 — architecture documentation contradicts implementation**  
  <https://github.com/n0mad-ai/bastra-recall/issues/523>  
  Correct the claim that locks are merely per-path and allow duplicate ids in separate folders; the implementation uses a vault-wide ID claim. Correct the claim that every daemon write is audited because document writes currently are not. Fix the broken `./docs/survival.md` link to `./survival.md`; add local-link CI.

- **#525 — distribution support matrix and Homebrew caveat drift**  
  <https://github.com/n0mad-ai/bastra-recall/issues/525>  
  The live formula caveat omits Codex/ChatGPT although the repository formula source includes it, and there is no drift check. npm README/platform metadata, daemon README reachability, uninstall vocabulary and package descriptions contradict shipped clients/platforms. Publish one explicit support matrix and automate formula/caveat/metadata drift detection.

- **#530 — identical vault re-imports rewrite unchanged files and grow audit state**  
  <https://github.com/n0mad-ai/bastra-recall/issues/530>  
  Re-import preserves Markdown bytes and avoids duplicate files, but rewrites all mtimes, adds no-op audit events with identical before/after state, rewrites the marker and again reports every file as imported. Make identical re-import a true no-op and report created/updated/unchanged separately.

- **#13 — OpenAPI remains a deliberately incomplete starter**  
  <https://github.com/n0mad-ai/bastra-recall/issues/13>  
  `docs/openapi.yaml` still reports version 0.8.6 and does not describe the complete API. The README labels it planned, so this is not a hidden v1 implementation promise; update it when the issue is scheduled rather than presenting it as authoritative now.

## Later / V2 — reviewed and deliberately not pulled into v1

The following open or residual areas were reviewed and remain deferred unless their assumptions change:

- #442: whitespace/empty reporting edge for registration artifacts
- #507: missing client/hook-source dimensions on some context-tax emission rows; accepted as nonblocking in the current single-client dogfood, while core hook-recall rows carry dimensions
- #436: raw external session identifiers stay local because no telemetry export exists yet
- #440: substring matching edge in `recall_when`
- #443: invalid evidence environment values are truthy
- #452: optional Pro document writes do not yet enter the mutation audit trail
- #458: live cumulative budget implementation, subject to the contract decision in #522
- #492: learned dense deadlines remain behind their time gate; fixed deadlines are acceptable meanwhile
- #368: unreleased Mac bridge reconciliation path
- #341: sync caveat is documented
- #431: recovery-journal cleanup/read errors in an exceptional optional-document path
- #382: accepted rare stale-index/area-lock residual with no deterministic reproduction
- #509: session-start redundancy/cadence was explicitly moved out of v1 as efficiency work
- #270: provenance inventory belongs to V2 despite stale milestone prose
- #512: CLI `logs --stats` lacks the per-session section available in the web/dev telemetry views; useful follow-up, not a false product result
- #446: the full test suite can leave eval-run fixtures in the user's default state directory; fix test hermeticity, but it does not alter packaged runtime behavior

## GitHub issue audit

The review fetched and triaged the repository's 412-issue / 638-comment baseline, including closed history and the current milestone, then re-queried the live milestone after filing and moving findings. Old accepted residuals were not reopened without new evidence. At the time of this handoff, the v1 milestone has these 27 open issues:

`#62, #305, #308, #425, #435, #437, #439, #441, #447, #464, #506, #519, #520, #521, #522, #524, #526, #527, #528, #529, #531, #532, #533, #534, #535, #536, #537`. The command below is authoritative; do not rely on this prose count if issues move while Claude works:

```bash
gh issue list \
  --milestone "v1.0 — Measurable, selective, controllable recall" \
  --state open --limit 200
```

Review actions already taken:

- Created #520 and #522–#537.
- Reopened and broadened #464 after dynamically reproducing the unfinished private-write audit.
- Returned #62, #305, #308, #425, #435, #437, #439, #441, #447 and #506 to the v1 milestone with release evidence.
- Added `priority/high` to #521.

## Claude Code Max execution order

Keep workstreams independent and land each with its issue number in tests and commit history:

1. **Private trust boundary:** #464
2. **Network/API boundary:** #526
3. **Explicit cloud consent:** #520
4. **Shared-state durability:** #529, #532, #533, #534
5. **Release and install machinery:** #524, #527, #528, #535, then #435 and #441
6. **Settings and experiment truth:** #425, #439, #437, #447
7. **Real client behavior and transport reliability:** #305, #506, #308, #62
8. **Endpoint consistency:** #531
9. **CLI and mutation safety:** #536, #537, #519, #521
10. **Resolve the v1 contract:** #522
11. **Documentation cleanup:** #523, #525, #530 and any text changed by the P0/P1 fixes

Do not combine the three P0s into a broad refactor. Each needs a minimal threat model, an integration-level negative test and a separately reviewable diff.

## Final Codex counter-review gate

After Claude lands the fixes, Codex must independently run:

```bash
npm ci
npm run check:types
npm test
npm run pack:check
npm audit --audit-level=low
npm run smoke
npm run smoke:telemetry
npm run test:update
```

Then repeat these independent checks, not only the new unit tests:

1. External REST and stdio MCP callers cannot self-grant private access; the Mac app still can through a non-forgeable boundary.
2. Every refused private mutation leaves original bytes, locations and index entries unchanged.
3. Foreign Host/no-Origin API requests require the token even through a loopback proxy; legitimate direct loopback still works.
4. A generic `OPENAI_API_KEY` with no explicit recall-provider selection produces no embedding-network request and remains BM25/local.
5. A stable `1.0.0` dry run creates a non-prerelease GitHub release plan and a Homebrew-visible Latest release; a simulated partial npm publish resumes safely.
6. Persisted experiment settings survive restart and telemetry rows retain immutable run/registration identity.
7. Underpowered experiment arms render `not_evaluable`, never a decision-looking rate.
8. Each documented supported client produces a real plan/task hook event automatically.
9. Repeated long multiline saves through the current Claude Code transport preserve exact content or fail explicitly without duplicate writes.
10. Harmless heredoc prose containing destructive-command words passes; an actual destructive command is still caught.
11. Partial edits use the safe mutation path and preserve identity, metadata, sensitivity, audit and concurrent-write semantics.
12. README, both architecture documents, PLAN, milestone prose, package docs and live Homebrew caveat tell one support/privacy/v1-contract story.
13. Concurrent import staging, conversation queueing, pending suggestions, skill declarations and distinct settings mutations retain the durable union and return truthful counts.
14. A configured non-default daemon endpoint is used consistently by status, doctor, autostart, embeddings, update hints and Map URLs even when another daemon is live on 6723.
15. Source-checkout and Homebrew updates prove the new built/runtime revision, managed service path and active daemon version before success.
16. The public release is invisible/incomplete until every npm package, native binary, checksum, attestation, extension and installer belongs to the same stable version.
17. Fresh-session onboarding is actually performed on every advertised client, or the launch copy no longer promises that surface.
18. Unknown or command-inapplicable CLI flags fail before dispatch; typoed rehearsal flags cannot perform real writes.
19. Seven-day packaged-client hook telemetry meets an explicit timeout/error threshold for every advertised automatic lane, with restarts separated from steady-state operation.
20. `--no-stub` and `--stub` deterministically select the registered hook client on every supported adapter, regardless of an already-downloaded binary or remembered choice.

Release is **GO** only when every P0/P1 issue is closed with evidence, the full suite above is green on the final revision, the independent checks pass from packaged artifacts, and the current GitHub v1 milestone contains no unexplained open item.

## Independent Codex counter-review — pass 1

Counter-reviewed revision: `ac0190dfafa3ced0b24a2522e3f747eb81be30de` (22 local commits after the discovery baseline; not yet on `origin/main` at the time of this pass).
Counter-review verdict: **NO-GO remains**. The mechanical suite is green, but seven independently verified fixes are incomplete and nine original P1 gates have no corresponding fix commit yet.

### Mechanical suite on `ac0190d`

- `npm ci`: clean install, 0 vulnerabilities
- `npm run check:types`: pass
- `npm test`: 2,611 tests; 2,609 passed, 0 failed, 1 skipped, 1 todo
- `npm run pack:check`: pass for all four published packages
- `npm audit --audit-level=low`: 0 vulnerabilities
- `npm run smoke`: 7/7
- `npm run smoke:telemetry`: pass, 3 correlated events
- `npm run test:update`: 15/15

### New counter-review findings

#### #529 remains open — the import lock is process-local

Both import stores use `withPathLock(...)` without `{ crossProcess: true }`. That protects overlapping calls inside one daemon or CLI process, but not the real CLI-versus-daemon/UI boundary and not two CLI invocations.

Fresh isolated multi-process reproductions on `ac0190d`:

- 20 concurrent `stageImport()` processes all exited 0; only 6 unique candidates survived in `import-review.md`.
- 20 concurrent `buildQueue()` processes all exited 0; only 1 conversation survived in `import-queue.jsonl`.

The same-process tests are green but do not exercise this boundary. Evidence was added to GitHub issue #529.

#### #524 remains open — staging is still public and resumable identity is too weak

The new stable bump creates a published GitHub release with `--latest=false`. That prevents `/releases/latest` and Homebrew from moving early, but the release page and tag are already public while release-triggered jobs attach assets and npm publication can still fail. This does not meet the gate that the public release remain invisible/incomplete until the coherent set is verified; the staging object must remain a draft or otherwise private until final promotion.

The resumable npm script also treats an existing package as “this release” after comparing only name, version and internal dependency pins. Different package bytes from another commit with identical metadata would be skipped as verified. Candidate-versus-registry artifact identity still needs a digest/integrity check. Evidence was added to GitHub issue #524.

#### #528 remains open — mtime does not prove a source build belongs to HEAD

Dry-run now accurately says that source mode will not pull/install/build, and stale/unbuilt fixtures are refused. However, `inspectSourceBuild()` accepts any `dist/*.js` newer than `src/*.ts` and then reports the current Git revision as live. Output copied from another revision, a checkout to older sources, or merely touched build files passes without proving a source/HEAD match. In the no-LaunchAgent branch the command also says a running daemon still holds old code and then prints that the verified HEAD is live. The acceptance requirement to prove the active CLI/daemon revision therefore remains unmet. Evidence was added to GitHub issue #528.

#### #519 remains open — `expected_updated` cannot detect same-day stale edits

`edit_memory` advertises `expected_updated` as an optimistic-concurrency precondition, but the compared `updated` field has day precision. An isolated sequential reproduction loaded `updated: 2026-09-12`, applied one tags patch with that value, then applied a second stale tags patch with the same observed value. Both calls succeeded and the second silently replaced the first (`["first"]` became `["second"]`). The parallel append test does not cover this lost-update shape. Use an exact revision/content precondition or another monotonic per-write token. Evidence was added to GitHub issue #519.

#### #535 remains open — an empty Homebrew expectation still permits a false success

The installers compare the post-upgrade CLI version only when `brew outdated --verbose` produced an expected version. A stale tap or a no-output/no-op upgrade leaves that expectation empty; `brew upgrade` may exit 0 while `bastra --version` remains 0.9.2, after which setup runs and the normal success banner is printed. The new “successful upgrade” test stubs exactly that shape (empty `outdated`, successful `upgrade`, CLI permanently at 0.9.2) and expects success, so it cements rather than catches this case. The release-page installer needs an authoritative requested version and must verify it after both install and upgrade. Evidence was added to GitHub issue #535.

#### #527 remains open — an argv substring is not positive daemon identity

The Finder uninstaller now treats any listener whose full `ps` command line contains `daemon/dist/index.js` as Bastra. An isolated end-to-end reproduction started an unrelated Node TCP listener with the inert argument `note:/some/daemon/dist/index.js`, pointed the uninstaller at its ephemeral port and stubbed every other external action. The real script exited 0, printed that it was stopping the Bastra daemon and terminated the unrelated process. Identity must be bound structurally to the configured Bastra executable/runtime rather than to a substring anywhere in argv. Evidence was added to GitHub issue #527.

#### #536 remains open — equals syntax bypasses boolean-option validation

The validator normalizes `--dry-run=false` to the known option name `--dry-run`, but the parser recognizes only the exact valueless token and silently ignores the equals form. In an isolated real-CLI reproduction, `uninstall cursor --dry-run=false` exited 0, changed `.cursor/mcp.json` and created a backup without reporting an error. Valueless options must reject attached values (or implement explicitly documented semantics) before dispatch. Evidence was added to GitHub issue #536.

### Fixes present but still awaiting the remaining artifact-level checks

Commits and green targeted tests are present for #425, #435, #441, #464, #519, #520, #521, #524, #526, #527, #528, #529, #532, #533, #534, #535, #536 and #537. #519, #524, #527, #528, #529, #535 and #536 have the counter-findings above and remain open. The others are not marked closed by this pass merely because their unit tests pass; packaged-install, transport and cross-surface acceptance checks from the 20-point gate still apply.

### Original v1 gates with no fix commit in this revision

`#62, #305, #308, #437, #439, #447, #506, #522, #531`.

The live GitHub milestone still contained all 27 original open issues during this pass. Local commits had not yet been pushed to `origin/main`, so issue state alone is not used to reject an otherwise verified fix; it does mean the final zero-open-item release condition is not yet met.

## Independent Codex counter-review — pass 2

Counter-reviewed revision: `76798d50523171a063139e8829ed745b04a1e0ea` (18 commits after pass 1; `origin/main` was `82451a75a9c502fbfc2627820ae509dd23a0a684` during this pass).
Counter-review verdict: **NO-GO remains**. Seven pass-1 counter-findings are now corrected, but #62, #305, #308 and #506 still fail their original acceptance boundary, while #522 and #531 have no implementation commit.

### Mechanical suite on `76798d5`

- `npm ci`: clean install, 0 vulnerabilities
- `npm run check:types`: pass
- `npm test`: 2,727 tests; 2,725 passed, 0 failed, 1 skipped, 1 todo
- `npm run pack:check`: pass for all four published packages
- `npm audit --audit-level=low`: 0 vulnerabilities
- `npm run smoke`: 7/7
- `npm run smoke:telemetry`: pass, 3 correlated events
- `npm run test:update`: 15/15

### Pass-1 counter-findings now independently cleared

- **#529:** a fresh 20-process reproduction retained 20/20 staged import candidates and 20/20 queued conversations. The import stores now take the cross-process lock across their complete read-modify-write transaction.
- **#536:** the real CLI now rejects `uninstall cursor --dry-run=false` before dispatch with exit 2. The exact formerly mutating attached-value shape no longer reaches uninstall.
- **#527:** the real Finder-uninstaller integration leaves an unrelated listener carrying the inert argument `note:/some/daemon/dist/index.js` alive and reports that it is not the Bastra daemon.
- **#519:** a second same-day edit using the first caller's stale `expected_revision` is refused, the first tags change remains present, and a retry with the returned new revision succeeds. `load_memory` and `edit_memory` now expose the same byte-revision contract.
- **#528:** builds copied from another revision and touched stale builds are refused as mismatches; a daemon reporting a different build is reported as not live. Build and daemon revision claims no longer derive from mtimes.
- **#535:** both installers fail closed when a no-op upgrade or fresh install leaves the old CLI version, and also when the requested version cannot be established. Setup is not re-run against the version that failed to land.
- **#524:** the 1.0.0 dry run now stages a draft stable release, explicitly dispatches the publish workflow, verifies candidate-versus-registry tarball integrity before resuming, and promotes only after all npm packages and required assets pass. The targeted release-set suite passes 16/16.

### Additional fixes that pass their targeted counter-checks

- **#437:** every reporting path tested emits `NOT EVALUABLE` and no numeric arm rate below the registration's session-level minimum N.
- **#439:** dimensioned events carry experiment name, registration path and registration version, including the unassigned/no-session case under an active registration.
- **#447:** `--check` detects content, case-set, source-batch and recorded-label-hash drift between staged labels and merged gold.
- **#538:** concurrent background/manual curator passes on one vault are single-flight; one runs and the other returns `skipped: in-progress` without duplicating state/report work.
- **#539:** concurrent mutations from the five daemon hook lanes retain the durable session-state union through a per-session read-modify-write transaction.

Issues #538 and #539 were created during Claude's durability audit and fixed in this revision, but remained open and outside the v1 milestone during this pass. They must be triaged and closed with their landed commits before the final issue-state gate.

### Remaining release blockers after pass 2

#### #305 — measurement fold is still ambiguous, and the live rate still misses the gate

The corrected readout excludes restart windows and folds duplicate client/daemon observations, but `foldClientDuplicates()` matches only event kind and a ±500 ms timestamp window. Both rows already carry `session_id`; nevertheless, an independent two-row reproduction with `session-A` and `session-B`, 100 ms apart, returned `folded: 1` and changed session A's successful daemon row into session B's timeout. Simultaneous clients can therefore corrupt both denominator and verdict. Evidence was added to GitHub issue #305.

Even before that ambiguity is repaired, the corrected seven-day source readout still fails the product target: 1,412 steady-state calls, 69 timeouts (4.9%), assertion median 424 ms and p90 731 ms. The p90 exceeds the current 600 ms hook budget and is far above the issue's explicit 200 ms ceiling. The commit itself changes accounting, not lane cost.

#### #62 — the new stress test does not run through Claude Code

The 70-call harness passed: 70 accepted, 70 byte-identical on disk, 280 progress notifications, no duplicates and no truncated-frame write. However, it instantiates the generic MCP SDK `Client` and `StdioClientTransport`; it never launches Claude Code. The issue's prior evidence already established that this generic SDK/forwarder path succeeds and that the intermittent defect existed only in Claude Code's progress-notification handling. The HTTP oversize-response fix addresses a separate body-cap failure. The original supported-client boundary therefore remains unverified; evidence was added to #62.

#### #506 — Claude's new task event is wired, but Codex/ChatGPT remains an unsupported claim

The Claude Code adapter now registers `TaskCreate` and the lane correctly normalizes its one-task payload. The Codex adapter still relies exclusively on `PreToolUse: update_plan`, while this current Codex Desktop task exposes no `update_plan` tool/event. Synthetic payload tests prove normalization, not automatic client emission. The product docs still promise before-plan recall on Codex/ChatGPT Desktop. Evidence was added to #506; either a real automatic event per advertised client or narrower launch copy is still required.

#### #308 — stronger wording is still not end-to-end onboarding evidence

The injected block now commands the model to run onboarding immediately. Its own implementation notes correctly admit that acting on injected context remains nondeterministic and that hookless clients may never receive the block. Tests assert wording and token accounting only; they do not show a fresh advertised client actually starting the interview. `docs/USAGE.md` still promises that the AI session offers the adaptive third onboarding surface. The original defect was delivered-but-ignored context, so a wording-only change cannot close it without a real-session observation or narrowed copy. Evidence was added to #308.

#### #522 and #531 — still not implemented

- **#522:** README, PLAN and both governing architecture documents still say v1 introduces a global context budget. The milestone description has been corrected to a cumulative shadow ledger, but the four versioned sources still contradict that decision.
- **#531:** runtime code still contains independent fixed-default probes and labels (`cli/helpers.ts`, `cli/update-hint.ts`, adapter `daemon-on-6723` details, embeddings/update output), and install/autostart endpoint propagation remains absent. The fabricated cross-instance status boundary is unchanged.

### GitHub state at pass 2

All 27 original v1 milestone issues remained open. Most fix commits were now on `origin/main`, but the #62 and #308 commits were still local only. This does not invalidate a code fix, but it independently fails the final release condition: every P0/P1 must be closed with evidence and the current v1 milestone must contain no unexplained open item.
