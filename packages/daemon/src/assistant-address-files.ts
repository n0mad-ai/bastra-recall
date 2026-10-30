/** Owned, reversible text edits. Foreign hosts and Firefox preferences remain intact. */
import { normalizeAssistantName } from "./assistant-address-name.js";

function owned(text: string, owner: string, comment: string) {
  if (!/^\d+$/.test(owner)) throw new Error("invalid address owner");
  const marker = `${comment} bastra-recall assistant-address ${owner}`;
  const starts = [...text.matchAll(new RegExp(`^${marker} begin(?: joined)?\\r?$`, "gm"))];
  const ends = [...text.matchAll(new RegExp(`^${marker} end\\r?$`, "gm"))];
  if (!starts.length && !ends.length) {
    if (text.split(/\r?\n/).some(line => line === marker || line.startsWith(marker + " "))) throw new Error("damaged managed address marker");
    return { base: text, body: "", marker };
  }
  if (starts.length !== 1 || ends.length !== 1 || ends[0].index! <= starts[0].index!) throw new Error("damaged managed address block");
  const start = starts[0].index!, end = ends[0].index!;
  const bodyStart = start + starts[0][0].length + (text[start + starts[0][0].length] === "\n" ? 1 : 0);
  const body = text.slice(bodyStart, end).trim();
  let after = end + ends[0][0].length; if (text[after] === "\n") after++;
  const before = starts[0][0].endsWith(" joined") ? start - 1 : start;
  return { base: text.slice(0, before) + text.slice(after), body, marker };
}
function block(base: string, marker: string, body: string): string {
  const joined = base.length > 0 && !base.endsWith("\n");
  return base + (joined ? "\n" : "") + `${marker} begin${joined ? " joined" : ""}\n${body}\n${marker} end\n`;
}
export function managedAssistantHostsName(text: string, owner: string): string | null {
  const part = owned(text, owner, "#");
  if (!part.body) return null;
  const rows = part.body.split(/\r?\n/);
  const first = /^127\.0\.0\.1 ([a-z0-9-]+) \1\.localhost$/.exec(rows[0]);
  if (!first || !(rows.length === 1 || rows.length === 2 && rows[1] === `::1 ${first[1]} ${first[1]}.localhost`)) throw new Error("modified managed hosts block");
  return normalizeAssistantName(first[1]);
}
export function patchAssistantHosts(text: string, value: string | null, owner: string): string {
  const part = owned(text, owner, "#");
  managedAssistantHostsName(text, owner); // refuse foreign edits inside our markers
  if (value === null) return part.base;
  const name = normalizeAssistantName(value), aliases = new Set([name, `${name}.localhost`]);
  for (const row of part.base.split(/\r?\n/)) {
    const words = row.split("#", 1)[0].trim().split(/\s+/).slice(1);
    if (words.some(word => aliases.has(word.toLowerCase().replace(/\.$/, "")))) throw new Error(`hosts conflict: ${name}`);
  }
  return block(part.base, part.marker, `127.0.0.1 ${name} ${name}.localhost\n::1 ${name} ${name}.localhost`);
}
export function patchFirefoxUserJs(text: string, value: string | null, owner: string): string {
  const part = owned(text, owner, "//");
  if (part.body && !/^user_pref\("browser\.fixup\.domainwhitelist\.[a-z0-9-]+", true\);$/.test(part.body)) throw new Error("modified managed Firefox block");
  if (value === null) return part.base;
  const name = normalizeAssistantName(value);
  const foreign = new RegExp(`(?:user_pref|pref)\\(\\s*["']browser\\.fixup\\.domainwhitelist\\.${name}["']\\s*,`);
  if (foreign.test(part.base)) throw new Error(`foreign Firefox preference conflict: ${name}`);
  return block(part.base, part.marker, `user_pref("browser.fixup.domainwhitelist.${name}", true);`);
}

/** Firefox copies user.js into prefs.js. Remove only the exact formerly owned
 * true preference; unrelated preferences and user changes remain byte-for-byte. */
export function retiredFirefoxPreference(text:string,userJs:string,nextName:string|null,owner:string,provenOwned=false):string{
 if(!provenOwned)return text;
 const part=owned(userJs,owner,"//");
 patchFirefoxUserJs(userJs,nextName,owner); // validate ownership before touching persisted state
 const prior=/^user_pref\("browser\.fixup\.domainwhitelist\.([a-z0-9-]+)", true\);$/.exec(part.body)?.[1];
 if(!prior||prior===nextName)return text;
 return text.replace(new RegExp(`^user_pref\\(\\"browser\\.fixup\\.domainwhitelist\\.${prior}\\", true\\);(?:\\r?\\n|$)`,"gm"),"");
}
