# Browser bridge: Safari gate and pairing preparation

Related: #98 (real Safari HTTPS → HTTP loopback verification), #96 (device pairing).
This is a manual probe and an implementation proposal. Neither issue is resolved
by adding these files. No production pairing is implemented.

## Synthetic probe

The existing production client in bastra-io's
`apps/bastra-io/app/admin/_lib/recall-client.ts` calls the local daemon directly
from browser JavaScript. Its settings/health UI uses the user's real token; do
not use that UI for this synthetic acceptance check. No dedicated hosted probe
fixture was found in that checkout during preparation.

From the repository root, with the usual development dependencies installed:

```sh
node --import tsx tools/probes/browser-bridge/server.ts https://bastra.io
```

Use the exact production origin, including `www` if applicable, without a path
or trailing slash. The process listens only on `127.0.0.1:16723` (allowed origin)
and `127.0.0.1:16724` (empty allowlist), and exits on Ctrl-C. Occupied ports are
an error; never stop another listener to free them. The process imports the
daemon's pure auth/CORS helpers, not its startup, settings, environment token,
tools, telemetry, or vault. It discards request bodies and logs only protocol
diagnostics. The only token is the public constant
`bastra-browser-probe-dummy-not-a-secret`. Never paste a real token here.

Open the actual hosted HTTPS page in Safari on the same Mac. Open Web Inspector
on that page, enable Preserve Log in Network, and paste the complete contents of
`tools/probes/browser-bridge/browser-probe.js` into its console. This runs in the
hosted page's real origin without deploying a fixture or sending anything to
the hosted server. Record browser/macOS versions and any local-network prompt
and its choice. Keep the page's normal security/CSP settings and extensions in
place for the baseline; report any changes separately.

The script makes five synthetic requests, omits cookies, and prints a report.
It does not read app settings, token storage, cookies, or page content. A timeout
is ten seconds per request. Inspect the fixture terminal and browser Network
panel together:

| Case | Browser evidence | Fixture evidence |
| --- | --- | --- |
| Allowed GET + dummy bearer | readable 200, `synthetic: true` | GET 200, CORS true |
| Allowed JSON POST + dummy bearer | readable 200, `synthetic: true` | POST 200, CORS true |
| Allowed JSON POST, no bearer | readable 401 | POST 401, CORS true |
| Allowed JSON POST, wrong bearer | readable 401 | POST 401, CORS true |
| Denied origin + dummy bearer | fetch rejects; no readable body | OPTIONS 204, CORS false; normally no POST |

Preflight responses on the allowed port must reflect only the requested exact
origin and allow `Content-Type, Authorization`; if the browser requests Private
Network Access, only an allowed preflight receives the corresponding header.
Preflight caches may suppress repeated OPTIONS; use a fresh browser session for
the first observation. The denied case is deliberately marked unconfirmed in
the report: rejection alone also happens when the server is down, CSP blocks
the URL, or Safari blocks mixed content. Mark it passed manually only with the
matching denied fixture log. A preflight 204 without an allow-origin header is
the expected denial, not permission.

If Safari sends no request, preserve its exact console/network error. Separate
mixed-content, CSP `connect-src`, local-network permission, connection refusal,
CORS, and 401 evidence; do not label every `TypeError` a CORS failure. If the
production CSP forbids these fixture ports, this particular probe is blocked;
do not relax live CSP or change the production daemon to force a result.

Optional terminal controls (protocol checks only, never Safari evidence):

```sh
curl -i -X OPTIONS http://127.0.0.1:16723/api/v1/probe \
  -H 'Origin: https://bastra.io' -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type' \
  -H 'Access-Control-Request-Private-Network: true'
curl -i -X POST http://127.0.0.1:16723/api/v1/probe \
  -H 'Origin: https://bastra.io' -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer bastra-browser-probe-dummy-not-a-secret' \
  --data '{"synthetic":true}'
```

Repeat against port 16724 for denial, and omit/change the dummy bearer for 401.
Do not substitute port 6723: that is the real daemon.

Acceptance record to attach to #98 after actual execution:

```text
Date / commit / tester:
Safari version / macOS version:
Hosted page URL and actual location.origin:
Local-network prompt and decision:
Normal CSP/extension baseline:
Allowed GET 200 / POST 200 / missing+wrong bearer 401:
Denied preflight observed, no readable response:
Console report + sanitized fixture log + Network/console evidence:
Limitations / exact blocking error:
Decision: PASS / BLOCKED / FAIL
```

Repeat in currently supported Chrome/Edge/Firefox for comparison. A local file,
HTTP development origin, curl, or Playwright WebKit does not establish Safari
behavior. Until real Safari evidence exists, #98 remains open and #96's
production implementation remains gated. This synthetic test establishes the
transport/policy behavior of the fixture; production configuration and the
full app integration still require separate acceptance.

