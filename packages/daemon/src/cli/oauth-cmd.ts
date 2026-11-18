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
import { oauthWords } from "./oauth-words.js";

export async function cmdOAuth(args: { sub: string | null; positional: string[]; json: boolean }): Promise<number> {
  const sub = args.sub ?? "list";
  const w = await oauthWords();
  if (sub === "list") {
    const clients = await listClients();
    if (args.json) {
      process.stdout.write(JSON.stringify({ clients }, null, 2) + "\n");
      return 0;
    }
    if (clients.length === 0) {
      process.stdout.write(w.none);
      return 0;
    }
    for (const c of clients) {
      const hosts = [...new Set(c.redirect_uris.map((u) => new URL(u).host))].join(", ");
      process.stdout.write(
        // Sanitised at registration already; again here for files written
        // before that, or by hand — a name must not drive the terminal.
        `${c.client_id}  ${sanitizeClientName(c.client_name)}\n` +
          w.redirect(hosts) +
          w.registered(c.created_at, c.grants) +
          w.lastToken(c.last_used_at ?? null) +
          "\n"
      );
    }
    return 0;
  }
  if (sub === "revoke") {
    const id = args.positional[2];
    if (!id) {
      process.stderr.write(w.needsId);
      return 2;
    }
    const removed = await revokeClient(id);
    if (args.json) {
      process.stdout.write(JSON.stringify({ revoked: removed }) + "\n");
      return removed > 0 || id === "all" ? 0 : 1;
    }
    if (removed === 0 && id !== "all") {
      process.stderr.write(w.noClient(id));
      return 1;
    }
    process.stdout.write(w.revoked(removed));
    return 0;
  }
  process.stderr.write(w.unknownSub(sub));
  return 2;
}
