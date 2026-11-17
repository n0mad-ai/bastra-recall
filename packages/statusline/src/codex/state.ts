/** Read-only projection of Codex's rollout. Unknown records are ignored. */
export interface CodexStatus {
  sessionId: string | null;
  cwd: string;
  branch: string | null;
  model: string | null;
  effort: string | null;
  turnId: string | null;
  active: boolean;
  startedAt: number | null;
  turnStartedAt: number | null;
  contextUsed: number | null;
  contextWindow: number | null;
  tokens: number | null;
  limits: { minutes: number; used: number; resetsAt: number | null }[];
  calls: number;
  searches: number;
  loads: number;
  saves: number;
  hits: number;
  ms: number;
  errors: number;
  lastTool: string | null;
  lastAt: number | null;
  vaultSize: number | null;
  loadedTitles: string[];
  cachedInputTokens: number | null;
  inputTokens: number | null;
}

export function emptyStatus(): CodexStatus {
  return {
    sessionId: null,
    cwd: "",
    branch: null,
    model: null,
    effort: null,
    turnId: null,
    active: false,
    startedAt: null,
    turnStartedAt: null,
    contextUsed: null,
    contextWindow: null,
    tokens: null,
    limits: [],
    calls: 0,
    searches: 0,
    loads: 0,
    saves: 0,
    hits: 0,
    ms: 0,
    errors: 0,
    lastTool: null,
    lastAt: null,
    vaultSize: null,
    loadedTitles: [],
    cachedInputTokens: null,
    inputTokens: null,
  };
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}
function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toolResult(value: unknown): Record<string, any> {
  const result = object(value);
  if (result.structuredContent) return object(result.structuredContent);
  for (const block of Array.isArray(result.content) ? result.content : []) {
    if (block?.type === "text" && typeof block.text === "string") {
      try {
        return object(JSON.parse(block.text));
      } catch {
        /* non-JSON tool output */
      }
    }
  }
  return {};
}

function timestampOf(value: unknown): number | null {
  const parsed = Date.parse(value as string);
  return Number.isFinite(parsed) ? parsed : null;
}

const TURN_ENDS = new Set(["task_complete", "task_interrupted", "turn_completed"]);
const SEARCH_TOOLS = new Set(["recall", "find_document"]);
const LOAD_TOOLS = new Set(["load_memory", "read_document"]);
const SAVE_TOOLS = new Set(["save_memory", "save_document", "save_product_doc", "edit_memory"]);

/** Null/missing limits mean "no update", never 0%. */
function rateLimits(value: unknown): CodexStatus["limits"] | null {
  if (!value || typeof value !== "object") return null;
  const rate = object(value);
  const limits: CodexStatus["limits"] = [];
  for (const key of ["primary", "secondary"]) {
    const r = object(rate[key]);
    const minutes = finite(r.window_minutes),
      used = finite(r.used_percent);
    if (minutes !== null && minutes > 0 && used !== null) limits.push({ minutes, used, resetsAt: finite(r.resets_at) });
  }
  return limits;
}

function callFailed(item: Record<string, any>, result: Record<string, any>): boolean {
  return (
    item.status === "failed" ||
    item.status === "error" ||
    Boolean(item.error) ||
    object(item.result).isError === true ||
    Boolean(result.error) ||
    result.isError === true
  );
}

function callMs(item: Record<string, any>): number {
  const duration = object(item.duration);
  return finite(item.durationMs) ?? (finite(duration.secs) ?? 0) * 1000 + (finite(duration.nanos) ?? 0) / 1e6;
}

function isRecallCall(item: Record<string, any>): boolean {
  return (
    ["McpToolCall", "mcpToolCall"].includes(item.type) &&
    typeof item.server === "string" &&
    /^bastra[-_]recall$/.test(item.server)
  );
}

/** Holds only bounded metadata: never stores prompts, tool arguments or memory bodies. */
export class CodexProjection {
  state = emptyStatus();
  private completed = new Set<string>();

  accept(record: unknown): void {
    const row = object(record);
    const p = object(row.payload);
    if (row.type === "session_meta") this.sessionMeta(row, p);
    if (row.type === "turn_context") this.turnContext(p);
    if (row.type !== "event_msg") return;
    if (p.type === "task_started" || p.type === "turn_started") this.turnStarted(row, p);
    if (TURN_ENDS.has(p.type) && !this.otherTurn(p)) this.state.active = false;
    if (p.type === "token_count") this.tokenCount(p);
    if (p.type === "item_completed") this.itemCompleted(row, p);
  }