## Small implementation proposal for #96, after the Safari gate

Keep manual `bastra token --origin` onboarding. Current auth is a single API
token plus an independent CORS allowlist, not a token cryptographically bound
to one origin. Do not return that global token from pairing: it could be reused
outside the paired browser or with another allowed origin. Reuse the auth and
settings modules, but introduce a separate revocable browser grant whose token
is valid only with its recorded exact Origin. No hosted pairing service.

1. **Bounded in-memory pairing state and two narrow bootstrap routes.** Add
   `/api/v1/pair/start` and `/api/v1/pair/poll` in a dedicated dispatcher before
   the normal bearer gate; only these routes can work before an API token is
   known. Start generates a 256-bit random `device_code`, independent eight
   character human code, a five minute expiry, and a minimum three second poll
   interval. Store only hashes of secrets where possible; discard all pending
   state on restart. Codes must be unique among active requests. Poll needs the
   device secret and the same exact browser Origin; a human code alone cannot
   redeem. Return pending/denied/expired/slow-down statuses without a token.
2. **Bootstrap CORS is an explicit design review item.** Existing API CORS must
   stay unchanged. To pair a previously unknown website in one step, only the
   two bootstrap routes need a separate policy accepting a syntactically exact
   HTTPS Origin. This permits requests, never approval or vault access. No `*`,
   no `null`/opaque origins, redirects, path-bearing origins or wildcard hosts.
   A conservative first version may require an already configured origin;
   document its extra setup step. Decide this tradeoff before implementation,
   rather than accidentally widening the existing global allowlist.
3. **Local approval only.** Add `bastra pair list`, `bastra pair approve CODE`,
   `bastra pair deny CODE`, `bastra pair list-grants`, and `bastra pair revoke ID`.
   CLI displays the full validated origin, expiry, and access scope, asks for
   explicit local confirmation, and never opens unsolicited approval dialogs.
   Approve/revoke require loopback peer + loopback Host + absent Origin + an
   explicit local administrative credential; never inherit `loopbackSkip`.
   Reuse the private local API credential if suitable, and reject an unset one.
   HTTP source address alone cannot distinguish a website from local CLI.
4. **Issue a separate browser grant.** After approval, mint a fresh random
   bearer, persist only its digest with origin/id/created/expiry metadata via
   the atomic private settings writer, and deliver the raw value only to its
   matching poll, once. Use a bounded lifetime (proposed 30 days) and explicit
   revoke; no refresh in the first version. Make active-grant auth visible to
   the running HTTP context without a daemon restart. Existing global token
   behavior remains compatible. Pairing tokens must fail with absent/wrong
   Origin even if the host is loopback or another origin is allowed. Describe
   the grant as full REST access for that origin, not least privilege.
5. **Consume before response and bound all work.** Atomically transition
   approved → consumed before sending the token; concurrent polls must yield
   at most one delivery. A lost successful response requires fresh pairing.
   Denied, expired, consumed and revoked codes never revive. Propose start
   limits of 5/minute/origin and 30/minute globally, 8 pending/origin and 32
   globally; code-approval failures and polls also need bounded counters and
   expiry cleanup. Origin alone is attacker controlled, so global caps matter.
   Enforce body/secret lengths and constant-time digest checks. Do not log
   secrets, include them in URLs, echo them into errors, or send them through
   analytics/server actions. Browser holds the device code only in memory;
   storage/lifetime of the final token needs explicit client review (XSS can
   read any JS-accessible token). Never reuse current server-side token storage
   automatically, which would expose the new grant to the hosted backend.

Suggested code boundaries: new `pairing.ts` state machine and
`http-pairing-routes.ts`; integrate bootstrap routing in `http.ts`, scoped
checks in `http-auth.ts`, private grant persistence in `settings.ts` (and its
schema), and CLI registry/flags/help plus `cli/pair.ts`. Review startup auth
context loading: token/CORS settings currently enter the HTTP context at
startup, so writing settings alone cannot activate pairing grants. Update the
HTTP route inventory/OpenAPI generation for the new public routes; this is
separate from MCP session/OAuth pairing.

Required tests in that future change: fake-clock expiry/slow polls; pending
caps and per-origin/global limits; foreign/opaque/missing origins; browser
attempts to approve; wrong device secret; guessed human code; parallel poll
single-use; revoke/expiry/restart; lost response; malformed settings; grant
versus global-token compatibility; no token/secret in logs/errors; CORS only
on intended bootstrap routes. Then rerun hosted Safari acceptance with the
real pairing UI before claiming no-copy-paste onboarding works.
