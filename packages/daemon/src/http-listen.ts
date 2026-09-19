/**
 * Server lifecycle for the HTTP surface: bind, the busy-port answer, and
 * shutdown. Separate from routing because it is the one part that decides
 * whether this process is the daemon at all — a bind failure is not an error
 * to log and continue from, it is the caller's signal to stop (#483).
 *
 * Split out of http.ts (file-size convention); behaviour unchanged.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { unbindAppliesToVault } from "./code-graph/applies-to.js";
import type { HttpHandle } from "./http.js";

/** Bind to 127.0.0.1:port and resolve the handle the daemon runs on. Never
 *  rejects: a taken port resolves with `addressInUse`, any other bind failure
 *  with a null port. */
export function listenHttp(server: Server, port: number): Promise<HttpHandle> {
  return new Promise<HttpHandle>((resolve) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `[bastra-recall] http: port ${port} already in use — if another bastra-recall daemon owns it, hooks will reach that one.`,
        );
        server.removeAllListeners("error");
        server.removeAllListeners("listening");
        resolve({
          port: null,
          close: async () => undefined,
          // #483: the caller decides — it must stop, not continue headless.
          addressInUse: true,
        });
        return;
      }
      console.error(`[bastra-recall] http: failed to bind: ${err.message}`);
      resolve({
        port: null,
        close: async () => undefined,
      });
    };

    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const addr = server.address() as AddressInfo;
      console.error(`[bastra-recall] http: listening on http://127.0.0.1:${addr.port}`);
      resolve({
        port: addr.port,
        close: () => closeServer(server),
      });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  // #578: let go of the vault listener with the server that took it, so a
  // restarted daemon does not leave an index bound to a dead vault.
  unbindAppliesToVault();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
