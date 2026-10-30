/** Read-only doctor report. Never confirms or rewrites a legacy candidate. */
import { Vault } from "@bastra-recall/core";
import { collectRuleKernel, renderRuleKernel, RULEBOOK_ALWAYS_CHAR_BUDGET } from "../rule-kernel.js";
import type { KernelCandidates } from "../rulebook-catalog.js";
export function rulebookDoctorLines(c: KernelCandidates): string[] {
  const rendered = renderRuleKernel(c, { trigger: "doctor" });
  return [
    `Regelbuch: ${c.entries.length} bestätigte Regeln; ${c.unconfirmed_legacy ?? 0} mögliche Regeln ohne Bestätigung.`,
    ...(c.unavailable_sources ? [`${c.unavailable_sources} Quellen nicht prüfbar; vollständige Zustellung ist nicht belegt.`] : []),
    `Always budget: ${RULEBOOK_ALWAYS_CHAR_BUDGET} characters; complete catalog: list_rules(cursor).`,
    ...(rendered.always_overflow?.length ? [`Regeln ${rendered.always_overflow.join(", ")} passen nicht vollständig; kürzen oder auf on-demand stellen.`] : []),
  ];
}
export async function printRulebookDoctorNote(vaultPath: string): Promise<void> {
  const vault = new Vault(vaultPath);
  try {
    await vault.init();
    const c = await collectRuleKernel(vault, { project: null, active: [], allProjects: true });
    for (const line of rulebookDoctorLines(c)) process.stdout.write(`→ ${line}\n`);
  } catch { process.stdout.write("→ Regelbuch derzeit nicht prüfbar; keine Regeln automatisch bestätigt.\n"); }
  finally { await vault.stop(); }
}
