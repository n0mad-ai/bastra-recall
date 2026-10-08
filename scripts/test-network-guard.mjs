/** Test-only guard inherited by Node CLI grandchildren through NODE_OPTIONS. */
import { Socket } from "node:net";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const original = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  // Node's internal normalized form is an array; public forms are options/port.
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  const port = typeof first === "object" && first !== null ? first.port : first;
  const host = typeof first === "object" && first !== null ? first.host : typeof normalized[1] === "string" ? normalized[1] : "localhost";
  if (Number(port) === 6723 && [undefined, "localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(host)) {
    const root = process.env.BASTRA_TEST_RUN_ROOT;
    if (root) appendFileSync(join(root, "blocked-daemon-connections.jsonl"), JSON.stringify({ pid: process.pid, host, port: 6723 }) + "\n");
    const error = Object.assign(new Error("test isolation: refusing the operator daemon on port 6723"), { code: "ECONNREFUSED" });
    queueMicrotask(() => this.destroy(error));
    return this;
  }
  return original.apply(this, args);
};
