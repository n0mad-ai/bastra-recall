import { bastraDataDir } from "@bastra-recall/core/platform-paths";
import path from "node:path";
import { RolloutSource, readRecallFeed, readVaultSize } from "../codex/source";
import type { CodexStatus, RecallFeed } from "../codex/state";
import { PanelGitReader, type PanelGit } from "./git-status";
import type { NeuralData } from "./neural";
import { stageFields, type PanelText } from "./i18n";

export class CodexLiveSource {
  private source: RolloutSource;
  private git = new PanelGitReader();
  constructor(
    readonly session: string,
    file: string,
    readonly feedDirectory = path.join(bastraDataDir(), "statusline")
  ) {
    this.source = new RolloutSource(file, session);
  }
  async poll(now = Date.now()): Promise<NeuralData> {
    await this.source.poll();
    const s = this.source.projection.state;
    const [feed, vault, git] = await Promise.all([
      readRecallFeed(this.feedDirectory, this.session),
      readVaultSize(this.feedDirectory),
      this.git.read(s.cwd, now),
    ]);
    const known = !this.source.error && s.sessionId === this.session;
    return codexPanelData({ s, known, feed, vault, git, now });
  }
}

interface CodexSources {
  s: CodexStatus;
  /** The transcript was readable and belongs to the followed session. */
  known: boolean;
  feed: RecallFeed | null;
  vault: number | null;
  git: PanelGit | null;
  now: number;
}

type Measured = Pick<
  NeuralData,
  | "context"
  | "contextTotal"
  | "contextFree"
  | "usage"
  | "usageResetsAt"
  | "usage5h"
  | "usage5hResetsAt"
  | "loadedTitles"
  | "cachedInputRatio"
  | "searches"
  | "hits"
  | "loads"
  | "saves"
  | "errors"
  | "latency"
  | "clientLatency"
  | "tokens"
  | "durationMs"
>;

/** What only a known transcript may report; an unknown one shows nothing as measured. */
const UNMEASURED: Measured = {
  context: null,
  contextTotal: null,
  contextFree: null,
  usage: null,
  usageResetsAt: null,
  usage5h: null,
  usage5hResetsAt: null,
  loadedTitles: undefined,
  cachedInputRatio: null,
  searches: null,
  hits: null,
  loads: null,
  saves: null,
  errors: 0,
  latency: null,
  clientLatency: null,
  tokens: null,
  durationMs: null,
};

function quota(s: CodexStatus, minutes: number): { used: number | null; resetsAt: number | null } {
  const limit = s.limits.find((l) => l.minutes === minutes);
  return { used: limit?.used ?? null, resetsAt: limit?.resetsAt ?? null };
}

function cachedInputShare(s: CodexStatus): number | null {
  return s.inputTokens !== null &&
    s.inputTokens > 0 &&
    s.cachedInputTokens !== null &&
    s.cachedInputTokens <= s.inputTokens
    ? s.cachedInputTokens / s.inputTokens
    : null;
}

function measured(s: CodexStatus, now: number): Measured {
  const week = quota(s, 10080),
    block = quota(s, 300);
  const used = s.contextUsed,
    window = s.contextWindow;
  return {
    context: used !== null && window !== null && window > 0 ? Math.min(100, (used / window) * 100) : null,
    contextTotal: window,
    contextFree: window !== null && used !== null ? Math.max(0, window - used) : null,
    usage: week.used,
    usageResetsAt: week.resetsAt,
    usage5h: block.used,
    usage5hResetsAt: block.resetsAt,
    loadedTitles: [...s.loadedTitles],
    cachedInputRatio: cachedInputShare(s),
    searches: s.searches,
    hits: s.hits,
    loads: s.loads,
    saves: s.saves,
    errors: s.errors,
    latency: s.ms,
    clientLatency: s.ms,
    tokens: s.tokens,
    durationMs: s.startedAt !== null ? Math.max(0, now - s.startedAt) : null,
  };
}

/** A completed turn is idle even if its last tool/feed is still fresh. */
function activity({ s, known, feed, now }: CodexSources): { active: boolean; agentActive: boolean; recent: boolean } {
  if (!known || !s.active) return { active: false, agentActive: false, recent: false };
  const recent = s.lastAt !== null && now - s.lastAt >= 0 && now - s.lastAt < 5000;
  const active =
    Boolean(feed?.current_stage) &&
    feed!.ts >= (s.turnStartedAt ?? Infinity) &&
    now - feed!.ts >= 0 &&
    now - feed!.ts < 15000;
  return { active, agentActive: true, recent };
}

function stage({ s, known, feed }: CodexSources, { active, recent }: { active: boolean; recent: boolean }): PanelText {
  if (!known) return { key: "stage.codexUnavailable" };
  if (active) return { key: "stage.raw", vars: { text: feed!.current_message ?? feed!.current_stage! } };
  if (recent) return { key: s.errors ? "stage.recentError" : "stage.recent", vars: { tool: s.lastTool ?? "Recall" } };
  return s.active ? { key: "stage.codexActive" } : { key: "stage.ready" };
}

/** The forwarder's Recall time counts only for the same finished, error-free turn. */
function forwarderTotal({ s, known, feed }: CodexSources): number | null {
  const sameTurn =
    known &&
    feed !== null &&
    s.turnStartedAt !== null &&
    typeof feed.turn_id === "number" &&
    Math.abs(feed.turn_id - s.turnStartedAt) < 10000 &&
    feed.ts >= s.turnStartedAt &&
    s.calls > 0 &&
    s.errors === 0 &&
    feed.recall_count === s.calls &&
    !feed.current_stage;
  return sameTurn && typeof feed!.total_ms === "number" && Number.isFinite(feed!.total_ms) ? feed!.total_ms : null;
}

function codexPanelData(sources: CodexSources): NeuralData {
  const { s, known, vault, git, now } = sources;
  const m = known ? measured(s, now) : UNMEASURED;
  const act = activity(sources);
  const data: NeuralData = {
    mode: "live",
    client: "codex",
    fresh: known,
    project: path.basename(s.cwd) || "Codex",
    model: s.model ?? "Codex",
    effort: s.effort,
    context: m.context,
    contextTotal: m.contextTotal,
    contextFree: m.contextFree,
    usage: m.usage,
    usageResetsAt: m.usageResetsAt,
    usage5h: m.usage5h,
    usage5hResetsAt: m.usage5hResetsAt,
    loadedTitles: m.loadedTitles,
    apiDurationMs: null,
    costUsd: null,
    cacheHitRatio: null,
    cachedInputRatio: m.cachedInputRatio,
    vault: vault ?? s.vaultSize,
    searches: m.searches,
    hits: m.hits,
    loads: m.loads,
    saves: m.saves,
    errors: m.errors,
    latency: m.latency,
    clientLatency: m.clientLatency,
    timingSource: "client",
    now,
    git,
    tokens: m.tokens,
    durationMs: m.durationMs,
    ...act,
    ...stageFields(stage(sources, act)),
  };
  const forwarded = forwarderTotal(sources);
  if (forwarded !== null) {
    data.latency = forwarded;
    data.timingSource = "forwarder";
  }
  return data;
}
