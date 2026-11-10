/** Optional local OS surface. A durable claim provides at-most-once submission
 * across daemon restarts; an OS submission is never a human read receipt. */
import { execFile } from "node:child_process";
import { isTaskExpiryNotice } from "./task-validity.js";
import { promisify } from "node:util";
import { readSettings } from "./settings-file.js";
import { readTaskStore, transactTaskStore } from "./task-store.js";
import type { Task, TaskStore } from "./task-schema.js";
import type { TaskServiceContext } from "./task-service.js";
const execFileAsync = promisify(execFile);
export interface TaskNotificationMessage { title: string; body: string; }
export interface TaskNotificationOptions {
  platform?: NodeJS.Platform;
  enabled?: boolean;
  send?: (message: TaskNotificationMessage) => Promise<void>;
}
export async function taskNotificationStatus(platform: NodeJS.Platform = process.platform) {
  const supported = platform === "darwin";
  const enabled = supported && ((await readSettings()).tasks?.notifications ?? true);
  return { supported, enabled, channel: "macos" as const, receipt: "os-submission-not-human-read" as const };
}
async function sendMacNotification(message: TaskNotificationMessage): Promise<void> {
  // Script is constant, user-controlled task content is passed only as argv.
  await execFileAsync("/usr/bin/osascript", ["-e", "on run argv\ndisplay notification (item 1 of argv) with title (item 2 of argv)\nend run", message.body, message.title], { timeout: 5000, maxBuffer: 4096 });
}
function eligible(store: TaskStore, task: Task | undefined, occurrence: TaskStore["occurrences"][number], now: number): task is Task {
  if (!store.controls.enabled || store.controls.muted || !task || task.notification_policy.muted
    || (!isTaskExpiryNotice(task, occurrence) && (!task.armed || task.paused || task.state !== "due"))
    || task.generation !== occurrence.generation || occurrence.acknowledgement || occurrence.resolution) return false;
  // The owner explicitly keeps the OS notification in addition to chat.
  // Its independent durable claim prevents duplicate OS submissions.
  const receipt = occurrence.notification;
  return !receipt || (receipt.failed_at !== undefined && now - receipt.failed_at >= task.notification_policy.retry_interval_ms);
}
export async function notifyDueTasks(ctx: TaskServiceContext, options: TaskNotificationOptions = {}): Promise<void> {
  if ((options.platform ?? process.platform) !== "darwin") return;
  // Production default never emits real desktop notifications from test children.
  if (!options.send && process.env.NODE_TEST_CONTEXT) return;
  const enabled = options.enabled ?? (await readSettings()).tasks?.notifications ?? true;
  if (!enabled) return;
  const now = (ctx.now ?? Date.now)();
  const snapshot = await readTaskStore(ctx.path);
  const candidates = snapshot.occurrences.filter(o => eligible(snapshot, snapshot.tasks.find(t => t.id === o.task_id), o, now)).slice(0, 10);
  for (const candidate of candidates) {
    let message: TaskNotificationMessage | undefined;
    await transactTaskStore(ctx.path, undefined, store => {
      const occurrence = store.occurrences.find(o => o.id === candidate.id);
      const task = occurrence && store.tasks.find(t => t.id === occurrence.task_id);
      if (!occurrence || !eligible(store, task, occurrence, now)) return;
      occurrence.notification = { claimed_at: now };
      message = { title: "Bastra Recall", body: `${isTaskExpiryNotice(task, occurrence) ? "Abgelaufen: " : ""}${task.goal.slice(0, 200)}` };
    }, "control");
    if (!message) continue;
    let failure: unknown;
    try { await (options.send ?? sendMacNotification)(message); }
    catch (error) { failure = error; }
    await transactTaskStore(ctx.path, undefined, store => {
      const occurrence = store.occurrences.find(o => o.id === candidate.id);
      if (!occurrence?.notification || occurrence.notification.claimed_at !== now) return;
      if (!failure) occurrence.notification.submitted_at = now;
      else if (!(failure as { killed?: boolean }).killed) occurrence.notification.failed_at = now;
      // A timeout/kill has an unknown OS outcome. Keep its claim rather than
      // replaying a possibly displayed alert. It remains unread on the board.
    }, "control");
  }
}
