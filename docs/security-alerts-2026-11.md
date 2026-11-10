# GitHub security warning review — 2026-11-10

Base: `3734975a`. Eight open code-scanning alerts: seven CodeQL, one Scorecard. Dependabot and secret scanning: zero open.

## Fixed: filesystem races (#183, #184)

Both check/read races reproduced in deterministic symlink-swap tests before the fix. Legacy hook migration and the explicit E2E credential copy now open with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, inspect and read the same descriptor, and close it in `finally`. Hook migration backups use the captured bytes and exclusive private creation. The probe destination is also created exclusively. No live credentials were used in tests.

## Individually dismissed findings

### #179 — won't fix

Required vendored runtime asset, intentionally retained. This is the portable Bash grammar used by packages/daemon/src/github-shell-actions.ts to parse shell syntax without executing it (#1330). Pinned upstream release: https://github.com/tree-sitter/tree-sitter-bash/releases/tag/v0.25.1 (MIT). Independently downloaded the official WASM release and verified byte-for-byte SHA-256 8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a, matching vendor/tree-sitter-bash.json and the runtime checksum gate. It is needed for portable parsing; removing it breaks production action detection. This is an intentional verified dependency, not an unexplained binary. Regression coverage: codeql-alert-triage.test.ts and github-shell-actions tests.

### #180 — false positive

The interpolated tag is match[1] from TOOL_WRAPPER_START, whose capture contains only six fixed protocol tag literals (letters and hyphens). No attacker-selected regexp metacharacters can reach new RegExp. The matching expression has no attacker-selected repetition. Uppercase captures are rejected before prose recovery. Verified all six canonical pairs, uppercase rejection, and hostile metacharacter tag strings in codeql-alert-triage.test.ts. No natural-language detection or wordlist was added.

### #181 — false positive

The input to /^-+|-+$/g has already passed through .replace(/[^\p{L}\p{N}]+/gu, "-"). That global replacement collapses EVERY maximal separator run, including every hyphen run, to one hyphen. The flagged edge-trim regex therefore cannot encounter repeated hyphens; each attempt inspects at most one. Its input scan is linear, not polynomial. Verified 200,000-character separator-only and edge-separated filenames through repairRequired in codeql-alert-triage.test.ts; existing Unicode slug semantics are preserved.

### #182 — false positive

The flagged openSync(path, "r") is syncFile: it opens an already-created database backup READ-ONLY for fsync; it never creates or truncates a temporary file. Creation is separately performed by reservePrivateFile using openSync(path, "wx", 0o600), after local-path/symlink checks. Backups reject collisions; app-database tests cover backup collision, symlink endpoints and private database behavior. The CodeQL InsecureTemporaryFileCustomizations OpenFileCall sink checks a missing mode argument without excluding read-only opens. No permissions or exclusive creation were relaxed.

### #185 — false positive

This condition decides whether to attempt task authentication, not whether to authorize a sensitive action. privateTaskRequest starts false and becomes true ONLY after authenticateTask validates a stored mapped credential. That verified credential then REQUIRES OS peer-account verification. Explicit UI/task paths independently require the account gate via localAccountPath. Omitting/invalidating the header cannot expose private task cards: taskAttachment authenticates again before reading its snapshot, and task routes authenticate independently. Expanded the real HTTP foreign-peer regression: omitted and invalid credentials on public health return no proactive_due and do not access task state; valid credentials require the account gate. Existing tests also verify foreign peers, spoofed UID headers, token, forwarding and Origin rejection. Public health remains deliberately public.

### #186 — false positive

The flagged open(path, O_RDONLY | O_NOFOLLOW) in readRecord only reads existing records. The descriptor is checked for regular-file type, current UID, private permissions and bounded size before JSON parsing. It cannot create/truncate a temporary file. writeRecord instead creates UUID-suffixed files with open(temp, "wx", 0o600) inside the owned private registry, then atomically renames. Existing task-chat-registry tests cover symlink endpoints, private registry and runtime behavior. CodeQL InsecureTemporaryFileCustomizations treats open calls without a mode argument as sinks even when their flags are read-only. No protection was removed.

## Quality coverage

The documented [Code Quality API](https://docs.github.com/en/rest/code-quality/code-quality?apiVersion=2026-03-10) was checked: `/code-quality/setup` returns 404 with the explicit message “Code quality is not available for this repository”; `/code-quality/findings?state=open` also returns 404. There is no available separate Code Quality findings inventory to report as zero. Code-scanning analyses contain CodeQL and Scorecard only; all open findings from both were reviewed. The existing CodeQL security-extended configuration and path coverage were not changed.

## Deutsch

Acht einzelne Warnungen geprüft: zwei reproduzierte Dateisystem-Races behoben, fünf Fehlalarme nachgewiesen und die benötigte Bash-WASM-Grammatik nach Abgleich mit dem offiziellen Release bewusst beibehalten. Jede GitHub-Schließung hat eine eigene Begründung. Code Quality ist laut ausdrücklicher API-Antwort für dieses Repository nicht verfügbar; Dependabot und Secret Scanning melden keine offenen Befunde. Kontobindung, Token, Origin/CSRF und Scan-Konfiguration bleiben erhalten.
