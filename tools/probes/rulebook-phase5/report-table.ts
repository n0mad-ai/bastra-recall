/** Keep probe details inside one Markdown table cell. */
export const escapeReportCell = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
