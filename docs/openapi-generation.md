# REST contract and Custom GPT Action

Run `npm run openapi:generate` after changing HTTP routes or shared tool input
schemas. Commit both `docs/openapi.yaml` and `docs/gpt-action.json`.
`npm run openapi:check` checks both byte for byte and exits nonzero on missing
or changed output. CI runs this gate after building the workspaces.

The YAML file uses JSON syntax (valid YAML 1.2), so it needs no extra YAML
serializer. Both artifacts use OpenAPI 3.0.3. Zod converts the actual handler validators
with its OpenAPI 3.0 target and input mode (defaults remain optional).
The generator discovers POST case labels in `http-api-routes.ts` and GET
pathname guards in `http-api-surface.ts` (the dispatchers called by `http.ts`).
Adding an undocumented POST handler fails generation until it has a shared
input schema. Floor fields derive from the inline handler's body accesses.
Task tool routes use the task tool definitions; REST aliases use the same
`TASK_HTTP_ROUTES` table as the live matcher. No parallel hand-maintained list
of API paths exists. If the dispatcher syntax changes, update the discovery
visitor and its tests together. Query parameters are discovered from the GET
handler's `searchParams.get` calls.

Input contracts come from the same Zod validators called by the handlers.
Cross-field refinements and filesystem/permission checks still run at request
time; JSON Schema cannot express every handler check. Result bodies are intentionally open JSON objects because handlers
currently have no shared response schemas. The generator does not invent
complete response shapes from examples. Loopback-only hooks, UI routes, and
internal administrative endpoints outside `/api/v1` are outside this contract.

## Connect your Recall to a Custom GPT on web and phone

Use your own public HTTPS address, for example `https://recall.your-domain.com`.
It must lead to the daemon through a tunnel or reverse proxy. Before exposing
it, set **`BASTRA_AUTH_LOOPBACK_SKIP=0`** and a strong **`BASTRA_API_TOKEN`** in
the daemon's environment, then restart the daemon with those settings. Preserve
the original public `Host` header when forwarding (for nginx, use
`proxy_set_header Host $http_host;`). Publish **only `/api/v1/`**, blocking all
other paths, including `/hook` and `/ui`.

**Warning:** a proxy on the same machine can appear to the daemon as a local
caller. nginx's default upstream Host, ngrok's `--host-header=rewrite`, or
cloudflared's `httpHostHeader` can rewrite Host to `127.0.0.1` or `localhost`.
With the default loopback exemption, that combination can bypass bearer auth,
exposing API data and any forwarded hooks/UI. Disabling loopback skip is required;
Host preservation and limiting the published paths are additional protections.

