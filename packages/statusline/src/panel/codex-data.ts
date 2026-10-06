import path from 'node:path';
import os from 'node:os';
import { RolloutSource, readRecallFeed, readVaultSize } from '../codex/source';
import { PanelGitReader } from './git-status';
import type { NeuralData } from './neural';

export class CodexLiveSource {
  private source: RolloutSource;
  private git = new PanelGitReader();
  constructor(readonly session: string, file: string, readonly feedDirectory = path.join(os.homedir(), '.bastra', 'statusline')) {
    this.source = new RolloutSource(file, session);
  }
  async poll(now = Date.now()): Promise<NeuralData> {
    await this.source.poll();
    const s = this.source.projection.state;
    const [feed, vault, git] = await Promise.all([readRecallFeed(this.feedDirectory, this.session), readVaultSize(this.feedDirectory), this.git.read(s.cwd, now)]);
    const week = s.limits.find(l => l.minutes === 10080), block = s.limits.find(l => l.minutes === 300);
    const known = !this.source.error && s.sessionId === this.session;
    const context = known && s.contextUsed !== null && s.contextWindow !== null && s.contextWindow > 0 ? Math.min(100, s.contextUsed / s.contextWindow * 100) : null;
    // A completed turn is idle even if its last tool/feed is still fresh.
    const recent = known && s.active && s.lastAt !== null && now - s.lastAt >= 0 && now - s.lastAt < 5000;
    const active = known && s.active && Boolean(feed?.current_stage) && feed!.ts >= (s.turnStartedAt ?? Infinity) && now - feed!.ts >= 0 && now - feed!.ts < 15000;
    const data: NeuralData = {
      mode: 'live', client: 'codex', fresh: known, project: path.basename(s.cwd) || 'Codex', model: s.model ?? 'Codex', effort: s.effort,
      context, contextTotal: known ? s.contextWindow : null,
      contextFree: known && s.contextWindow !== null && s.contextUsed !== null ? Math.max(0, s.contextWindow - s.contextUsed) : null,
      usage: known ? week?.used ?? null : null, usageResetsAt: known ? week?.resetsAt ?? null : null,
      usage5h: known ? block?.used ?? null : null, usage5hResetsAt: known ? block?.resetsAt ?? null : null,
      loadedTitles: known ? [...s.loadedTitles] : undefined,
      apiDurationMs: null, costUsd: null, cacheHitRatio: null,
      cachedInputRatio: known && s.inputTokens !== null && s.inputTokens > 0 && s.cachedInputTokens !== null && s.cachedInputTokens <= s.inputTokens ? s.cachedInputTokens / s.inputTokens : null,
      vault: vault ?? s.vaultSize, searches: known ? s.searches : null, hits: known ? s.hits : null, loads: known ? s.loads : null, saves: known ? s.saves : null,
      errors: known ? s.errors : 0, latency: known ? s.ms : null, clientLatency: known ? s.ms : null, timingSource: 'client',
      now, git, tokens: known ? s.tokens : null,
      durationMs: known && s.startedAt !== null ? Math.max(0, now - s.startedAt) : null,
      active, agentActive: known && s.active, recent,
      stage: !known ? 'Codex-Transcript nicht verfügbar' : active ? feed!.current_message ?? feed!.current_stage! :
        recent ? `Zuletzt: ${s.lastTool ?? 'Recall'}${s.errors ? ' · Fehler' : ''}` : s.active ? 'Codex aktiv · Recall bereit' : 'Recall bereit',
    };
    if (known && feed && s.turnStartedAt !== null && typeof feed.turn_id === 'number' &&
        Math.abs(feed.turn_id - s.turnStartedAt) < 10000 && feed.ts >= s.turnStartedAt &&
        s.calls > 0 && s.errors === 0 && feed.recall_count === s.calls && !feed.current_stage && typeof feed.total_ms === 'number' && Number.isFinite(feed.total_ms)) {
      data.latency = feed.total_ms; data.timingSource = 'forwarder';
    }
    return data;
  }
}