  /** A record that names a turn other than the current one. */
  private otherTurn(p: Record<string, any>): boolean {
    return Boolean(this.state.turnId) && typeof p.turn_id === "string" && p.turn_id !== this.state.turnId;
  }

  private sessionMeta(row: Record<string, any>, p: Record<string, any>): void {
    const s = this.state;
    s.sessionId = text(p.id) ?? text(p.session_id);
    s.cwd = text(p.cwd) ?? s.cwd;
    s.branch = text(object(p.git).branch);
    s.contextWindow = finite(p.context_window) ?? s.contextWindow;
    s.startedAt = timestampOf(p.timestamp ?? row.timestamp);
  }

  private turnContext(p: Record<string, any>): void {
    const s = this.state;
    s.model = text(p.model) ?? s.model;
    s.effort = text(p.effort) ?? s.effort;
    s.cwd = text(p.cwd) ?? s.cwd;
  }

  private turnStarted(row: Record<string, any>, p: Record<string, any>): void {
    const s = this.state;
    const id = text(p.turn_id);
    if (id !== s.turnId || id === null) {
      Object.assign(s, {
        turnId: id,
        calls: 0,
        searches: 0,
        loads: 0,
        saves: 0,
        hits: 0,
        ms: 0,
        errors: 0,
        lastTool: null,
        lastAt: null,
        loadedTitles: [],
      });
      this.completed.clear();
    }
    s.active = true;
    s.turnStartedAt = timestampOf(row.timestamp);
    s.contextWindow = finite(p.model_context_window) ?? s.contextWindow;
  }

  private tokenCount(p: Record<string, any>): void {
    const s = this.state;
    const info = object(p.info);
    const total = object(info.total_token_usage);
    s.tokens = finite(total.total_tokens) ?? s.tokens;
    s.cachedInputTokens = finite(total.cached_input_tokens) ?? s.cachedInputTokens;
    s.inputTokens = finite(total.input_tokens) ?? s.inputTokens;
    s.contextUsed = finite(object(info.last_token_usage).total_tokens) ?? s.contextUsed;
    s.contextWindow = finite(info.model_context_window) ?? s.contextWindow;
    s.limits = rateLimits(p.rate_limits) ?? s.limits;
  }

  private itemCompleted(row: Record<string, any>, p: Record<string, any>): void {
    if (this.otherTurn(p)) return;
    const item = object(p.item);
    // The final answer is already visible when the terminal lifecycle event is
    // delayed or absent. Commentary must keep the current turn active.
    if (["AgentMessage", "agentMessage"].includes(item.type) && item.phase === "final_answer") {
      this.state.active = false;
      return;
    }
    if (!isRecallCall(item)) return;
    const id = text(item.id);
    if (!id || this.completed.has(id)) return;
    // Bound the dedup table even if a malformed transcript never changes turn.
    if (this.completed.size >= 4096) this.completed.delete(this.completed.values().next().value!);
    this.completed.add(id);
    this.recallCall(row, item);
  }

  private recallCall(row: Record<string, any>, item: Record<string, any>): void {
    const s = this.state;
    const tool = text(item.tool) ?? "tool";
    const result = toolResult(item.result);
    s.calls++;
    if (callFailed(item, result)) s.errors++;
    else this.recallResult(tool, result);
    s.ms += callMs(item);
    s.lastTool = tool;
    s.lastAt = timestampOf(row.timestamp);
    s.vaultSize = finite(result.vault_size) ?? s.vaultSize;
  }

  private recallResult(tool: string, result: Record<string, any>): void {
    const s = this.state;
    if (SEARCH_TOOLS.has(tool)) {
      s.searches++;
      s.hits += Array.isArray(result.hits) ? result.hits.length : 0;
    }
    if (LOAD_TOOLS.has(tool)) {
      s.loads++;
      const title = text(object(result.frontmatter).title) ?? text(result.title) ?? text(result.id);
      if (title && !s.loadedTitles.includes(title)) s.loadedTitles.push(title);
      if (s.loadedTitles.length > 32) s.loadedTitles.shift();
    }
    if (SAVE_TOOLS.has(tool)) s.saves++;
  }
}

/** Existing forwarder feed, matched by identity rather than nearest/newest file. */
export interface RecallFeed {
  ts: number;
  turn_id?: number;
  cc_session_id?: string;
  current_stage?: string | null;
  current_message?: string | null;
  current_recall_started_at?: number | null;
  last_phrase?: string | null;
  last_phrase_at?: number | null;
  recall_count?: number;
  total_hits?: number;
  total_ms?: number;
}
