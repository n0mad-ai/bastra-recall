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
  // Sort once and index net savings. Every eviction updates only the entries
  // sharing its name; finding the smallest sufficient section is O(log n).
  const candidates = parts.filter(p => !p.required).sort((a, b) => a.text.length - b.text.length);
  const groups = new Map<string, number[]>();
  let size = 1;
  while (size < candidates.length) size *= 2;
  const savings = new Array<number>(size * 2).fill(-Infinity);
  candidates.forEach((part, i) => {
    const group = groups.get(part.name) ?? [];
    group.push(i); groups.set(part.name, group);
    savings[size + i] = part.text.length - part.name.length - 2;
  });
  for (let i = size - 1; i > 0; i--) savings[i] = Math.max(savings[2 * i], savings[2 * i + 1]);
  const update = (index: number, value: number) => {
    let at = size + index;
    savings[at] = value;
    while ((at = Math.floor(at / 2)) > 0) savings[at] = Math.max(savings[2 * at], savings[2 * at + 1]);
  };
  const firstSufficient = (needed: number) => {
    if (savings[1] < needed) return -1;
    let at = 1;
    while (at < size) at = savings[2 * at] >= needed ? 2 * at : 2 * at + 1;
    return at - size;
  };
  const deferred: string[] = [];
  const names = new Set<string>();
  const prefix = "\nDeferred session sections: ";
  let keptLength = context.length;
  let suffixLength = 0;
  let largest = candidates.length - 1;
  while (keptLength + suffixLength > limit && largest >= 0) {
    // The first deferred name also pays for the prefix and final period.
    const sufficient = firstSufficient(keptLength + suffixLength - limit + (names.size ? 0 : prefix.length - 1));
    const index = sufficient >= 0 ? sufficient : largest;
    const chosen = candidates[index];
    chosen.kept = false;
    keptLength -= chosen.text.length;
    update(index, -Infinity);
    if (!names.has(chosen.name)) {
      suffixLength += chosen.name.length + (names.size ? 2 : prefix.length + 1);
      names.add(chosen.name); deferred.push(chosen.name);
      for (const sameName of groups.get(chosen.name)!) {
        if (candidates[sameName].kept) update(sameName, candidates[sameName].text.length);
      }
    }
    while (largest >= 0 && !candidates[largest].kept) largest--;
  }
  const keptText = parts.filter(p => p.kept).map(p => p.text).join("");
  let suffix = names.size ? `${prefix}${deferred.join(", ")}.` : "";
  if (keptText.length + suffix.length > limit) {
    // Names are metadata, never a reason to throw or truncate mandatory text.
    // Required rule/language sections take precedence over the soft cap.
    suffix = `${prefix}${names.size} sections (names in deferred metadata).`;
    if (keptText.length + suffix.length > limit) suffix = "";
  }
  return { text: keptText + suffix, deferred };
}
