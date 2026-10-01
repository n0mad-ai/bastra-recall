/**
 * The shared "today" disk cache is invalidated only by transcript mtime, so a
 * session left idle past midnight kept showing yesterday's entries under
 * today's date. The cache may be reused only when every entry is dated today.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TodayProvider } from "../../packages/statusline/src/segments/today.ts";
import { CacheManager } from "../../packages/statusline/src/utils/cache.ts";

const entry = (timestamp, costUSD) => ({
  timestamp,
  usage: {
    inputTokens: 10,
    outputTokens: 10,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  },
  costUSD,
  model: "m",
});

async function todayWithCache(cached) {
  const claudeDir = mkdtempSync(join(tmpdir(), "statusline-today-"));
  mkdirSync(join(claudeDir, "projects"));
  const saved = {
    env: process.env.CLAUDE_CONFIG_DIR,
    get: CacheManager.getUsageCache,
    set: CacheManager.setUsageCache,
    mtime: CacheManager.getLatestTranscriptMtime,
  };
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  CacheManager.getLatestTranscriptMtime = async () => 1;
  CacheManager.getUsageCache = async () => cached;
  CacheManager.setUsageCache = async () => {};
  try {
    return await new TodayProvider().getTodayInfo();
  } finally {
    CacheManager.getUsageCache = saved.get;
    CacheManager.setUsageCache = saved.set;
    CacheManager.getLatestTranscriptMtime = saved.mtime;
    if (saved.env === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved.env;
    rmSync(claudeDir, { recursive: true, force: true });
  }
}

test("a cache holding only yesterday's entries is not reused as today", async () => {
  const yesterday = new Date(Date.now() - 36 * 3600 * 1000);
  const info = await todayWithCache([entry(yesterday, 5)]);
  assert.equal(info.cost, null);
});

test("a cache holding today's entries is still reused", async () => {
  const info = await todayWithCache([entry(new Date(), 5)]);
  assert.equal(info.cost, 5);
});
