/**
 * Test helper for the lane timing characterizations (#1512, #1513, #1525):
 * records the timeout every loopback request is created with, and can let a
 * request's socket timeout expire at once, without waiting on a real clock.
 *
 * `node:http`'s `request` is wrapped on the module object and pushed into the
 * ESM named exports with `syncBuiltinESMExports()`, so the lanes' own
 * `import { request } from "node:http"` sees it. Nothing in product code is
 * touched; `restore()` puts the original back.
 */
import http, { type ClientRequest, type RequestOptions } from "node:http";
import { syncBuiltinESMExports } from "node:module";

export interface SpiedRequest {
  method: string;
  path: string;
  /** The `timeout` option (Node's socket idle timeout); undefined = none set. */
  timeout: number | undefined;
}

export interface LoopbackSpy {
  /** Requests to `port`, in the order the lane created them. */
  seen: SpiedRequest[];
  restore: () => void;
}

/**
 * Spy on requests to `port`. A request whose path (without query) is in
 * `expire` gets its `timeout` event on the next tick — what Node emits once
 * the socket idle timeout has run out.
 */
export function spyLoopbackRequests(port: number, expire: ReadonlySet<string> = new Set()): LoopbackSpy {
  const original = http.request;
  const seen: SpiedRequest[] = [];
  const wrapped = ((...args: unknown[]): ClientRequest => {
    const req = (original as (...a: unknown[]) => ClientRequest)(...args);
    const opts = args[0];
    if (opts && typeof opts === "object" && !(opts instanceof URL)) {
      const o = opts as RequestOptions;
      if (Number(o.port) === port) {
        const path = String(o.path ?? "").split("?")[0];
        seen.push({ method: String(o.method ?? "GET"), path, timeout: o.timeout });
        if (expire.has(path)) process.nextTick(() => req.emit("timeout"));
      }
    }
    return req;
  }) as typeof http.request;
  http.request = wrapped;
  syncBuiltinESMExports();
  return {
    seen,
    restore: () => {
      http.request = original;
      syncBuiltinESMExports();
    },
  };
}
