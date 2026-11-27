/**
 * The hook lanes of the loopback surface: POST /hook/prompt, /hook/write,
 * /hook/bash-pre and /hook/bash-fail answer here, and the lanes of
 * http-lane-routes.ts (/hook/stop, /hook/session, /hook/todo, /hook/gate) are
 * wired here with the vault-backed extras they take. Moved out of
 * `dispatchLocalRoutes` (#1529) unchanged; the route table in
 * http-local-routes.ts decides which request reaches which lane.
 *
 * #343 contract: the thin client POSTs `{payload}` and writes the response
 * body to stdout verbatim, so every lane returns the exact document the
 * client expects — `{}` or the hookSpecificOutput envelope — and fails open
 * to `{}` with 200: the client must never see an error it would only
 * translate back into `{}` anyway. Loopback-only like /hook/recall; the logic
 * lives in the *-lane.ts modules, these stay routes.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Vault } from "@bastra-recall/core";
import { createLaneDelivery } from "./lane-delivery.js";
import { taskAttachment, taskRequestAuth } from "./task-delivery.js";
import { defaultTaskContext } from "./task-transport.js";
import { reportNotesNotice } from "./task-report-notice.js";
import { reflexPoolIds } from "./reflex.js";
import { runPromptLane, type ClaudeHookPayload } from "./prompt-lane.js";
import { vaultConventionOf } from "./convention-source.js";
import type { PromptHookTelemetry } from "./prompt-lane-telemetry.js";
import { REPLAY_CLIENT } from "./hook-surface.js";
import { runWriteLane, type WriteHookPayload } from "./write-lane.js";
import { runBashPreLane, type BashHookPayload } from "./bash-pre-lane.js";
import { runBashFailLane, type BashFailPayload } from "./bash-fail-lane.js";
import { recallWriteTool, runSaveNoticeLane, type SaveNoticePayload } from "./save-notice-lane.js";
import { dispatchLaneRoutes } from "./http-lane-routes.js";
import { cachedActionReflexPool } from "./gate-lane.js";
import { collectRuleKernel } from "./rule-kernel.js";
import type { ToolDeps } from "./tool-handlers.js";
import { MAX_BODY_BYTES, readJsonBody } from "./http-util.js";
import { appendDraftNotice } from "./draft-notice.js";

/** What the lanes take from the loopback route context. */
export interface HookLaneCtx {
  vault: Vault;
  toolDeps: ToolDeps;
}

/** POST /hook/prompt (#343, stage A of #305 direction 2): the full UserPromptSubmit pipeline. */
export function handleHookPrompt(req: IncomingMessage, res: ServerResponse, ctx: HookLaneCtx): void {
  const { vault, toolDeps } = ctx;
  const delivery = createLaneDelivery(res);
  readJsonBody(req, MAX_BODY_BYTES)
    .then((body) =>
      delivery.run(async () => {
        const payload = (body.payload ?? {}) as ClaudeHookPayload;
        const ppid = typeof body.client_ppid === "number" ? body.client_ppid : null;
        const self = `http://127.0.0.1:${req.socket.localPort ?? 6723}`;
        // #702: `bastra doctor --replay` posts `{payload, replay: true}`. The
        // lane runs in shadow (prompt-lane.ts: `replay`) and the answer is
        // `{stdout, telemetry}` — what the hook would have printed, plus the
        // row the lane wrote to the replay log — instead of the bare hook
        // document. No task attachment: nothing is due in a replayed turn.
        if (body.replay === true) {
          let row: PromptHookTelemetry | null = null;
          const stdout = await runPromptLane(
            { ...payload, bastra_client: REPLAY_CLIENT } as ClaudeHookPayload,
            null,
            self,
            toolDeps.prewarmEmbedding,
            () => reflexPoolIds(vault),
            {
              onTelemetry: (r) => {
                row = r;
              },
              conventionOf: vaultConventionOf(vault),
            }
          );
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ stdout, telemetry: row }));
          return;
        }
        // #361: the prewarmer rides in from toolDeps — the lane fires it at
        // turn start and never awaits the embed behind it.
        // #371: the wired reflex pool rides in from the vault index. Mode
        // "none" — 91% of prompts — can inject nothing else, so the lane
        // uses it to decide whether the full-vault recall is worth paying
        // for at all.
        // #1306: revisions for the active-conventions block, off the same index.
        const out = await runPromptLane(payload, ppid, self, toolDeps.prewarmEmbedding, () => reflexPoolIds(vault), {
          conventionOf: vaultConventionOf(vault),
          kernel: (active, project, mode) => collectRuleKernel(vault, { active, project, mode }),
        });
        const due = await taskAttachment(
          defaultTaskContext(toolDeps),
          taskRequestAuth(req),
          String(payload.session_id ?? "unknown"),
          "prompt"
        );
        let result = out;
        if (due) {
          const parsed = JSON.parse(result) as {
            hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
          };
          parsed.hookSpecificOutput = {
            ...parsed.hookSpecificOutput,
            hookEventName: "UserPromptSubmit",
            additionalContext: [parsed.hookSpecificOutput?.additionalContext, due.text].filter(Boolean).join("\n"),
          };
          result = JSON.stringify(parsed);
          res.once("finish", due.record);
        }
        delivery.answer(result);
      })
    )
    .catch(() => {
      delivery.answer("{}");
    });
}