Before importing the Action, test the public URL from outside your LAN:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://recall.your-domain.com/api/v1/health
# Required: 401 (no token)
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $BASTRA_API_TOKEN" https://recall.your-domain.com/api/v1/health
# Required: 200 (valid token)
```

Also verify that `/hook` and `/ui` are blocked by the proxy. Do not publish until
these checks pass. Generate your personalized Action file:

```sh
npm run openapi:generate -- --server-url https://recall.your-domain.com --output /tmp/my-recall-action.json
```

You may also supply the address ending in `/api/v1`. The generator adds that
suffix when it is absent. This mode leaves the checked-in default files alone.
Without `--output`, it writes JSON to stdout; use `npm run --silent` when
redirecting stdout to a file.

Import the generated file in your Custom GPT's Action editor. Set authentication
to **API Key → Bearer** and enter the daemon's `BASTRA_API_TOKEN` there. Never
put the token in the address, schema, or conversation. The generator rejects
URL credentials, query strings and fragments. It also rejects HTTP, non-443
ports, localhost and literal LAN addresses. DNS names must resolve publicly;
the generator does not check live DNS, reachability or certificates.

Use HTTPS on **port 443**, TLS 1.2 or newer, and a valid public certificate.
A public IP can work only with a valid certificate for that address; a domain
is usually easier. `127.0.0.1` and `192.168.x.x` will not work for cloud Actions,
even when the phone is on the same Wi-Fi. See the official
[GPT Actions production requirements](https://developers.openai.com/api/docs/actions/production).
If your firewall restricts sources, use the ChatGPT address ranges documented
there. Configure `BASTRA_CORS_ORIGIN` separately if a browser app needs CORS.
Document writes still need `BASTRA_DOCUMENT_WRITE=1`.

The configured GPT uses the same public Recall address when opened on the web
or on a phone. No phone-specific IP or second schema is needed. Verify both
clients before relying on the connection: call the `get_health` Action from the
web, then open that same GPT on the phone and repeat the call. Finally ask both
to recall a known, non-private memory. Check that both reach the intended vault.
Mobile end-to-end operation has not been tested by this generator's tests.

The Action includes all public `/api/v1` operations. Tasks are excluded: their
routes require a loopback Host and separately mapped task credentials, and the
preview is disabled unless `BASTRA_TASKS=1`. They remain documented in the full
local REST contract. A normal tunnel cannot use them. The collection
trailing-slash alias `/tasks/` behaves like `/tasks`.

## Connect ChatGPT and claude.ai over MCP (OAuth)

The daemon also serves MCP over Streamable HTTP at `/api/v1/mcp`. Claude Code
and curl reach it with the same `Authorization: Bearer $BASTRA_API_TOKEN`
header as the REST routes. ChatGPT custom connectors (developer mode) and
claude.ai custom connectors cannot send a static header, so the daemon is also
its own OAuth 2.1 authorization server for this one route (MCP authorization
spec 2025-11-25: protected resource metadata, authorization server metadata,
dynamic client registration, authorization code with PKCE S256, rotating
refresh tokens, tokens bound to the MCP URL).

The tunnel setup above applies unchanged (loopback skip off, Host preserved).
In addition to `/api/v1/`, publish exactly these three GET paths — they are
public discovery documents without secrets:

- `/.well-known/oauth-protected-resource/api/v1/mcp`
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`

For a cloudflared ingress rule, one regular expression covers them:
`^/\.well-known/oauth-(protected-resource(/api/v1/mcp)?|authorization-server)$`.
Keep every other path, including `/hook` and `/ui`, blocked.

Connect:

1. Make sure the daemon has an API token (`bastra token`).
2. In ChatGPT, enable developer mode and create a connector; in claude.ai, add
   a custom connector. Use `https://recall.your-domain.com/api/v1/mcp` as the
   URL, choose OAuth, and leave client ID and secret empty. The client
   registers itself.
3. A browser page "Connect to Bastra Recall" opens on your domain. Check that
   the redirect host shown is `chatgpt.com` or `claude.ai`, enter your API
   token and approve.

Redirects are restricted to a fixed allowlist: https on `chatgpt.com`,
`chat.openai.com`, `claude.ai` and `claude.com`, plus plain http on
`localhost` and `127.0.0.1` (any port) for local tools. Other clients cannot
register. Five wrong tokens end a login attempt; the client has to start
over.

An OAuth access token opens `/api/v1/mcp` only, never the REST routes. Tokens
are stored hashed in `~/.bastra/oauth.json`. Manage the approved clients from
the terminal; a revocation takes effect on the next request:

```sh
bastra oauth list
bastra oauth revoke <client_id>
bastra oauth revoke all
```

## Differences from the previous hand-written starter

- Missing POST routes: `edit_memory`, `archive_memory`, `save_product_doc`,
  `review_draft`, `find_code`, `find_affected_files`, `floors`, `floors/affirm`,
  `floors/release`.
- Missing GET routes: `floors`, `graph`, `graph/semantic`, `graph/node`.
- Task routes and their distinct `taskBearerAuth` scheme already existed in the
  old spec. The generator preserves separate task credentials (named
  `taskCredential` in the generated contract), documents the local Host gate and
  preview switch, and excludes tasks from the GPT Action. The full REST contract
  now defaults to a local server address instead of tunnel-facing guidance.
- API version was stale (`0.8.6`); it now comes from the daemon package.
- Memory/document input properties now follow the shared handler validators
  instead of the starter's duplicate partial schemas. Hand-written response
  property lists were replaced by honest open objects until shared runtime
  response schemas exist.
