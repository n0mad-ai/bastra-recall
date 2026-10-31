const TAG_NAME_CHAR = /[A-Za-z0-9-]/;
const WHITESPACE = /\s/;

function tagNameEnd(text: string, from: number): number {
  let end = from;
  while (end < text.length && TAG_NAME_CHAR.test(text[end])) end++;
  return end;
}

/** Offsets of every `</name>`, in text order, collected in one forward pass. */
function closingTagOffsets(context: string): Map<string, { offsets: number[]; next: number }> {
  const closings = new Map<string, { offsets: number[]; next: number }>();
  for (let at = context.indexOf("</"); at !== -1; at = context.indexOf("</", at + 2)) {
    const nameEnd = tagNameEnd(context, at + 2);
    if (nameEnd === at + 2 || context[nameEnd] !== ">") continue;
    const name = context.slice(at + 2, nameEnd);
    const entry = closings.get(name);
    if (entry) entry.offsets.push(at);
    else closings.set(name, { offsets: [at], next: 0 });
  }
  return closings;
}

/** Linear-time equivalent of `/\s*<([A-Za-z][A-Za-z0-9-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g`:
 * each scan position only moves forward, so unclosed tags cannot cause rescans. */
export function findFrames(context: string): Array<{ start: number; end: number; name: string }> {
  const closings = closingTagOffsets(context);
  const frames: Array<{ start: number; end: number; name: string }> = [];
  let offset = 0;
  let tagEnd = -1;
  for (let open = context.indexOf("<"); open !== -1; open = context.indexOf("<", open + 1)) {
    const nameEnd = tagNameEnd(context, open + 1);
    if (nameEnd === open + 1 || !/[A-Za-z]/.test(context[open + 1])) continue;
    const after = context[nameEnd];
    if (after !== ">" && (after === undefined || !WHITESPACE.test(after))) continue;
    if (tagEnd < nameEnd) {
      tagEnd = context.indexOf(">", nameEnd);
      if (tagEnd === -1) break; // without a ">" no later tag can open either
    }
    const name = context.slice(open + 1, nameEnd);
    const closing = closings.get(name);
    if (!closing) continue;
    while (closing.next < closing.offsets.length && closing.offsets[closing.next] <= tagEnd) closing.next++;
    if (closing.next === closing.offsets.length) continue;
    const end = closing.offsets[closing.next] + name.length + 3;
    let start = open;
    while (start > offset && WHITESPACE.test(context[start - 1])) start--;
    frames.push({ start, end, name });
    offset = end;
    open = end - 1;
  }
  return frames;
}

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
  let offset = 0;
  for (const frame of findFrames(context)) {
    add(context.slice(offset, frame.start), "session text");
    add(context.slice(frame.start, frame.end), frame.name); offset = frame.end;
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