/**
 * POST /hook/write (#343 second half): the PreToolUse Write/Edit lane. The
 * skip gate stays in the thin client (pure stdlib, fires on the majority of
 * calls), so everything arriving here already survived it. No client_ppid —
 * this lane touches no statusline feed.
 */
export function handleHookWrite(req: IncomingMessage, res: ServerResponse, ctx: HookLaneCtx): void {
  readJsonBody(req, MAX_BODY_BYTES)
    .then(async (body) => {
      const payload = (body.payload ?? {}) as WriteHookPayload;
      const self = `http://127.0.0.1:${req.socket.localPort ?? 6723}`;
      const out = await runWriteLane(payload, self, ctx.toolDeps.vaultPath);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(out);
    })
    .catch(() => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end("{}");
    });
}

/**
 * POST /hook/bash-pre (#343 pattern). No client-side content gates — the
 * pattern tables and invokesOwnBinary are gate logic that must stay
 * hot-swappable, so they live in the lane.
 */
export function handleHookBashPre(req: IncomingMessage, res: ServerResponse): void {
  const delivery = createLaneDelivery(res);
  void delivery.run(async () => {
    try {
      const body = await readJsonBody(req, MAX_BODY_BYTES);
      const out = await runBashPreLane(
        (body.payload ?? {}) as BashHookPayload,
        `http://127.0.0.1:${req.socket.localPort ?? 6723}`
      );
      delivery.answer(out);
    } catch {
      delivery.answer("{}");
    }
  });
}

/** POST /hook/bash-fail: the PostToolUse lane, which also answers Recall's own write tools. */
export function handleHookBashFail(req: IncomingMessage, res: ServerResponse, ctx: HookLaneCtx): void {
  const { vault } = ctx;
  // A PostToolUse envelope carries a full tool input plus its result.
  // Give the acknowledgement bounded headroom without changing the API cap.
  readJsonBody(req, 2 * MAX_BODY_BYTES)
    .then(async (body) => {
      const payload = (body.payload ?? {}) as BashFailPayload;
      // The post-tool client carries one more registration: Recall's own
      // write tools, answered with the line that says what was saved
      // (save-notice-lane.ts says why it has no client of its own).
      const out = recallWriteTool(payload.tool_name)
        ? await runSaveNoticeLane(payload as SaveNoticePayload, (id) => {
            const fm = vault.get(id)?.fm;
            return fm?.sensitivity === "private" ? undefined : fm;
          })
        : await runBashFailLane(payload, `http://127.0.0.1:${req.socket.localPort ?? 6723}`);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        await appendDraftNotice(
          out,
          payload as SaveNoticePayload,
          (id) => vault.get(id)?.fm,
          undefined,
          () => !res.destroyed && !req.socket.destroyed
        )
      );
    })
    .catch(() => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end("{}");
    });
}

/**
 * #369: /hook/stop, /hook/session, /hook/todo and /hook/gate, whose routes live
 * in http-lane-routes.ts — the contract is identical to the four above.
 * #490: the session lane among them takes the shared embedding warm-up,
 * injected here the same way the prompt lane takes its prewarmer. Returns true
 * when one of them took the request.
 */
export function dispatchHookLanes(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: string,
  ctx: HookLaneCtx
): boolean {
  const { vault, toolDeps } = ctx;
  return dispatchLaneRoutes(
    req,
    res,
    method,
    url,
    toolDeps.warmupEmbedding,
    async (out, payload, connected) => {
      const notices = await appendDraftNotice(out, payload, (id) => vault.get(id)?.fm, undefined, connected);
      if (url !== "/hook/session") return notices;
      const taskCtx = defaultTaskContext(toolDeps);
      const due = await taskAttachment(
        taskCtx,
        taskRequestAuth(req),
        String((payload as unknown as { session_id?: string }).session_id ?? "unknown"),
        "session",
        toolDeps.primaryLanguage
      );
      // Notes the owner left on task reports: the vault-care way, same credential as the due cards.
      const reportNotes = await reportNotesNotice(taskCtx, taskRequestAuth(req));
      if ((!due && !reportNotes) || !connected()) return notices;
      const parsed = JSON.parse(notices) as {
        hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
      };
      parsed.hookSpecificOutput = {
        ...parsed.hookSpecificOutput,
        hookEventName: "SessionStart",
        additionalContext: [parsed.hookSpecificOutput?.additionalContext, due?.text, reportNotes]
          .filter(Boolean)
          .join("\n"),
      };
      if (due) res.once("finish", due.record);
      return JSON.stringify(parsed);
    },
    () => cachedActionReflexPool(vault),
    (active, project, mode) => collectRuleKernel(vault, { project, active, mode }),
    vaultConventionOf(vault)
  );
}
