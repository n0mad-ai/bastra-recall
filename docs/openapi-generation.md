# REST contract (and legacy Custom GPT Action)

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

## Legacy: Custom GPT Action

> **Deprecated.** OpenAI retires Custom GPTs on 2026-12-11, and custom actions
> do not migrate to their replacement. To connect ChatGPT on the web and on the
> phone, use the MCP connection in [Remote access](./REMOTE-ACCESS.md) instead.
> The steps below stay for existing Custom GPTs until then; the REST contract
> above is unaffected.

A Custom GPT Action needs the same public HTTPS address as the MCP route. Set
it up and verify it as described in [Remote access](./REMOTE-ACCESS.md): a
tunnel or reverse proxy that preserves the public `Host` header, publishes only
`/api/v1/` (never `/hook` or `/ui`), and answers `401` without a token and
`200` with it. [The Host rule](./REMOTE-ACCESS.md#the-host-rule-why-the-tunnel-must-not-rewrite-host)
explains why the `401` check is mandatory and when the optional
`BASTRA_AUTH_LOOPBACK_SKIP=0` is worth its cost. Then generate your
personalized Action file:

```sh
npm run openapi:generate -- --server-url https://recall.your-domain.com --output /tmp/my-recall-action.json
```

You may also supply the address ending in `/api/v1`. The generator adds that
suffix when it is absent. This mode leaves the checked-in default files alone.
Without `--output`, it writes JSON to stdout; use `npm run --silent` when
redirecting stdout to a file.

Import the generated file in your Custom GPT's Action editor. Set authentication
to **API Key → Bearer** and enter the daemon's API token (`bastra token`) there.
Never put the token in the address, schema, or conversation. The generator
rejects URL credentials, query strings and fragments. It also rejects HTTP,
non-443 ports, localhost and literal LAN addresses. DNS names must resolve
publicly; the generator does not check live DNS, reachability or certificates.

Use HTTPS on **port 443**, TLS 1.2 or newer, and a valid public certificate.
`127.0.0.1` and `192.168.x.x` will not work for cloud Actions, even when the
phone is on the same Wi-Fi. See the official
[GPT Actions production requirements](https://developers.openai.com/api/docs/actions/production).
Configure `BASTRA_CORS_ORIGIN` separately if a browser app needs CORS.
Document writes still need `BASTRA_DOCUMENT_WRITE=1`.

The Action includes all public `/api/v1` operations. Tasks are excluded: their
routes require a loopback Host and separately mapped task credentials, and the
preview is disabled unless `BASTRA_TASKS=1`. They remain documented in the full
local REST contract. A normal tunnel cannot use them. The collection
trailing-slash alias `/tasks/` behaves like `/tasks`. Mobile end-to-end
operation of the Action path was never verified.

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
