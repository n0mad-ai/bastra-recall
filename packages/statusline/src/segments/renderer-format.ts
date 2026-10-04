// Text formatting shared by the SegmentRenderer segments (#1039): counter
// plurals, the project-relative directory name and the usage/budget display
// of the session and today segments. Pure functions, no renderer state.

import type { TokenBreakdown } from ".";
import type { BudgetItemConfig } from "../config/loader";
import {
  formatCost,
  formatTokens,
  formatTokenCount,
  formatTokenBreakdown,
} from "../utils/formatters";
import { resolveBudgetDisplay } from "../utils/budget";

/** "1 call" / "2 calls" — the counter is visible in every session, so the
 *  singular case must not read as a typo. Same for hits. */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function getDisplayDirectoryName(
  currentDir: string,
  projectDir?: string,
): string {
  if (currentDir.startsWith("~")) {
    return currentDir;
  }

  if (projectDir && projectDir !== currentDir) {
    const base = projectDir.replace(/[\\/]+$/, "");
    if (
      currentDir.startsWith(base) &&
      /[\\/]/.test(currentDir.charAt(base.length))
    ) {
      const relativePath = currentDir.slice(base.length + 1);
      return relativePath || projectDir.split(/[\\/]/).pop() || "project";
    }
  }

  return currentDir;
}

export function formatUsageDisplay(
  cost: number | null,
  tokens: number | null,
  tokenBreakdown: TokenBreakdown | null,
  type: string,
  showUnits: boolean,
): string {
  const tokenStr = showUnits
    ? formatTokens(tokens)
    : formatTokenCount(tokens);
  switch (type) {
    case "cost":
      return formatCost(cost);
    case "tokens":
      return tokenStr;
    case "both":
      return `${formatCost(cost)} (${tokenStr})`;
    case "breakdown":
      return formatTokenBreakdown(tokenBreakdown);
    default:
      return formatCost(cost);
  }
}

export function formatUsageWithBudget(
  cost: number | null,
  tokens: number | null,
  tokenBreakdown: TokenBreakdown | null,
  type: string,
  budget: BudgetItemConfig | undefined,
  showUnits: boolean,
): string | null {
  const state = resolveBudgetDisplay(cost, tokens, budget);
  if (state.suppressAll) return null;
  if (!state.showBase) return state.percentText;

  const baseDisplay = formatUsageDisplay(
    cost,
    tokens,
    tokenBreakdown,
    type,
    showUnits,
  );
  return state.percentText
    ? `${baseDisplay} ${state.percentText}`
    : baseDisplay;
}
