import type { PowerlineColors } from "../themes";
import type { TuiData } from "./types";
import { collapseHome } from "../utils/formatters";

export function resolveThresholdStyle(
  pct: number,
  defaultFg: string,
  defaultBold: boolean,
  colors: PowerlineColors,
  warningAt = 60,
  criticalAt = 80,
): { fg: string; bold: boolean } {
  if (pct >= criticalAt)
    return { fg: colors.contextCriticalFg, bold: colors.contextCriticalBold };
  if (pct >= warningAt)
    return { fg: colors.contextWarningFg, bold: colors.contextWarningBold };
  return { fg: defaultFg, bold: defaultBold };
}

export function getDirectoryDisplay(hookData: TuiData["hookData"]): string {
  const currentDir = hookData.workspace?.current_dir || hookData.cwd || "/";
  return collapseHome(currentDir);
}
