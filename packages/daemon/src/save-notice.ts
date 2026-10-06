/**
 * The one line Recall prints after it wrote to the vault.
 *
 * Claude Code collapses an MCP call to "Called bastra-recall"; what was saved
 * is only visible to someone who expands it. A PostToolUse hook's
 * `systemMessage` is printed to the user right under the call, as
 * "PostToolUse:<tool> says: …" (measured on 2.1.291), and SGR colour in it
 * reaches the terminal unchanged — so the line opens with the product name on
 * the brand colour of the status-line segment and is recognisable without
 * reading it.
 *
 * Kept apart from the lane that calls it (save-notice-lane.ts): the line is
 * built from a plain description of what happened, not from a hook payload,
 * so whatever else writes to the vault can announce it the same way.
 */

export type SaveNoticeAction =
  /** A new entry was written. */
  | "created"
  /** An existing entry was written again as a whole. */
  | "updated"
  /** Part of an existing entry was changed (edit_memory). */
  | "edited"
  /** Nothing was written: another memory already declares the situation (#360). */
  | "held"
  /** Nothing was created: the save became a conflict mark on `title` (#205). */
  | "conflict";

export interface SaveNotice {
  action: SaveNoticeAction;
  /** The entry the line is about; its id where no title is known. */
  title: string;
  /** The entry's type as stored (`lesson`, `preference`, …) — never translated. */
  type?: string;
  /** One short addition: a `recall_when` cue, what an edit changed, or the
   *  memory that covers a held save. Dropped when the line would grow past
   *  `MAX_LINE`. */
  detail?: string;
}

/** What an edit did, for `editDetail`. */
export interface EditOperations {
  append?: boolean;
  strReplace?: boolean;
  /** Names of the frontmatter fields the edit patched. */
  fields?: string[];
}

interface Wording {
  action: Record<SaveNoticeAction, string>;
  quote: [string, string];
  /** Label in front of a `recall_when` cue. */
  cue: string;
  /** Label in front of the memory that already covers a held save. */
  coveredBy: string;
  appended: string;
  replaced: string;
  fields: string;
}

/** The line's words, by `language.primary`. Text the product writes — it is
 *  never matched against anything. An unlisted language gets English. */
const WORDING_BY_LANGUAGE: Readonly<Record<string, Wording>> = {
  en: {
    action: { created: "saved", updated: "updated", edited: "edited", held: "not saved, already covered", conflict: "conflict noted on" },
    quote: ["“", "”"],
    cue: "recalled when",
    coveredBy: "see",
    appended: "text appended",
    replaced: "passage replaced",
    fields: "fields",
  },
  de: {
    action: { created: "gespeichert", updated: "aktualisiert", edited: "bearbeitet", held: "nicht gespeichert, schon abgedeckt", conflict: "Widerspruch vermerkt an" },
    quote: ["„", "“"],
    cue: "Abruf bei",
    coveredBy: "siehe",
    appended: "Text angehängt",
    replaced: "Passage ersetzt",
    fields: "Felder",
  },
  ru: {
    action: { created: "сохранено", updated: "обновлено", edited: "изменено", held: "не сохранено, уже есть", conflict: "противоречие отмечено в" },
    quote: ["«", "»"],
    cue: "вспомнить при",
    coveredBy: "см.",
    appended: "текст добавлен",
    replaced: "фрагмент заменён",
    fields: "поля",
  },
};

function wordingFor(language: string | undefined): Wording {
  return WORDING_BY_LANGUAGE[language ?? "en"] ?? WORDING_BY_LANGUAGE.en;
}

const PRODUCT = "bastra-recall";
// White on bastra purple (#7c3aed) — the status-line segment's colours
// (statusline/powerline-theme.ts), so both read as the same sender.
const BADGE_ON = "\x1b[48;2;124;58;237m\x1b[38;2;255;255;255m\x1b[1m";
const BADGE_OFF = "\x1b[0m";

const MAX_TITLE = 60;
const MAX_DETAIL = 60;
/** Visible characters; Claude Code puts ~50 of its own in front of the line. */
const MAX_LINE = 130;

/** One line, whatever the stored text contains: control characters (a title
 *  could carry an escape sequence of its own) and line breaks become spaces. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? chars.slice(0, max - 1).join("").trimEnd() + "…" : flat;
}

/** What an edit changed, in the user's language — `undefined` when unknown. */
export function editDetail(ops: EditOperations, language: string | undefined): string | undefined {
  const w = wordingFor(language);
  const parts = [
    ...(ops.strReplace ? [w.replaced] : []),
    ...(ops.append ? [w.appended] : []),
    ...(ops.fields?.length ? [`${w.fields}: ${ops.fields.join(", ")}`] : []),
  ];
  return parts.length ? parts.join(", ") : undefined;
}

/** A `recall_when` cue as the line's detail. */
export function cueDetail(cue: string, language: string | undefined): string {
  return `${wordingFor(language).cue}: ${cue}`;
}

/** The memory that already covers a held save, as the line's detail. */
export function coveredByDetail(title: string, language: string | undefined): string {
  return `${wordingFor(language).coveredBy}: ${title}`;
}

/** The line. Without colour the product name still stands in front as a fixed prefix. */
export function formatSaveNotice(notice: SaveNotice, language: string | undefined): string {
  const w = wordingFor(language);
  const title = oneLine(notice.title, MAX_TITLE);
  const type = notice.type ? ` (${oneLine(notice.type, 24)})` : "";
  const head = `${w.action[notice.action]}: ${w.quote[0]}${title}${w.quote[1]}${type}`;
  const detail = notice.detail ? oneLine(notice.detail, MAX_DETAIL) : "";
  const text = detail && [...`${PRODUCT} ${head} · ${detail}`].length <= MAX_LINE ? `${head} · ${detail}` : head;
  return `${BADGE_ON} ${PRODUCT} ${BADGE_OFF} ${text}`;
}
