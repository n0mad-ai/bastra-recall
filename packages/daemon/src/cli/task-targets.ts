import { normalizedOwnerTarget } from "./task-target-safety.js";
/** Account-local mapped callers may register instructed targets. Edits stop execution and retire old proposals. */
import { resolve } from "node:path";
import { authenticateTask, requireTaskDomains } from "../task-auth.js";
import {
  approvalRegistryPath,
  readApprovalRegistry,
  approvalRegistrySchema,
  migrateTaskApprovalRegistry,
} from "../task-approval-keys.js";
import { readTaskTarget, requireReversiblePayload } from "../task-actions.js";
import { atomicWrite, tasksPath, transactTaskStore } from "../task-store.js";
import { withPathLock } from "../path-lock.js";
import { ownerTaskAuthorization } from "./task-owner-access.js";
import { confirm } from "./prompt.js";
import { taskCliLanguage, taskCliWords } from "./task-cli-words.js";
import { taskClientAuthorization } from "../task-transport.js";
export async function registerOwnerTaskTarget(authorization: string, input: unknown, replace = false) {
  await migrateTaskApprovalRegistry();
  const owner = await authenticateTask(authorization);
  const normalized = await normalizedOwnerTarget(input),
    { outside_current_workdir: _warning, package_scripts: _scripts, ...target } = normalized;
  requireTaskDomains(owner, target.owner_domains);
  // Stop before changing the registry, even if an overlapping edit later fails.
  await transactTaskStore(
    tasksPath(),
    undefined,
    (s) => {
      s.controls.execution_stopped = true;
    },
    "control"
  );
  await withPathLock(
    approvalRegistryPath(),
    async (ownership) => {
      const current = await authenticateTask(authorization);
      requireTaskDomains(current, target.owner_domains);
      const registry = (await readApprovalRegistry(approvalRegistryPath())) ?? {
        schema_version: 1 as const,
        revision: 0,
        protected_boundary: false,
        keys: [],
        targets: [],
      };
      const previous = registry.targets.find((t) => t.id === target.id);
      if (previous) {
        requireTaskDomains(current, previous.owner_domains);
        if (!replace) throw Object.assign(new Error("Target already registered; use update"), { code: "conflict" });
      } else if (replace) throw Object.assign(new Error("Target absent"), { code: "not_found" });
      const checked = await normalizedOwnerTarget(target); // recheck after confirmation under registry lock
      if (checked.root !== target.root || checked.path !== target.path)
        throw Object.assign(new Error("Target changed after confirmation"), {
          code: "validation",
          reason: "target_boundary",
        });
      registry.targets = registry.targets.filter((t) => t.id !== target.id);
      registry.targets.push(target);
      requireReversiblePayload((await readTaskTarget(registry, target.id)).payload);
      registry.protected_boundary = false;
      registry.revision++;
      await atomicWrite(approvalRegistryPath(), JSON.stringify(approvalRegistrySchema.parse(registry)), ownership);
    },
    { strictLocal: true }
  );
  return { id: target.id, root: target.root, path: target.path, execution_stopped: true, protected_boundary: false };
}
export async function ownerTaskTargets(words: string[], options: Record<string, string | boolean>, json = false) {
  const agent = options.agent === true || words[0] === "agent";
  if (words[0] === "agent") words.shift();
  const authorization = agent ? await taskClientAuthorization() : await ownerTaskAuthorization();
  if (!authorization) throw Object.assign(new Error("Mapped task credential required"), { code: "unauthorized" });
  const principal = await authenticateTask(authorization),
    w = taskCliWords(await taskCliLanguage());
  if (words[0] === "list") {
    const registry = await readApprovalRegistry(),
      targets = registry?.targets.filter((t) => t.owner_domains.every((d) => principal.domains.includes(d))) ?? [];
    process.stdout.write(
      (json
        ? JSON.stringify({ targets })
        : targets
            .map((t) => `${t.id}: ${resolve(t.root, t.path)} · ${t.owner_domains.join(",")} · ${t.sensitivity}`)
            .join("\n") || w.noTargets) + "\n"
    );
    return;
  }
  if (words[0] === "remove") {
    if (!words[1])
      throw Object.assign(new Error("Target ID required"), { code: "validation", reason: "targets_syntax" });
    const registry = await readApprovalRegistry(),
      target = registry?.targets.find((t) => t.id === words[1]);
    if (!target) throw Object.assign(new Error("Target absent"), { code: "not_found" });
    requireTaskDomains(principal, target.owner_domains);
    process.stdout.write(
      w.targetLine(target.id, resolve(target.root, target.path), target.owner_domains.join(",")) + "\n"
    );
    if (!agent && !(await confirm(w.targetRemoveConfirm)))
      throw Object.assign(new Error("Owner declined removal"), { code: "forbidden", reason: "owner_declined" });
    await removeOwnerTaskTarget(authorization, target.id);
    process.stdout.write(json ? JSON.stringify({ removed: true, id: target.id }) + "\n" : w.targetRemoved + "\n");
    return;
  }
  if (!["register", "update"].includes(words[0]) || !words[1] || !options.root || !options.path || !options.domain)
    throw Object.assign(new Error("Targets syntax required"), { code: "validation", reason: "targets_syntax" });
  const input = {
    id: words[1],
    root: String(options.root),
    path: String(options.path),
    owner_domains: String(options.domain).split(","),
    sensitivity: String(options.sensitivity ?? "private"),
    adapter: "local-artifact-v1",
  };
  const normalized = await normalizedOwnerTarget(input);
  requireTaskDomains(principal, normalized.owner_domains);
  const update = words[0] === "update";
  process.stdout.write(
    w.targetPreview(words[1], resolve(normalized.root, normalized.path), normalized.root, String(options.domain)) + "\n"
  );
  if (normalized.package_scripts) process.stdout.write(w.packageScripts + "\n");
  if (normalized.outside_current_workdir) process.stdout.write(w.outsideWorkdir + "\n");
  if (!agent && !(await confirm(w.targetConfirm(update))))
    throw Object.assign(new Error("Owner declined target"), { code: "forbidden", reason: "owner_declined" });
  const result = await registerOwnerTaskTarget(authorization, input, update);
  process.stdout.write((json ? JSON.stringify(result) : w.targetDone(result.id, update)) + "\n");
}
export async function removeOwnerTaskTarget(authorization: string, id: string) {
  await migrateTaskApprovalRegistry();
  const owner = await authenticateTask(authorization);
  const initial = await readApprovalRegistry(approvalRegistryPath()),
    target = initial?.targets.find((t) => t.id === id);
  if (!target) throw Object.assign(new Error("Target absent"), { code: "not_found" });
  requireTaskDomains(owner, target.owner_domains);
  await transactTaskStore(
    tasksPath(),
    undefined,
    (s) => {
      s.controls.execution_stopped = true;
    },
    "control"
  );
  await withPathLock(
    approvalRegistryPath(),
    async (ownership) => {
      const current = await authenticateTask(authorization);
      const registry = await readApprovalRegistry(approvalRegistryPath()),
        target = registry?.targets.find((t) => t.id === id);
      if (!registry || !target) throw Object.assign(new Error("Target absent"), { code: "not_found" });
      requireTaskDomains(current, target.owner_domains);
      registry.targets = registry.targets.filter((t) => t.id !== id);
      registry.protected_boundary = false;
      registry.revision++;
      await atomicWrite(approvalRegistryPath(), JSON.stringify(approvalRegistrySchema.parse(registry)), ownership);
    },
    { strictLocal: true }
  );
  return { removed: true, id };
}
