/**
 * The save_memory input for a save the user directs by hand — "Save as
 * memory" in the web UI (#1445) and `bastra save` in the terminal (#1492).
 *
 * Both feed the normal save_memory path with `write_origin: user-directed`
 * (the user's own instruction is the approval). What the user did not fill
 * in is derived the same way on both surfaces, so one memory saved twice —
 * once per surface — comes out with the same fields.
 *
 * Kept free of daemon imports: the CLI loads it on every invocation.
 */

/** Authored types. `doc` and `bookmark` come from importers and carry fields
 *  of their own, so a hand-made save never offers them. */
export const USER_SAVE_TYPES = [
  "reference",
  "project-fact",
  "decision",
  "lesson",
  "workflow",
  "preference",
  "user-preference",
  "meta-working",
] as const;

export type UserSaveType = (typeof USER_SAVE_TYPES)[number];

/** First line of the text as plain text, markdown marks removed; the title
 *  when the text has no readable line. An over-long summary is clamped by
 *  the save itself. */
export function summaryFrom(body: string, title: string): string {
  for (const line of body.split("\n")) {
    const plain = line
      .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+[.)])\s+/, "")
      .replace(/[*_`~]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (plain) return plain;
  }
  return title;
}

export interface UserSaveDraft {
  title: string;
  type: UserSaveType;
  scope: string;
  body: string;
  /** Optional overrides; absent fields are derived from title and scope. */
  summary?: string;
  recall_when?: string[];
  tags?: string[];
  topic_path?: string[];
}

/** The save_memory arguments for a draft the user directed. */
export function userDirectedSaveInput(draft: UserSaveDraft) {
  const some = (list: string[] | undefined, fallback: string[]) => (list && list.length ? list : fallback);
  return {
    title: draft.title,
    type: draft.type,
    scope: draft.scope,
    body: draft.body,
    summary: draft.summary || summaryFrom(draft.body, draft.title),
    topic_path: some(draft.topic_path, [draft.scope]),
    tags: some(draft.tags, [draft.scope]),
    recall_when: some(draft.recall_when, [draft.title]),
    write_origin: "user-directed" as const,
  };
}
