/**
 * calculateCostForEntry priced every cache_creation_input_tokens at the 5m
 * rate and never read cache_write_1h, so sessions on the 1-hour cache were
 * undercounted. The transcript carries the split in
 * usage.cache_creation.ephemeral_1h_input_tokens.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PricingService } from "../../packages/statusline/src/segments/pricing.ts";

PricingService.modelPricingCache.set("test-model-1h", {
  name: "test",
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write_5m: 1,
  cache_write_1h: 2,
});

const cost = (usage) =>
  PricingService.calculateCostForEntry({
    message: { model: "test-model-1h", usage },
  });

test("1h cache-write tokens bill at the 1h rate", async () => {
  const c = await cost({
    cache_creation_input_tokens: 1_000_000,
    cache_creation: { ephemeral_1h_input_tokens: 1_000_000 },
  });
  assert.equal(c, 2);
});

test("a mixed write splits between the 1h and 5m rates", async () => {
  const c = await cost({
    cache_creation_input_tokens: 1_000_000,
    cache_creation: {
      ephemeral_1h_input_tokens: 400_000,
      ephemeral_5m_input_tokens: 600_000,
    },
  });
  assert.equal(c, 0.4 * 2 + 0.6 * 1);
});

test("without the split everything bills at the 5m rate", async () => {
  const c = await cost({ cache_creation_input_tokens: 1_000_000 });
  assert.equal(c, 1);
});
