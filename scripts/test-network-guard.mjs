/** Test-only guard inherited by Node CLI grandchildren through NODE_OPTIONS.
 * An explicit child env that drops NODE_OPTIONS, and Worker threads without
 * this preload, are outside this guard. It is not a process-tree sandbox. */
import { Socket, isIP } from "node:net";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

function loopback(host = "localhost") {
  const name = String(host)
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (name === "localhost") return true;
  if (!isIP(name)) return false; // Never resolve a public hostname to test isolation.
  const canonical = new URL(`http://${name.includes(":") ? `[${name}]` : name}`).hostname;
  return /^127\./.test(canonical) || canonical === "[::1]" || /^\[::ffff:7f[0-9a-f]{2}:/.test(canonical);
}

function refused(host, port) {
  if (![80, 6723].includes(Number(port)) && loopback(host)) return null;
  const root = process.env.BASTRA_TEST_RUN_ROOT;
  if (root)
    appendFileSync(
      join(root, "blocked-daemon-connections.jsonl"),
      JSON.stringify({ pid: process.pid, host, port: Number(port) }) + "\n"
    );
  return Object.assign(new Error("test isolation: refusing the operator daemon or non-loopback network destination"), {
    code: "ECONNREFUSED",
  });
}

const original = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  // Node's internal normalized form is an array; public forms are options/port.
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  // UNIX/named-pipe IPC carries no TCP port, including the public path form.
  if (
    (typeof first === "object" && first !== null && first.path) ||
    (typeof first === "string" && !/^\d+$/.test(first))
  )
    return original.apply(this, args);
  const port = typeof first === "object" && first !== null ? first.port : first;
  const host =
    typeof first === "object" && first !== null
      ? first.host
      : typeof normalized[1] === "string"
        ? normalized[1]
        : "localhost";
  const error = refused(host, port);
  if (error) {
    queueMicrotask(() => this.destroy(error));
    return this;
  }
  return original.apply(this, args);
};

// Fetch may use a separate connector; reject its URL before DNS or native IO.
const fetch = globalThis.fetch;
if (fetch)
  globalThis.fetch = async function (input, init) {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.protocol === "http:" || url.protocol === "https:") {
      const error = refused(url.hostname, url.port || (url.protocol === "https:" ? 443 : 80));
      if (error) throw error;
    }
    return fetch.call(this, input, init);
  };
