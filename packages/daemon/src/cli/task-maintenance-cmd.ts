import { ownerTaskAuthorization } from "./task-owner-access.js";
import { recoverTasks, quarantineOfflineTaskLock } from "../task-maintenance.js";
import { archiveTasks, restoreTaskArchive } from "../task-archive-service.js";
import { tasksPath, readTaskStore } from "../task-store.js";
import { taskAuthPath } from "../task-auth.js";
import { confirm } from "./prompt.js";
import { taskCliLanguage, taskCliWords } from "./task-cli-words.js";
export async function ownerTaskMaintenance(
  sub: string,
  words: string[],
  options: Record<string, string | boolean>,
  json = false
) {
  const authorization = await ownerTaskAuthorization(),
    ctx = { path: tasksPath(), authPath: taskAuthPath() },
    w = taskCliWords(await taskCliLanguage());
  let result: unknown;
  if (sub === "recover") {
    if (!(await confirm(w.recoverConfirm)))
      throw Object.assign(new Error("Owner declined recovery"), { code: "forbidden", reason: "owner_declined" });
    if (options.lock) {
      if (!(await confirm(w.recoverLockConfirm)))
        throw Object.assign(new Error("Owner declined lock recovery"), { code: "forbidden", reason: "owner_declined" });
      quarantineOfflineTaskLock(ctx.path);
    }
    result = await recoverTasks(ctx, authorization, {});
  } else if (sub === "archive-restore") {
    if (!options.archive && !words[0]) throw Object.assign(new Error("Archive ID required"), { code: "validation" });
    if (!(await confirm(w.restoreConfirm)))
      throw Object.assign(new Error("Owner declined restore"), { code: "forbidden", reason: "owner_declined" });
    result = await restoreTaskArchive(ctx, authorization, String(options.archive ?? words[0]));
  } else {
    const s = await readTaskStore(ctx.path),
      ids = words.length
        ? words
        : String(options.id ?? "")
            .split(",")
            .filter(Boolean);
    if (!ids.length) throw Object.assign(new Error("Use archive task-id [task-id]"), { code: "validation" });
    if (!(await confirm(w.archiveConfirm(ids.join(", ")))))
      throw Object.assign(new Error("Owner declined archive"), { code: "forbidden", reason: "owner_declined" });
    result = await archiveTasks(ctx, authorization, {
      task_ids: ids,
      expected_revision: s.revision,
      recovery_epoch: s.recovery_epoch,
    });
  }
  process.stdout.write(
    (json
      ? JSON.stringify(result)
      : sub === "recover"
        ? w.recovered((result as any).recovered_archive_exports)
        : sub === "archive-restore"
          ? w.restored
          : w.archivedDone((result as any).archive_id)) + "\n"
  );
}
