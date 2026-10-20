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

For a Custom GPT, import `docs/gpt-action.json` in its Action editor, replace
`https://YOUR-TUNNEL.example.com/api/v1` with your HTTPS tunnel URL, and configure
bearer authentication with the daemon's `BASTRA_API_TOKEN`. Configure
`BASTRA_CORS_ORIGIN` if a browser client needs CORS. Document writes still need
`BASTRA_DOCUMENT_WRITE=1`. The Action includes all public `/api/v1` operations.
Tasks are excluded: their routes require a loopback Host and separately mapped
task credentials, and the preview is disabled unless `BASTRA_TASKS=1`. They
remain documented in the full local REST contract. A normal tunnel cannot use
them. The collection trailing-slash alias `/tasks/` behaves like `/tasks`.

## Differences from the previous hand-written starter

- Missing POST routes: `edit_memory`, `archive_memory`, `save_product_doc`,
  `review_draft`, `find_code`, `find_affected_files`, `floors`, `floors/affirm`,
  `floors/release`.
- Missing GET routes: `floors`, `graph`, `graph/semantic`, `graph/node`.
- Task routes already existed in the old spec, but incorrectly inherited the
  general API bearer scheme and tunnel-facing server guidance. They now use a
  distinct task credential scheme and explicitly document the local Host gate
  and preview switch. They are absent from the GPT Action.
- API version was stale (`0.8.6`); it now comes from the daemon package.
- Memory/document input properties now follow the shared handler validators
  instead of the starter's duplicate partial schemas. Hand-written response
  property lists were replaced by honest open objects until shared runtime
  response schemas exist.
