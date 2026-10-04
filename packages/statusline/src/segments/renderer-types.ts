// Segment configuration and output contract of SegmentRenderer (#1039).
// Re-exported unchanged from ./renderer, which is the import path every caller
// (config loader, powerline, browser bundle) keeps using.

export interface SegmentConfig {
  enabled: boolean;
  showIcon?: boolean;
}

export interface DirectorySegmentConfig extends SegmentConfig {
  showBasename?: boolean;
  style?: "full" | "fish" | "basename";
}

export interface GitSegmentConfig extends SegmentConfig {
  showSha?: boolean;
  showAheadBehind?: boolean;
  showWorkingTree?: boolean;
  showOperation?: boolean;
  showTag?: boolean;
  showTimeSinceCommit?: boolean;
  showStashCount?: boolean;
  showUpstream?: boolean;
  showRepoName?: boolean;
}

export interface UsageSegmentConfig extends SegmentConfig {
  type: "cost" | "tokens" | "both" | "breakdown";
  costSource?: "calculated" | "official";
  /** Show the trailing "tokens" unit on token counts. Only affects `type: "tokens"` and `type: "both"` (default: true). Inert in the `tui` display style, which never renders the suffix. */
  showUnits?: boolean;
}

export interface TmuxSegmentConfig extends SegmentConfig {}

export type BarDisplayStyle =
  | "text"
  | "ball"
  | "bar"
  | "blocks"
  | "blocks-line"
  | "capped"
  | "dots"
  | "filled"
  | "geometric"
  | "line"
  | "squares";

export interface ContextSegmentConfig extends SegmentConfig {
  showPercentageOnly?: boolean;
  displayStyle?: BarDisplayStyle;
  autocompactBuffer?: number;
  percentageMode?: "remaining" | "used";
}

export interface MetricsSegmentConfig extends SegmentConfig {
  showResponseTime?: boolean;
  showLastResponseTime?: boolean;
  showDuration?: boolean;
  showMessageCount?: boolean;
  showLinesAdded?: boolean;
  showLinesRemoved?: boolean;
}

export interface BlockSegmentConfig extends SegmentConfig {
  type: "cost" | "tokens" | "both" | "time" | "weighted";
  burnType?: "cost" | "tokens" | "both" | "none";
  displayStyle?: BarDisplayStyle;
}

export interface TodaySegmentConfig extends SegmentConfig {
  type: "cost" | "tokens" | "both" | "breakdown";
  /** Show the trailing "tokens" unit on token counts. Only affects `type: "tokens"` and `type: "both"` (default: true). Inert in the `tui` display style, which never renders the suffix. */
  showUnits?: boolean;
}

export interface VersionSegmentConfig extends SegmentConfig {}

export interface SessionIdSegmentConfig extends SegmentConfig {
  showIdLabel?: boolean;
}

export interface EnvSegmentConfig extends SegmentConfig {
  variable: string;
  prefix?: string;
}

export interface WeeklySegmentConfig extends SegmentConfig {
  displayStyle?: BarDisplayStyle;
}

export interface AgentSegmentConfig extends SegmentConfig {
  showLabel?: boolean;
}

export interface ThinkingSegmentConfig extends SegmentConfig {
  showEnabled?: boolean;
  showEffort?: boolean;
}

export interface CacheTimerSegmentConfig extends SegmentConfig {
  displayMode?: "elapsed" | "remaining";
  ttlSeconds?: number;
}

export interface BastraSegmentConfig extends SegmentConfig {}

export type AnySegmentConfig =
  | SegmentConfig
  | DirectorySegmentConfig
  | GitSegmentConfig
  | UsageSegmentConfig
  | TmuxSegmentConfig
  | ContextSegmentConfig
  | MetricsSegmentConfig
  | BlockSegmentConfig
  | TodaySegmentConfig
  | VersionSegmentConfig
  | SessionIdSegmentConfig
  | EnvSegmentConfig
  | WeeklySegmentConfig
  | AgentSegmentConfig
  | ThinkingSegmentConfig
  | CacheTimerSegmentConfig
  | BastraSegmentConfig;

export interface PowerlineSymbols {
  right: string;
  left: string;
  branch: string;
  model: string;
  git_clean: string;
  git_dirty: string;
  git_conflicts: string;
  git_ahead: string;
  git_behind: string;
  git_worktree: string;
  git_tag: string;
  git_sha: string;
  git_upstream: string;
  git_stash: string;
  git_time: string;
  session_cost: string;
  block_cost: string;
  today_cost: string;
  context_time: string;
  metrics_response: string;
  metrics_last_response: string;
  metrics_duration: string;
  metrics_messages: string;
  metrics_lines_added: string;
  metrics_lines_removed: string;
  metrics_burn: string;
  version: string;
  bar_filled: string;
  bar_empty: string;
  env: string;
  session_id: string;
  weekly_cost: string;
  agent: string;
  thinking: string;
  cache_timer: string;
  bastra: string;
}

export interface SegmentData {
  text: string;
  bgColor: string;
  fgColor: string;
  bold?: boolean;
}
