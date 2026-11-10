import * as p from "@clack/prompts";
import { applyTaskChatConsent, inspectTaskChatSetup, type TaskChatSetupPaths } from "../task-chat-settings.js";

export const TASK_CHAT_CONSENT_QUESTION = "May Recall announce due tasks in your active Claude Code chat? Enabling crossSessionInbound=accept allows incoming session messages from all programs under your Mac account.";
/** Dedicated consent: --yes, install flags and an existing accept never imply yes. */
export async function askTaskChatConsent(paths: TaskChatSetupPaths = {}): Promise<boolean | undefined | symbol> {
  if (!process.stdin.isTTY) return undefined;
  if (!(await inspectTaskChatSetup(paths)).ask) return undefined;
  return p.confirm({ message: TASK_CHAT_CONSENT_QUESTION, initialValue: false });
}
export async function finishTaskChatConsent(answer: boolean, paths: TaskChatSetupPaths = {}): Promise<string> {
  const result = await applyTaskChatConsent(answer, paths);
  if (result.answer === "accepted") return "Claude chat delivery enabled for new sessions. Messages are task data, never execution approval; macOS notification and the board remain available.";
  if (result.answer === "blocked") return "Claude chat delivery stays off: existing hold/refuse, unknown inbound value or managed settings were preserved. macOS notification and the board remain available; this setup will not ask again.";
  return "Claude chat delivery declined and saved; this setup will not ask again. macOS notification and the board remain available.";
}
