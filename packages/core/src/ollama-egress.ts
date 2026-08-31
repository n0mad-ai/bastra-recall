import net from "node:net";

/**
 * Egress contract for the local Ollama endpoint.
 *
 * Both the reranker (chat, candidate text) and the embedding provider (query +
 * memory text) talk to Ollama at `BASTRA_OLLAMA_URL`. The documented contract is
 * "no API key, no cloud, no egress" — the text stays on the machine. But the URL
 * is a free-form env var, so a mistyped or injected value would silently ship
 * memory text off-box.
 *
 * This is the single shared assertion that enforces the contract: stay on
 * loopback by default, reach a remote endpoint only when the operator opts in
 * explicitly (BASTRA_ALLOW_REMOTE_OLLAMA=1). Malformed URLs fall through so the
 * existing fetch path reports them exactly as before (behaviour unchanged).
 *
 * Lives in core (the lower layer) so the daemon reranker and the core embedding
 * provider share one guard instead of each re-implementing it.
 *
 * OUT OF SCOPE — DNS rebinding: this guard checks the *form* of the URL, never
 * the IP the socket ends up on. A hostname that resolves to 127.0.0.1 when the
 * guard runs can resolve elsewhere when fetch connects. Closing that would take
 * a custom agent with a `lookup` hook that re-checks the resolved address; it is
 * a separate change, deliberately not attempted here.
 */
export function assertLocalOrOptIn(rawUrl: string): void {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return; // not a parseable URL — let fetch fail normally, behaviour unchanged
  }
  if (isLoopbackHost(host) || process.env.BASTRA_ALLOW_REMOTE_OLLAMA === "1") return;
  throw new Error(
    `bastra-recall: refusing non-loopback Ollama endpoint "${host}" — this would ` +
      `send memory text off-box. Set BASTRA_ALLOW_REMOTE_OLLAMA=1 to use a remote endpoint on purpose.`,
  );
}

/**
 * Classify the hostname, never its spelling. A prefix test on the string
 * (`/^127\./`) accepts every DNS name that merely starts that way —
 * `127.evil.example`, `127.0.0.1.nip.io` — which is an ordinary registrable
 * name resolving wherever its owner points it. So: decide with `net.isIP`, and
 * treat anything that is NOT an IP literal as a name that may resolve anywhere.
 */
function isLoopbackHost(host: string): boolean {
  // `URL.hostname` keeps IPv6 literals bracketed ("[::1]"); net.isIP does not
  // accept the brackets.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const kind = net.isIP(bare);
  if (kind === 4) return isLocalIPv4(bare);
  if (kind === 6) {
    if (bare === "::1") return true;
    if (bare === "::") return true; // the v6 wildcard, as 0.0.0.0 is for v4
    const mapped = mappedIPv4(bare);
    return mapped !== undefined && isLocalIPv4(mapped);
  }
  // Not an IP literal. Only the reserved name itself (RFC 6761), with or
  // without the RFC 1035 fully-qualified root dot. `*.localhost` subdomains are
  // NOT accepted: whether they resolve to loopback is up to the resolver, and
  // the opt-in covers that case deliberately.
  return host === "localhost" || host === "localhost.";
}

/** 127.0.0.0/8 plus 0.0.0.0 — the bind-all address a local Ollama really uses. */
function isLocalIPv4(ip: string): boolean {
  return ip.startsWith("127.") || ip === "0.0.0.0";
}

/**
 * Dotted quad of an IPv4-mapped IPv6 address, or undefined. Node's URL parser
 * folds `::ffff:127.0.0.1` to the hex form `::ffff:7f00:1`, so the mapped
 * loopback has to be recognised through the hex groups, not through a "127."
 * substring.
 */
function mappedIPv4(v6: string): string | undefined {
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (!m) return undefined;
  const hi = Number.parseInt(m[1], 16);
  const lo = Number.parseInt(m[2], 16);
  return `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
}
