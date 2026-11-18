/** Read-only doctor report. Never confirms or rewrites a legacy candidate. */
import { Vault } from "@bastra-recall/core";
import { collectRuleKernel, renderRuleKernel, RULEBOOK_ALWAYS_CHAR_BUDGET } from "../rule-kernel.js";
import { RULEBOOK_TOOL_BUDGET_MS, type KernelCandidates } from "../rulebook-catalog.js";
import { taskCliLanguage } from "./task-cli-words.js";

/** The report's words by language.primary, English when unset or unlisted (#1602).
 *  Text the product writes — never matched against user text. */
const WORDS = {
  en: {
    count: (rules: number, unconfirmed: number) =>
      `Rulebook: ${rules} confirmed rules; ${unconfirmed} possible rules without confirmation.`,
    unavailable: (n: number) => `${n} sources cannot be checked; complete delivery is not proven.`,
    budget: (chars: number) => `Always budget: ${chars} characters; complete catalog: list_rules(cursor).`,
    overflow: (ids: string) => `Rules ${ids} do not fit completely; shorten them or set them to on-demand.`,
    failed: "Rulebook cannot be checked right now; no rules confirmed automatically.",
  },
  de: {
    count: (rules: number, unconfirmed: number) =>
      `Regelbuch: ${rules} bestätigte Regeln; ${unconfirmed} mögliche Regeln ohne Bestätigung.`,
    unavailable: (n: number) => `${n} Quellen nicht prüfbar; vollständige Zustellung ist nicht belegt.`,
    budget: (chars: number) => `Always-Budget: ${chars} Zeichen; vollständiger Katalog: list_rules(cursor).`,
    overflow: (ids: string) => `Regeln ${ids} passen nicht vollständig; kürzen oder auf on-demand stellen.`,
    failed: "Regelbuch derzeit nicht prüfbar; keine Regeln automatisch bestätigt.",
  },
};
const words = (language: string) => WORDS[language as keyof typeof WORDS] ?? WORDS.en;

export function rulebookDoctorLines(c: KernelCandidates, language = "en"): string[] {
  const w = words(language);
  const rendered = renderRuleKernel(c, { trigger: "doctor" });
  return [
    w.count(c.entries.length, c.unconfirmed_legacy ?? 0),
    ...(c.unavailable_sources ? [w.unavailable(c.unavailable_sources)] : []),
    w.budget(RULEBOOK_ALWAYS_CHAR_BUDGET),
    ...(rendered.always_overflow?.length ? [w.overflow(rendered.always_overflow.join(", "))] : []),
  ];
}
export async function printRulebookDoctorNote(vaultPath: string): Promise<void> {
  const language = await taskCliLanguage().catch(() => "en");
  const vault = new Vault(vaultPath);
  try {
    await vault.init();
    const c = await collectRuleKernel(vault, {
      project: null,
      active: [],
      allProjects: true,
      budgetMs: RULEBOOK_TOOL_BUDGET_MS,
    });
    for (const line of rulebookDoctorLines(c, language)) process.stdout.write(`→ ${line}\n`);
  } catch {
    process.stdout.write(`→ ${words(language).failed}\n`);
  } finally {
    await vault.stop();
  }
}
