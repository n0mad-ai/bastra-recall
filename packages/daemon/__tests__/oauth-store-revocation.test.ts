import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readAppRecord } from "../src/app-record-store.js";
import { createGrant, getClient, registerClient, revokeClient, verifyAccessToken } from "../src/oauth-store.js";

test("#1619: a pending sign-in cannot issue tokens after its client is revoked", async (t) => {
  const now = Date.parse("2026-11-18T08:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  const dir = await mkdtemp(join(tmpdir(), "bastra-oauth-revocation-"));
  const path = join(dir, "oauth.json");
  const resource = "https://recall.example.invalid/api/v1/mcp";
  const metadata = { client_name: "Pending connector", redirect_uris: ["https://client.example.invalid/callback"] };
  try {
    const pending = await registerClient(metadata, path);
    const active = await registerClient({ ...metadata, client_name: "Active connector" }, path);
    assert.ok(pending && active);
    const existing = await createGrant({ client_id: active.client_id, resource, scope: "mcp" }, path);
    assert.ok(existing);

    // oauth-server.ts retains pending/code client IDs in memory and passes
    // the spent code's ID to createGrant, even after the registration TTL.
    const inUse = new Set([pending.client_id]);
    assert.ok(await getClient(pending.client_id, path), "the sign-in began with a registered client");
    assert.equal(await revokeClient(pending.client_id, path), 1);
    t.mock.timers.setTime(now + 11 * 60_000);
    const afterRevoke = readAppRecord("oauth", path);
    const denied = await createGrant({ client_id: pending.client_id, resource, scope: "mcp" }, path, inUse);
    assert.equal(denied, null, "a stale in-use ID cannot resurrect a revoked registration or issue tokens");
    assert.equal(await getClient(pending.client_id, path), null);
    assert.equal(
      readAppRecord("oauth", path),
      afterRevoke,
      "the rejected final step persists no grant or token hashes"
    );

    const stored = JSON.parse(afterRevoke) as {
      clients: { client_id: string }[];
      grants: { id: string; client_id: string }[];
    };
    assert.deepEqual(
      stored.clients.map((client) => client.client_id),
      [active.client_id]
    );
    assert.deepEqual(
      stored.grants.map((grant) => grant.id),
      [existing.grantId]
    );
    assert.equal(await verifyAccessToken(existing.tokens.access_token, resource, path), true);
    const allowed = await createGrant({ client_id: active.client_id, resource, scope: "mcp" }, path, inUse);
    assert.ok(allowed, "another registered client can still finish sign-in");
    assert.equal(await verifyAccessToken(allowed.tokens.access_token, resource, path), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
