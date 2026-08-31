/**
 * HTTP client half of the session-start hook — every call the hook makes to
 * the local daemon (recall, floors, taxonomy, care/import counts, onboarding
 * flag, health probe) plus the request/response shapes. Split out of
 * session-hook.ts (file-size convention).
 *
 * Same discipline as the hook itself: hard per-call timeout, fail-silent on
 * every error path — an unreachable daemon must never break a session start.
 * The hook-CLI import rule (#305) applies here too: node stdlib and sibling
 * leafs only, never the @bastra-recall/core barrel.
 */
import { request } from "node:http";
import type { HookRecallResponse as RecallResponse } from "./hook-recall-response.js";
import type { PinnedFloorLean } from "./pinned-block.js";

// P0: der Transporttyp kannte den Score-Modus nicht — `score_kind`/`unfused`
// fielen beim Parsen still weg, und die SessionStart-Lane bandete danach rohe
// BM25-Werte mit Cuts, die nur auf der fusionierten Skala existieren. Jetzt
// derselbe Typ wie in allen anderen Lanes.
export type { HookRecallHit as RecallHit, HookRecallResponse as RecallResponse } from "./hook-recall-response.js";

export interface UpdateAvailable {
  current: string;
  latest: string;
  html_url: string;
  published_at: string;
}

export interface HealthResponse {
  ok: boolean;
  update_available: UpdateAvailable | null;
}

export interface ConventionLean {
  id: string;
  title: string;
  summary: string;
  updated: string;
}

interface TaxonomyResponse {
  conventions: ConventionLean[];
}

export interface RecallRequestBody {
  query: string;
  scope?: string;
  k: number;
  project: string | null;
  source: string | null;
}

/**
 * Die Antwort des projektbewussten Session-Assemblers (#265).
 *
 * Nur die Felder, die die Lane liest. `context` und `vault_size` ignoriert sie
 * bewusst — sie rendert ihr Dokument selbst, mit Banding und eigenen Mengen.
 */
export interface SessionContextResponse {
  data?: {
    recalls?: Array<{ scope: string; resp: RecallResponse | null }>;
    floors?: PinnedFloorLean[];
    conventions?: ConventionLean[];
    care?: { open: number; queued: number };
    imports?: { open: number; queued: number };
    onboarding?: boolean;
  };
}

/**
 * EIN Aufruf statt sechs (#265, §26.1).
 *
 * Die Lane holte Recalls, Floors, Taxonomie, Care, Import und Onboarding in
 * sechs einzelnen Loopback-Requests. Der Assembler erhebt dasselbe serverseitig
 * und nebenläufig; hier bleibt der Transport. Gleiche Disziplin wie
 * `postRecall`: harter Timeout, Fehler nach oben, der Aufrufer entscheidet.
 */
export function postSessionContext(
  baseUrl: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<SessionContextResponse> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL("/hook/session-context", baseUrl);
    } catch (err) {
      reject(err);
      return;
    }
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": payload.byteLength.toString(),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(raw) as SessionContextResponse);
          } catch {
            reject(new Error("invalid JSON response from daemon"));
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

export function postRecall(
  baseUrl: string,
  body: RecallRequestBody,
  timeoutMs: number,
): Promise<RecallResponse> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL("/hook/recall", baseUrl);
    } catch (err) {
      reject(err);
      return;
    }
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": payload.byteLength.toString(),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(raw) as RecallResponse);
          } catch {
            reject(new Error("invalid JSON response from daemon"));
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

export interface OpenCounts {
  open: number;
  /** Mining-queue depth (#211) — only /hook/import reports it, else 0. */
  queued: number;
}

/** Open-counts from a /hook/* endpoint (care, import) — same budget
 *  discipline as fetchTaxonomy. */
export function fetchOpenCounts(baseUrl: string, timeoutMs: number, path = "/hook/care"): Promise<OpenCounts> {
  return new Promise((resolve_) => {
    let url: URL;
    try {
      url = new URL(path, baseUrl);
    } catch {
      resolve_({ open: 0, queued: 0 });
      return;
    }
    const req = request(
      { method: "GET", hostname: url.hostname, port: url.port || 80, path: url.pathname, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { open?: unknown; queued?: unknown };
            resolve_({
              open: typeof parsed.open === "number" ? parsed.open : 0,
              queued: typeof parsed.queued === "number" ? parsed.queued : 0,
            });
          } catch {
            resolve_({ open: 0, queued: 0 });
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve_({ open: 0, queued: 0 }));
    req.end();
  });
}

/** GET /hook/onboarding → needed-flag. Same budget discipline; false on
 *  any error (an unreachable daemon must never nudge). */
export function fetchOnboardingNeeded(baseUrl: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve_) => {
    let url: URL;
    try {
      url = new URL("/hook/onboarding", baseUrl);
    } catch {
      resolve_(false);
      return;
    }
    const req = request(
      { method: "GET", hostname: url.hostname, port: url.port || 80, path: url.pathname, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { needed?: unknown };
            resolve_(parsed.needed === true);
          } catch {
            resolve_(false);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve_(false);
    });
    req.on("error", () => resolve_(false));
    req.end();
  });
}

export function fetchTaxonomy(baseUrl: string, timeoutMs: number): Promise<ConventionLean[]> {
  return new Promise((resolve_) => {
    let url: URL;
    try {
      url = new URL("/hook/taxonomy", baseUrl);
    } catch {
      resolve_([]);
      return;
    }
    const req = request(
      {
        method: "GET",
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as TaxonomyResponse;
            if ((res.statusCode ?? 500) === 200 && Array.isArray(data.conventions)) {
              resolve_(data.conventions);
              return;
            }
          } catch { /* fallthrough */ }
          resolve_([]);
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve_([]);
    });
    req.on("error", () => resolve_([]));
    req.end();
  });
}

interface FloorsResponse {
  floors: PinnedFloorLean[];
}

/**
 * Floor-Registry-Fetch (#141/#142). Gleiche Disziplin wie fetchTaxonomy:
 * fail-silent, ein GET, hartes Timeout — der Daemon joint id→title/summary
 * bereits serverseitig (/hook/floors), die Hook-CLI bleibt dumm. Mit Projekt
 * wird scope=<project> angefragt (Daemon liefert scoped + unscoped).
 */
export function fetchFloors(baseUrl: string, project: string | null, timeoutMs: number): Promise<PinnedFloorLean[]> {
  return new Promise((resolve_) => {
    let url: URL;
    try {
      url = new URL("/hook/floors", baseUrl);
      if (project) url.searchParams.set("scope", project);
    } catch {
      resolve_([]);
      return;
    }
    const req = request(
      {
        method: "GET",
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as FloorsResponse;
            if ((res.statusCode ?? 500) === 200 && Array.isArray(data.floors)) {
              resolve_(data.floors);
              return;
            }
          } catch { /* fallthrough */ }
          resolve_([]);
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve_([]);
    });
    req.on("error", () => resolve_([]));
    req.end();
  });
}

export function probeHealth(baseUrl: string, timeoutMs: number): Promise<HealthResponse | null> {
  return new Promise((resolve_) => {
    let url: URL;
    try {
      url = new URL("/health", baseUrl);
    } catch {
      resolve_(null);
      return;
    }
    const req = request(
      {
        method: "GET",
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HealthResponse;
            if ((res.statusCode ?? 500) === 200 && data && data.ok) {
              resolve_(data);
              return;
            }
          } catch { /* fallthrough */ }
          resolve_(null);
        });
      },
    );
    req.on("timeout", () => { req.destroy(); resolve_(null); });
    req.on("error", () => resolve_(null));
    req.end();
  });
}
