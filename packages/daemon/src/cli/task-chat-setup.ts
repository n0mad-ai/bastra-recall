import * as p from "@clack/prompts";
import { applyTaskChatConsent, inspectTaskChatSetup, type TaskChatSetupPaths } from "../task-chat-settings.js";
import { taskCliLanguage, taskCliWords } from "./task-cli-words.js";

/** Dedicated consent: --yes, install flags and an existing accept never imply yes.
 *  Worded in `language` (#1602; the wizard passes the one just chosen), else
 *  language.primary. `wanted` false (Claude Code not chosen): not asked. */
export async function askTaskChatConsent(
  paths: TaskChatSetupPaths = {},
  language?: string,
  wanted = true
): Promise<boolean | undefined | symbol> {
  if (!wanted || !process.stdin.isTTY) return undefined;
  if (!(await inspectTaskChatSetup(paths)).ask) return undefined;
  const words = taskCliWords(language ?? (await taskCliLanguage()));
  return p.confirm({ message: words.chatConsentQuestion, initialValue: false });
}
export async function finishTaskChatConsent(
  answer: boolean,
  paths: TaskChatSetupPaths = {},
  language?: string
): Promise<string> {
  const result = await applyTaskChatConsent(answer, paths);
  return taskCliWords(language ?? (await taskCliLanguage())).chatConsentResult[result.answer];
}
