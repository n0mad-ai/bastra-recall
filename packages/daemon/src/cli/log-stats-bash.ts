import { foldClientDuplicates, isClientRow, tsOf } from "./log-stats-phases.js";

type Row = Record<string, unknown>;
type BashLane = "bash-pre" | "bash-post";

interface Delivery {
  completed: number;
  failures: number;
  covered: boolean;
}

export interface BashDelivery {
  lanes: Record<BashLane, Delivery>;
  byClient: Map<string, Record<BashLane, Delivery>>;
}

const MODES = ["bash-pre", "bash-post"] as const;

export function isNonBashDetail(row: Row): boolean {
  return row.tool_name === "other" && detailLane(row) !== undefined;
}

function detailLane(row: Row): BashLane | undefined {
  if (row.kind === "bash_hook_call") return "bash-pre";
  if (row.kind === "bash_fail_hook_call") return "bash-post";
  return undefined;
}

function clientOf(row: Row): string | undefined {
  const client = (row.dimensions as { client?: unknown } | undefined)?.client;
  return client === "codex" || client === "claude-code" ? client : undefined;
}

function sessionOf(row: Row): string {
  return typeof row.session_id === "string" ? row.session_id : "";
}

function isBashAct(row: Row): boolean {
  return (
    row.kind === "hook_act" &&
    row.tool_name === "Bash" &&
    (row.dimensions as { hook_source?: unknown } | undefined)?.hook_source === "bash-fail"
  );
}

function isFailure(row: Row): boolean {
  return ["timeout", "error", "daemon-unreachable"].includes(String(row.status));
}

function summarizeLane(rows: Row[], completed: number, covered: boolean): Delivery {
  const failures = foldClientDuplicates(rows).events.filter(isFailure).length;
  const daemonDetails = rows.filter((row) => !isClientRow(row)).length;
  return { completed, failures, covered: covered && completed > 0 && completed >= Math.max(failures, daemonDetails) };
}

interface ClientCoverage {
  completed: number;
  rows: Record<BashLane, Row[]>;
  missing: Set<BashLane>;
}

function clientCoverage(clients: Map<string, ClientCoverage>, client: string): ClientCoverage {
  const existing = clients.get(client);
  if (existing) return existing;
  const coverage = { completed: 0, rows: { "bash-pre": [], "bash-post": [] }, missing: new Set<BashLane>() };
  clients.set(client, coverage);
  return coverage;
}

function recordDetail(
  row: Row,
  clients: Map<string, ClientCoverage>,
  completedSessions: Map<string, Set<string>>
): void {
  const mode = detailLane(row);
  if (!mode || isNonBashDetail(row)) return;
  const completedBy = completedSessions.get(sessionOf(row));
  // Older clients omitted the dimension. Only use session evidence when
  // every observed completion in that session names the very same client.
  const inferred = completedBy?.size === 1 ? completedBy.values().next().value : undefined;
  const client = clientOf(row) ?? inferred ?? "unknown";
  const group = clientCoverage(clients, client);
  group.rows[mode].push(row);
  if (!isClientRow(row) || !isFailure(row)) return;

  // Post carries save notices too, and old failure rows lacked the tool.
  // An unreachable daemon could not write an Act for this invocation.
  const ambiguousPost = mode === "bash-post" && row.tool_name !== "Bash";
  if (ambiguousPost || !completedBy?.has(client) || row.status === "daemon-unreachable") {
    group.missing.add(mode);
  }
}

export function summarizeBashDelivery(rawEvents: Row[], inRestart: (ts: number) => boolean): BashDelivery {
  const active = rawEvents.filter((row) => (isBashAct(row) || detailLane(row)) && !inRestart(tsOf(row)));
  const clients = new Map<string, ClientCoverage>();
  const completedSessions = new Map<string, Set<string>>();
  for (const row of active.filter(isBashAct)) {
    const client = clientOf(row) ?? "unknown";
    clientCoverage(clients, client).completed++;
    const session = sessionOf(row);
    if (session) {
      if (!completedSessions.has(session)) completedSessions.set(session, new Set());
      completedSessions.get(session)!.add(client);
    }
  }
  for (const row of active) recordDetail(row, clients, completedSessions);

  const byClient: BashDelivery["byClient"] = new Map();
  for (const [client, { completed, rows, missing }] of clients) {
    byClient.set(client, {
      "bash-pre": summarizeLane(
        rows["bash-pre"],
        completed,
        client !== "unknown" && !missing.has("bash-pre") && rows["bash-pre"].length > 0
      ),
      "bash-post": summarizeLane(rows["bash-post"], completed, client !== "unknown" && !missing.has("bash-post")),
    });
  }

  const totals = (mode: BashLane): Delivery => {
    const rows = [...byClient.values()].map((client) => client[mode]);
    return {
      completed: rows.reduce((n, row) => n + row.completed, 0),
      failures: rows.reduce((n, row) => n + row.failures, 0),
      covered: rows.length > 0 && rows.every((row) => row.covered),
    };
  };
  return { byClient, lanes: { "bash-pre": totals("bash-pre"), "bash-post": totals("bash-post") } };
}

function unattributedFailures(delivery: BashDelivery, mode: BashLane): boolean {
  return (delivery.byClient.get("unknown")?.[mode].failures ?? 0) > 0;
}

export function renderBashDelivery(delivery: BashDelivery): string[] {
  if (delivery.byClient.size === 0) return [];
  const rows = [
    "  Bash delivery (#1739) — attributed failed hooks per observed completed Bash command (hook_act)",
    "    diagnostic only: a completion and a failed hook need not describe the same invocation",
  ];
  for (const mode of MODES) {
    for (const [client, lanes] of delivery.byClient) {
      const { completed, failures, covered } = lanes[mode];
      const rate =
        covered && !unattributedFailures(delivery, mode)
          ? `${failures}/${completed} (${((failures / completed) * 100).toFixed(2)}%)`
          : "NOT EVALUABLE (insufficient coverage)";
      rows.push(`    ${mode.padEnd(11)} ${client}: ${rate}`);
    }
  }
  return rows;
}
