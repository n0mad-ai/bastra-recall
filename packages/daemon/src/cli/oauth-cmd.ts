/**
 * `bastra oauth` — the remote MCP clients (ChatGPT, claude.ai connectors) that
 * were approved through the daemon's OAuth login (#1279), and how to cut them
 * off. `list` (default) shows each client with its grants; `revoke <client_id>`
 * removes one client and every token it holds, `revoke all` removes them all.
 *
 * Works on the token file directly: the daemon reads it on every request, so a
 * revocation bites on the next call without a restart. The client has to run
 * the login again — with the API token — to get back in.
 */
import { listClients, revokeClient, sanitizeClientName } from "../oauth-store.js";

export async function cmdOAuth(args: { sub: string | null; positional: string[]; json: boolean }): Promise<number> {
  const sub = args.sub ?? "list";
  if (sub === "list") {
    const clients = await listClients();
    if (args.json) {
      process.stdout.write(JSON.stringify({ clients }, null, 2) + "\n");
      return 0;
    }
    if (clients.length === 0) {
      process.stdout.write("no OAuth clients registered.\n");
      return 0;
    }
    for (const c of clients) {
      const hosts = [...new Set(c.redirect_uris.map((u) => new URL(u).host))].join(", ");
      process.stdout.write(
        // Sanitised at registration already; again here for files written
        // before that, or by hand — a name must not drive the terminal.
        `${c.client_id}  ${sanitizeClientName(c.client_name)}\n` +
          `  redirect: ${hosts}\n` +
          `  registered ${c.created_at}, ${c.grants} grant(s)` +
          (c.last_used_at ? `, last token ${c.last_used_at}` : ", never approved") +
          "\n",
      );
    }
    return 0;
  }
  if (sub === "revoke") {
    const id = args.positional[2];
    if (!id) {
      process.stderr.write("error: 'bastra oauth revoke' needs a client_id (see 'bastra oauth list') or 'all'\n");
      return 2;
    }
    const removed = await revokeClient(id);
    if (args.json) {
      process.stdout.write(JSON.stringify({ revoked: removed }) + "\n");
      return removed > 0 || id === "all" ? 0 : 1;
    }
    if (removed === 0 && id !== "all") {
      process.stderr.write(`error: no OAuth client with id '${id}'\n`);
      return 1;
    }
    process.stdout.write(`revoked ${removed} client(s) — their tokens stop working on the next request.\n`);
    return 0;
  }
  process.stderr.write(`error: unknown 'oauth' subcommand '${sub}' — use 'bastra oauth list' or 'bastra oauth revoke <client_id|all>'\n`);
  return 2;
}
