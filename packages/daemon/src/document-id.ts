const SLUG_MAX_LEN = 80;

/** New document IDs keep letters and marks from every script. */
export function makeDocId(folderPath: string, filename: string): string {
  const input = folderPath ? `${folderPath}/${filename}` : filename;
  const slug = Array.from(
    input
      .normalize("NFC")
      .toLowerCase()
      .replace(/ä/g, "ae")
      .replace(/ö/g, "oe")
      .replace(/ü/g, "ue")
      .replace(/ß/g, "ss")
      .normalize("NFKD")
      .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
      .normalize("NFC")
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, ""),
  )
    .slice(0, SLUG_MAX_LEN)
    .join("");
  if (!slug) throw new Error(`cannot slugify: ${JSON.stringify(input)}`);
  return `doc-${slug}`;
}

/** Only used to recognize an existing sidecar written before #775. */
export function legacyDocId(folderPath: string, filename: string): string | undefined {
  const input = folderPath ? `${folderPath}/${filename}` : filename;
  const slug = input
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LEN);
  return slug ? `doc-${slug}` : undefined;
}
