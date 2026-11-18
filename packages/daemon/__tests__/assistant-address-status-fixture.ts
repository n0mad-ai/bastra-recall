import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";

/** Status-only fixtures own their destination instead of probing system port 80. */
export async function unavailableAddressStatusPort(t: TestContext): Promise<number> {
  const server = createServer((_req, res) => {
    res.setHeader("Connection", "close");
    res.writeHead(503).end("fixture status unavailable");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}
