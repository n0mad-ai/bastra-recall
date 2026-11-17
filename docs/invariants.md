# Invariants

Promises bastra-recall makes to its users that must hold after every change.
Breaking one harms a user: data is lost, a security boundary opens, an answer
is wrong, or an external contract breaks. Implementation details are not
listed here, and neither is everything the test suite checks.

Run them with one command. It builds core and daemon first, like `npm test`,
and then takes about ten seconds:

```bash
npm run test:invariants
```

They also run in the ordinary `npm test`.

## How the catalog and the tests are tied

- Every invariant has an ID (`INV-<AREA>-<NN>`). The test that holds it starts
  its title with that ID, for example `test("INV-VAULT-01: …")`. One invariant
  can be held by more than one test.
- The **Test** column names the file that holds those tests.
  `npm run test:invariants` runs exactly these files, and inside them only the
  tests whose title starts with `INV-`.
- `tools/__tests__/invariants-catalog.test.mjs` fails when an ID in this file
  has no test, when a test carries an ID this file does not list, or when a
  test in a `*.invariant.test.*` file has no ID.
- New tests written only for an invariant live in `*.invariant.test.ts` files
  in the package's `__tests__` folder. Existing tests that already hold a
  promise are referenced instead of duplicated.

An invariant test is never weakened, skipped or deleted on its own. Change or
remove the catalog entry first, on purpose and with a reason in the commit.
See [CONTRIBUTING.md](../CONTRIBUTING.md#invariants) for when to add one.

## Vault write path

| ID | Promise | Why it matters | Test |
| --- | --- | --- | --- |
| INV-VAULT-01 | A save without `overwrite` never replaces an existing memory; the stored bytes stay untouched. | A colliding title would otherwise erase a memory silently. | `packages/core/__tests__/vault.invariant.test.ts` |
| INV-VAULT-02 | A saved memory is found by its id afterwards, also by a freshly started vault, with its body intact. | The basic promise of a memory; third-party layers build on ids. | `packages/core/__tests__/vault.invariant.test.ts` |
| INV-VAULT-03 | `save_memory(overwrite)` is a patch: fields the caller does not send keep their stored values. | Otherwise every refresh resets `created`, `sensitivity` (widening who may read it) and other non-regenerable fields. | `packages/core/__tests__/save-overwrite-roundtrip.test.ts` |
| INV-VAULT-04 | `edit_memory` `str_replace` with a missing or ambiguous `old_str` writes nothing and says why. | Guessing the place would change the wrong text or drop content. | `packages/daemon/__tests__/edit-memory-partial-save.test.ts` |
| INV-VAULT-05 | An edit with a stale `expected_revision` writes nothing. | Two writers must not overwrite each other's change unseen. | `packages/daemon/__tests__/edit-memory-partial-save.test.ts` |
| INV-VAULT-06 | Concurrent partial edits of one memory lose nothing. | Agents edit in parallel; a lost update is silent data loss. | `packages/daemon/__tests__/edit-memory-partial-save.test.ts` |
| INV-VAULT-07 | Of two concurrent creates of the same id exactly one wins; the other gets a visible conflict. | Two files under one id make the index load only one of them. | `packages/core/__tests__/save-concurrency.test.ts` |
| INV-VAULT-08 | No write or restore leaves the vault root, also not through a symlink. | A path escape writes into the user's other files. | `packages/core/__tests__/file-identity-containment.test.ts`, `packages/core/__tests__/delete-restore-safety.test.ts` |
| INV-VAULT-09 | A deleted memory goes to the trash with an audit entry and can be restored under its id. | Deleting must never make a memory evaporate. | `packages/core/__tests__/survival-by-id.test.ts` |
| INV-VAULT-10 | `save_memory` with `dry_run: true` writes nothing (no file, no index entry, no audit entry) and is refused where the real save would be; its preview shows the same redaction. | A preview that writes, or that shows something other than what would be stored, makes the user approve the wrong thing. | `packages/daemon/__tests__/save-dry-run.invariant.test.ts` |

## Private memories

| ID | Promise | Why it matters | Test |
| --- | --- | --- | --- |
| INV-PRIV-01 | A REST or stdio MCP caller cannot grant itself access to private memories through the request. | Otherwise any agent could read what the user marked private. | `packages/daemon/__tests__/private-write-authorization.test.ts` |
| INV-PRIV-02 | Overwriting a private memory the caller may not see is refused and changes nothing. | A blind overwrite destroys private content. | `packages/daemon/__tests__/private-write-authorization.test.ts` |

## Injection protection and secret scrubbing

| ID | Promise | Why it matters | Test |
| --- | --- | --- | --- |
| INV-SCRUB-01 | Every block tag the daemon's hooks emit is in `INJECTED_BLOCK_TAGS`. | An unlisted block is re-captured as memory content and feeds back into recall. | `packages/daemon/__tests__/scrub-emitted-blocks.test.ts` |
| INV-SCRUB-02 | Scrubbing removes a complete block of every listed tag, while a bare mention of a tag survives. | Injected context must not be stored; memories about the hook format must stay writable. | `packages/core/__tests__/scrub.test.ts` |
| INV-SCRUB-03 | Free text in tasks and task reports is redacted for secrets and scrubbed of injected blocks before it is stored. | Tokens and passwords must not land in plain-text stores. | `packages/daemon/__tests__/task-store.test.ts`, `packages/daemon/__tests__/task-reports.test.ts` |
| INV-SCRUB-04 | Vault text embedded in a hook hint keeps no invisible format or control character (except a joiner inside a word or emoji) and no tag-shaped markup. | Hidden or reordered text and imitated host markup slip past the reference-only frame. | `packages/core/__tests__/scrub-markup.test.ts` |

## Rulebook

| ID | Promise | Why it matters | Test |
| --- | --- | --- | --- |
| INV-RULE-01 | Every `save_memory` answer says whether a rule now applies, is only proposed, or a note was saved; a user-directed declaration applies at once, an agent's is a proposal. | The owner's decision: "create a rule" yields a rule, and the agent cannot claim a rule that is not active. | `packages/daemon/__tests__/rulebook-write-status.test.ts` |
| INV-RULE-02 | `edit_memory` binds a declaration on a user-directed note at once and keeps it a proposal on an agent note, and says which. | Same decision on the edit path (#1385). | `packages/daemon/__tests__/rulebook-write-status.test.ts` |
| INV-RULE-03 | Unconfirmed candidates and proposals are never silently promoted to rules. | An agent must not make its own rules binding. | `packages/daemon/__tests__/rulebook-delivery.test.ts` |
| INV-RULE-04 | The rule catalog has no top-k cap; every rule is reachable with a proven end. | A rule that cannot be listed is a rule no agent follows. | `packages/daemon/__tests__/rulebook-delivery.test.ts` |
| INV-RULE-05 | The gate sends the short rule-kernel reminder instead of the full kernel only to an agent that already received the byte-identical kernel in the same context; a changed kernel, another agent, or a compact/clear gets the full text. | A reminder in place of rules the agent never saw, or lost with its context, is a rule no agent follows (#1461). | `packages/daemon/__tests__/rule-kernel.test.ts` |

## Session start context

| ID | Promise | Why it matters | Test |
| --- | --- | --- | --- |
| INV-SESSION-01 | Always-rules reach the session whole, or the overflow is named; never cut silently. | A half rule is misread; a dropped rule is not followed. | `packages/daemon/__tests__/rulebook-delivery.test.ts` |
| INV-SESSION-02 | When the session context is over budget, only whole sections are deferred and named; the rule kernel and the language section stay whole. | The agent must know what it did not get. | `packages/daemon/__tests__/session-context-cap.test.ts` |
| INV-SESSION-03 | The session start names reports with handed-over open notes and separates the owner's instructions from report text as reference. | Report text is agent-written; only the owner's notes are instructions. | `packages/daemon/__tests__/task-report-notes.test.ts` |

## Recall answers

| ID | Promise | Why it matters | Test |
| --- | --- | --- | --- |
| INV-RECALL-01 | A recall whose embedding provider fails mid-call says so in the answer (`score_kind`, `unfused`). | Raw BM25 scores read as fused scores make every hit look required. | `packages/daemon/__tests__/recall-degraded-during-call.test.ts` |
| INV-RECALL-02 | `k` is a hard upper bound; a larger `max_tokens` never returns more hits. | Callers size their context by `k`. | `packages/daemon/__tests__/recall-max-tokens.test.ts` |
| INV-RECALL-03 | With `max_tokens` the payload stays within the budget (one hit of slack) and says what it dropped. | The budget protects the caller's context window; a silent cut hides memories. | `packages/daemon/__tests__/recall-max-tokens.test.ts` |

## Tasks and reports

| ID | Promise | Why it matters | Test |
| --- | --- | --- | --- |
| INV-TASK-01 | An agent credential, or a missing, legacy or forged one, can never become the owner. | Owner rights decide approvals and what agents may do. | `packages/daemon/__tests__/task-auth.test.ts` |
| INV-TASK-02 | Only the owner's UI writes, edits, deletes and hands over report notes; agent tools, `/api/v1` and MCP are refused. | No agent can leave an "instruction" in the owner's name. | `packages/daemon/__tests__/task-report-notes.test.ts` |
| INV-TASK-03 | An agent sees only handed-over and done notes; an edited note is a draft again. | A draft is the owner's alone until they hand it over. | `packages/daemon/__tests__/task-report-notes.test.ts` |
| INV-TASK-04 | Reports follow the task domain rule: other domains neither see, read, delete nor restore them. | Reports from one project must not leak into another. | `packages/daemon/__tests__/task-reports.test.ts` |
| INV-TASK-05 | Invalid report input is rejected, never shortened, and a full store refuses new reports instead of dropping old ones. | Silent truncation or eviction loses the owner's reports. | `packages/daemon/__tests__/task-reports.test.ts` |
| INV-TASK-06 | A corrupt or unsupported task store rejects every change and keeps the original bytes. | Writing over a damaged store destroys what recovery could save. | `packages/daemon/__tests__/task-store.test.ts` |
| INV-TASK-07 | Parallel writers of the task store never lose an update; two commits from the same snapshot cannot both succeed. | Lost updates drop tasks or their history. | `packages/daemon/__tests__/task-store.test.ts` |
| INV-TASK-08 | A resolved task cannot regress its revision, lose its audit, disappear or re-arm by itself. | A finished task that fires again acts without the owner. | `packages/daemon/__tests__/task-store.test.ts` |
| INV-TASK-09 | The report store keeps fields a later version added on every write and never hands them out. | Going back one version must neither lock the owner out of their reports nor drop what the newer version stored. | `packages/daemon/__tests__/task-report-store.invariant.test.ts` |

## HTTP boundary of the daemon

| ID | Promise | Why it matters | Test |
| --- | --- | --- | --- |
| INV-HTTP-01 | Every TCP listener of the daemon binds to 127.0.0.1. | Direct local callers need no token; on 0.0.0.0 the network would get the vault. | `packages/daemon/__tests__/http-loopback.invariant.test.ts` |
| INV-HTTP-02 | A foreign or missing `Host` never gets the tokenless loopback path, also when no token is configured. | DNS rebinding or a tunnel would otherwise read the vault. | `packages/daemon/__tests__/http-rebinding-auth.test.ts` |
| INV-HTTP-03 | Forwarded requests (proxy headers) need the token on API, hook and UI routes. | A local reverse proxy must not open the tokenless path. | `packages/daemon/__tests__/http-rebinding-auth.test.ts` |
| INV-HTTP-04 | A browser origin that is not on the allowlist gets 403, whatever token it sends. | A foreign website must not drive the API through the user's browser. | `packages/daemon/__tests__/http-auth-gate.test.ts` |
| INV-HTTP-05 | Foreign and opaque browser origins cannot reach the local write routes. | Cross-site requests must not write to the vault. | `packages/daemon/__tests__/http-rebinding-auth.test.ts` |

## External contracts

| ID | Promise | Why it matters | Test |
| --- | --- | --- | --- |
| INV-CONTRACT-01 | The committed OpenAPI artifacts match the generated ones; a new route or changed schema cannot keep the old artifacts. | GPT Actions and other clients are built from these files. | `packages/daemon/__tests__/openapi-generator.test.ts` |
| INV-CONTRACT-02 | Without document write enabled, neither `/tools` nor the remote MCP door lists a document write tool. | A client must not be offered tools the daemon refuses. | `packages/daemon/__tests__/http-mcp.test.ts` |
| INV-SETTINGS-01 | Resetting or saving one setting never silently drops other stored settings of its group. | Lost settings switch off features or consent unseen. | `packages/daemon/__tests__/settings-registry.test.ts` |
| INV-SETTINGS-02 | The settings registry owns every CLI and UI key and validates values without echoing secrets. | An unknown or invalid key must not be stored, and a secret must not appear in an error. | `packages/daemon/__tests__/settings-registry.test.ts` |
| INV-NODE-01 | Every statement of the minimum Node.js version names `MIN_NODE_VERSION`; an older Node is refused with a way to check. | Installs on an unsupported Node fail in ways users cannot diagnose. | `tools/__tests__/support-matrix.test.mjs`, `packages/daemon/__tests__/node-support.test.ts` |

## Language

| ID | Promise | Why it matters | Test |
| --- | --- | --- | --- |
| INV-LANG-01 | No new language-bound matcher (word or language list) enters detection logic in daemon or core, and the guard cannot go blind. | The owner's decision: recall is multilingual; word lists fail every unlisted language. | `packages/daemon/__tests__/language-bound-matchers.test.ts` |
| INV-I18N-01 | German and English web UI catalogs carry the same keys and placeholders, and every key the UI asks for exists. | A missing key shows English or a raw key to a German user; a lost placeholder drops numbers. | `packages/daemon/__tests__/webui-i18n.invariant.test.ts` |
