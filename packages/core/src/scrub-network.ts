/** Fixed network command/field grammars; no interpretation of prose intent. */
interface Argument { start: number; end: number; next: number; quoted: boolean; }
const gap = (text: string, pos: number): number => {
  while (text[pos] === " " || text[pos] === "\t") pos++;
  return pos;
};
function argument(text: string, pos: number, comma = false): Argument | null {
  pos = gap(text, pos);
  const quote = text[pos] === '"' || text[pos] === "'" ? text[pos++] : null;
  const start = pos;
  while (pos < text.length) {
    const c = text[pos];
    if (c === "\r" || c === "\n") break;
    if (c === "\\" && pos + 1 < text.length) { pos += 2; continue; }
    if (quote) {
      if (c === quote) return { start, end: pos, next: pos + 1, quoted: true };
    } else if (/\s/.test(c) || "|;&`()<>".includes(c) || (comma && c === ",")) break;
    pos++;
  }
  return !quote && pos > start ? { start, end: pos, next: pos, quoted: false } : null;
}

export function scanNetworkForms(text: string, mark: (start: number, length: number) => void, isReference: (value: string) => boolean): void {
  const redact = (start: number, end: number): void => {
    const value = text.slice(start, end);
    if (value && value !== "[REDACTED]" && !isReference(value)) mark(start, end - start);
  };
  const markArgument = (arg: Argument | null): void => { if (arg) redact(arg.start, arg.end); };
  for (const m of text.matchAll(/\bnmcli[ \t]+(?:dev|device)[ \t]+wifi[ \t]+connect[ \t]+/gi)) {
    const ssid = argument(text, m.index! + m[0].length);
    const field = ssid && argument(text, ssid.next);
    if (field && text.slice(field.start, field.end).toLowerCase() === "password") markArgument(argument(text, field.next));
  }
  for (const m of text.matchAll(/\bnetworksetup[ \t]+-setairportnetwork[ \t]+/gi)) {
    const device = argument(text, m.index! + m[0].length);
    const ssid = device && argument(text, device.next);
    if (ssid) markArgument(argument(text, ssid.next));
  }
  // Configuration commands are anchored, so a sentence naming the command stays readable.
  for (const m of text.matchAll(/(?:^|\r?\n)[ \t]*set[ \t]+psksecret[ \t]+(?:ENC[ \t]+)?|(?:^|\r?\n)[ \t]*option[ \t]+key[ \t]+/gi)) markArgument(argument(text, m.index! + m[0].length));
  for (const m of text.matchAll(/(?:^|\r?\n)[ \t]*set[ \t]+vpn[ \t]+ipsec\b[^\r\n;]*?\bauthentication[ \t]+pre-shared-secret[ \t]+/gi)) markArgument(argument(text, m.index! + m[0].length));
  for (const m of text.matchAll(/\buci[ \t]+set[ \t]+wireless\.[a-z0-9_.@\[\]-]+\.key[ \t]*=[ \t]*/gi)) markArgument(argument(text, m.index! + m[0].length));
  for (const m of text.matchAll(/(?:^|\r?\n)[ \t]*crypto[ \t]+isakmp[ \t]+key[ \t]+/gi)) {
    const key = argument(text, m.index! + m[0].length);
    const field = key && argument(text, key.next);
    if (field && text.slice(field.start, field.end).toLowerCase() === "address") markArgument(key);
  }
  for (const m of text.matchAll(/(?:^|\r?\n)[ \t]*Key[ \t]+Content[ \t]*:[ \t]*/gi)) {
    const start = m.index! + m[0].length;
    let end = start; while (end < text.length && text[end] !== "\r" && text[end] !== "\n") end++;
    while (end > start && (text[end - 1] === " " || text[end - 1] === "\t")) end--;
    redact(start, end);
  }
  for (const m of text.matchAll(/\bWiFi\.begin[ \t]*\([ \t]*/g)) {
    const ssid = argument(text, m.index! + m[0].length, true);
    const comma = ssid && gap(text, ssid.next);
    if (comma !== null && text[comma] === ",") {
      const key = argument(text, comma + 1, true);
      if (key?.quoted) markArgument(key);
    }
  }
  for (const m of text.matchAll(/(?:^|\r?\n)[ \t]*#[ \t]*define[ \t]+WIFI_PSK[ \t]+/g)) {
    const key = argument(text, m.index! + m[0].length);
    if (key?.quoted) markArgument(key);
  }
  // Flat JSON string arrays: collect first, redact only a complete array.
  const arrays = /"psks"[ \t\r\n]*:[ \t\r\n]*\[/gi;
  let array: RegExpExecArray | null;
  while ((array = arrays.exec(text))) {
    let pos = array.index + array[0].length, complete = false;
    const values: Argument[] = [];
    for (;;) {
      while (/\s/.test(text[pos] ?? "")) pos++;
      if (text[pos] === "]") { complete = true; pos++; break; }
      if (text[pos] !== '"') break;
      const value = argument(text, pos); if (!value) break;
      values.push(value); pos = value.next;
      while (/\s/.test(text[pos] ?? "")) pos++;
      if (text[pos] === ",") { pos++; continue; }
      if (text[pos] !== "]") break;
    }
    if (complete) values.forEach(markArgument);
    arrays.lastIndex = Math.max(arrays.lastIndex, pos);
  }
  // QR fields use escaped semicolons rather than shell quoting.
  const qrs = /\bWIFI:/g;
  let qr: RegExpExecArray | null;
  while ((qr = qrs.exec(text))) {
    let pos = qr.index + qr[0].length, ssid = false, complete = false;
    const keys: [number, number][] = [];
    while (pos < text.length && text[pos] !== "\r" && text[pos] !== "\n") {
      if (text[pos] === ";") { complete = true; pos++; break; }
      const field = text[pos++]; if (text[pos++] !== ":") break;
      const start = pos;
      while (pos < text.length && !";\r\n".includes(text[pos])) {
        if (text[pos] === "\\" && pos + 1 < text.length) pos += 2; else pos++;
      }
      if (field === "S") ssid = true;
      if (field === "P") keys.push([start, pos]);
      if (text[pos] !== ";") break;
      pos++;
    }
    if (ssid && complete) keys.forEach(([start, end]) => redact(start, end));
    qrs.lastIndex = Math.max(qrs.lastIndex, pos);
  }
}
