import { isIP } from "node:net";

/** A cloud Action must reach the daemon from outside the user's LAN. */
export function actionServerUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Use a public HTTPS address, for example https://recall.your-domain.com."); }
  if (url.protocol !== "https:") throw new Error("GPT Actions require a public HTTPS address. Use an HTTPS tunnel for a local Recall daemon.");
  if (url.port && url.port !== "443") throw new Error("GPT Actions require HTTPS on port 443. Configure your public tunnel/domain to use port 443.");
  if (url.username || url.password || url.search || url.hash) throw new Error("Keep credentials and tokens out of the address. Configure bearer authentication separately in the GPT editor.");
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const ipVersion = isIP(host);
  let local = false;
  if (ipVersion === 4) {
    const [a, b] = host.split(".").map(Number);
    local = a === 0 || a === 10 || a === 127 || (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) || a! >= 224;
  } else if (ipVersion === 6) {
    // Only global-unicast IPv6 (2000::/3); excludes loopback, link-local,
    // unique-local, IPv4-mapped private addresses, and multicast.
    local = !/^[23][0-9a-f]{3}:/.test(host);
  } else {
    local = /(?:^|\.)home\.arpa$/.test(host) || !host.includes(".") || /(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|onion)$/.test(host);
  }
  if (local) throw new Error("Localhost and LAN addresses cannot be reached by a cloud GPT Action. Use your public HTTPS domain/IP or an HTTPS tunnel.");
  const path = url.pathname.replace(/\/+$/, "");
  if (path && path !== "/api/v1") throw new Error("Use the public server address, optionally ending in /api/v1; other paths are not supported.");
  url.pathname = "/api/v1";
  return url.toString().replace(/\/$/, "");
}
