/** Fits generated session sections, preserving whole rule/language blocks.
 * Tag parsing is protocol framing, never intent or rule-applicability detection. */
export function capSessionContext(context: string, protectedSections: readonly string[], limit = 9900): { text: string; deferred: string[] } {
  if (context.length <= limit) return { text: context, deferred: [] };
  const parts: Array<{ text: string; name: string; required: boolean; kept: boolean }> = [];
  const add = (text: string, name: string) => {
    if (!text) return;
    parts.push({ text, name, kept: true,
      required: protectedSections.some(p => p.trim() && text.includes(p.trim())) });
  };
  const frames = /\s*<([A-Za-z][A-Za-z0-9-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g;
  let offset = 0;
  for (const match of context.matchAll(frames)) {
    add(context.slice(offset, match.index), "session text");
    add(match[0], match[1]); offset = match.index! + match[0].length;
  }
  add(context.slice(offset), "session text");
  const deferred: string[] = [];
  const suffix = (names: string[]) => names.length ? `\nDeferred session sections: ${[...new Set(names)].join(", ")}.` : "";
  const keptText = () => parts.filter(p => p.kept).map(p => p.text).join("");
  while (keptText().length + suffix(deferred).length > limit) {
    const candidates = parts.filter(p => p.kept && !p.required);
    if (!candidates.length) throw new Error("Protected session sections exceed the context budget");
    const current = keptText().length;
    const sufficient = candidates.filter(p => current - p.text.length + suffix([...deferred, p.name]).length <= limit);
    const chosen = sufficient.length
      ? sufficient.sort((a, b) => a.text.length - b.text.length)[0]
      : candidates.sort((a, b) => b.text.length - a.text.length)[0];
    chosen.kept = false; deferred.push(chosen.name);
  }
  return { text: keptText() + suffix(deferred), deferred: [...new Set(deferred)] };
}
