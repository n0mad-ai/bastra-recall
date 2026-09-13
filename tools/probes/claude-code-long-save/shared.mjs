/** #62 real-client probe — the pieces `prepare.mjs` and `verify.mjs` share. */

export const SERVER = "bastra62";

/** 40 lines ≈ 2.9k chars, 120 ≈ 8.6k, 300 ≈ 21.6k. The ~600 chars the original
 *  report first saw fail sits comfortably inside the smallest of them. */
export const LINES_DEFAULT = "40,120,300";

export const tagFor = (session, lines) => `s${session}n${lines}`;
export const titleFor = (session, lines) => `Probe 62 s${session} n${lines}`;

/** The body the client is ASKED for. The verdict never depends on it: what is
 *  compared is the body the client actually sent against the body on disk. This
 *  only separates "the model wrote something shorter" from "bytes were lost". */
export const expectedBody = (tag, lines) =>
  Array.from({ length: lines }, (_, i) => `line ${i + 1} ${tag} ${"x".repeat(60)}`).join("\n");

export function promptFor(session, lineCounts) {
  const steps = lineCounts
    .map((lines, i) => {
      const tag = tagFor(session, lines);
      const filler = "x".repeat(60);
      return [
        `${i + 1}. First call \`recall\` with query "probe 62 ${tag}". Ignore what it returns.`,
        `   Then call \`save_memory\` with EXACTLY these arguments:`,
        `     title: "${titleFor(session, lines)}"`,
        `     type: "lesson"`,
        `     summary: "Probe 62 body of ${lines} lines"`,
        `     topic_path: ["probe", "issue-62"]`,
        `     tags: ["probe", "issue-62"]`,
        `     scope: "probe"`,
        `     recall_when: ["probe-62-${tag}", "alpha-${tag}-beta"]`,
        `     body: exactly ${lines} lines, no more and no fewer, nothing else —`,
        `       no code fence, no heading, no commentary. Line i (from 1) is`,
        `       exactly: line <i> ${tag} ${filler}`,
        `       So line 1 is: line 1 ${tag} ${filler}`,
        `       and line ${lines} is: line ${lines} ${tag} ${filler}`,
        `       Write every single line out in full. Never abbreviate with "..."`,
        `       and never say "lines 4 to ${lines} omitted".`,
      ].join("\n");
    })
    .join("\n\n");

  return [
    "You are a test fixture, not an assistant. Carry out the following steps in",
    "order. Do not stop early, do not summarise, do not shorten, do not ask",
    "questions, and use no tools other than the two named below.",
    "",
    steps,
    "",
    "When all steps are done, reply with exactly: PROBE_DONE",
  ].join("\n");
}
