/**
 * Onboarding interview — seed a FRESH vault by asking a handful of
 * persona-aware questions instead of starting cold. The first answer (what
 * the memory is mainly for: developer / business / personal / mixed) steers
 * which follow-ups appear, so the interview digs deep without demanding
 * much: 7 questions total, 3 of them optional.
 *
 * Three surfaces, one catalog: the map's onboarding dialog (POST
 * /ui/onboarding), `bastra onboard` in a terminal, and the AI session
 * itself (the session hook injects the catalog as an interview guide; the
 * session model asks adaptively). Answers become REAL memories immediately
 * — the user wrote them, so `write_origin: "user-directed"` and no review
 * gate. A marker file at the vault root stops the nudge after the
 * interview is done or explicitly skipped.
 */
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SaveMemoryInput } from "@bastra-recall/core";
import { sendJsonPlain } from "./webui.js";
import { getUiEnabled, setSizeGuide, setPrimaryLanguage } from "./settings.js";
import { detectLanguage } from "./learned-recall/language.js";
import { saveMemoryWithAuditTrail } from "./audit-trail.js";

export const ONBOARD_MARKER = ".onboarding-done";
/** Below this vault size a vault counts as fresh (an interview writes ~8). */
export const FRESH_VAULT_MAX = 8;

export const PERSONAS = ["developer", "business", "personal", "mixed"] as const;
export type Persona = (typeof PERSONAS)[number];

export const PERSONA_LABELS: Record<Persona, string> = {
  developer: "Code & projects — I build software",
  business: "Company & decisions — I run a team or business",
  personal: "Life & knowledge — a good memory for everything",
  mixed: "A bit of everything",
};

export interface OnboardingQuestion {
  id: string;
  ask: string;
  hint: string;
  optional: boolean;
  /** null = every persona; mixed gets the first question of each persona. */
  personas: Persona[] | null;
}

export const QUESTIONS: OnboardingQuestion[] = [
  {
    id: "identity",
    ask: "How should your AI address you — and in what language and tone?",
    hint: "e.g. Alex · German, informal · terse and technical",
    optional: false,
    personas: null,
  },
  {
    id: "rules",
    ask: "Hard rules — anything your AI should ALWAYS or NEVER do?",
    hint: "e.g. never push to git on its own · always ask before deleting",
    optional: true,
    personas: null,
  },
  {
    id: "stack",
    ask: "Your stack — the languages, frameworks and tools you live in?",
    hint: "e.g. TypeScript + Node, SwiftUI, Postgres, no ORMs",
    optional: false,
    personas: ["developer", "mixed"],
  },
  {
    id: "projects",
    ask: "What are you building right now — your active projects, one line each?",
    hint: "project name — what it is, where it stands",
    optional: false,
    personas: ["developer"],
  },
  {
    id: "workflow",
    ask: "How do you like to work — tests, commits, reviews, code style?",
    hint: "e.g. I commit myself · tests before merge · small PRs",
    optional: true,
    personas: ["developer"],
  },
  {
    id: "conventions_size",
    ask: "File-size guide — around how many lines should a source file stay, before a split gets proposed?",
    hint: "e.g. 500 — a guide value, not a hard limit; the AI proposes splits instead of growing files silently",
    optional: true,
    personas: ["developer"],
  },
  {
    id: "conventions_structure",
    ask: "Folder conventions — which folder holds what in your projects?",
    hint: "e.g. hooks/ for React hooks · api/ for routes · components/ · managers/ · utils/",
    optional: true,
    personas: ["developer"],
  },
  {
    id: "role",
    ask: "Your company and role — what do you run, and what does it do?",
    hint: "e.g. CEO of a 12-person agency for industrial clients",
    optional: false,
    personas: ["business", "mixed"],
  },
  {
    id: "people",
    ask: "The key people around you — names and roles you work with closely?",
    hint: "e.g. Anna — co-founder · Marc — lead dev · Kim — biggest client",
    optional: false,
    personas: ["business"],
  },
  {
    id: "duties",
    ask: "What should your AI prepare or watch for you — meetings, mail, decisions?",
    hint: "e.g. brief me before calls · draft replies · flag deadlines",
    optional: true,
    personas: ["business"],
  },
  {
    id: "world",
    ask: "Your day-to-day world — the people, places and routines that matter?",
    hint: "e.g. two kids · Berlin · gym Tue+Thu · weekly call with mom",
    optional: false,
    personas: ["personal", "mixed"],
  },
  {
    id: "remember",
    ask: "What must never be forgotten — dates, preferences, running threads?",
    hint: "e.g. anniversary May 12 · no seafood · house hunt ongoing",
    optional: false,
    personas: ["personal"],
  },
  {
    id: "goals",
    ask: "What are you working toward right now — projects, plans, goals?",
    hint: "e.g. finish the certification · renovate the kitchen",
    optional: true,
    personas: ["personal"],
  },
  {
    id: "freeform",
    ask: "Anything else your AI should know about you? Write freely.",
    hint: "whatever helps — background, quirks, pet peeves",
    optional: true,
    personas: null,
  },
];

export function questionsFor(persona: Persona): OnboardingQuestion[] {
  return QUESTIONS.filter((q) => q.personas === null || q.personas.includes(persona));
}

interface Template {
  id: string;
  title: string;
  type: SaveMemoryInput["type"];
  tags: string[];
  recall_when: string[];
  note?: string;
}

const TEMPLATES: Record<string, Template> = {
  identity: {
    id: "profile-how-to-address-me",
    title: "Profile: how to address me",
    type: "user-preference",
    tags: ["profile", "onboarding", "tone"],
    recall_when: ["session start — language and tone", "how should I address the user", "what language does the user prefer"],
  },
  rules: {
    id: "profile-standing-rules",
    title: "Profile: standing rules (always/never)",
    type: "workflow",
    tags: ["profile", "onboarding", "rules"],
    recall_when: ["before running a risky or irreversible action", "what are the user's hard rules", "am I allowed to do this on my own"],
  },
  stack: {
    id: "profile-stack",
    title: "Profile: stack and tools",
    type: "user-preference",
    tags: ["profile", "onboarding", "stack"],
    recall_when: ["about to write code — which stack", "what languages and frameworks does the user use", "choosing a library or tool"],
  },
  projects: {
    id: "profile-active-projects",
    title: "Profile: active projects",
    type: "project-fact",
    tags: ["profile", "onboarding", "projects"],
    recall_when: ["what is the user building right now", "session start project context", "which project does this task belong to"],
  },
  workflow: {
    id: "profile-dev-workflow",
    title: "Profile: how I like to work",
    type: "workflow",
    tags: ["profile", "onboarding", "workflow"],
    recall_when: ["before committing or opening a PR", "how does the user want tests and reviews handled", "what workflow does the user prefer"],
  },
  conventions_size: {
    id: "profile-file-size-guide",
    title: "Profile: file-size guide for source files",
    type: "user-preference",
    tags: ["profile", "onboarding", "conventions"],
    recall_when: [
      "about to write or grow a source file — size guide",
      "when to propose a module split line count",
      "file size convention for this user",
    ],
    note: "The PreToolUse hook enforces this deterministically (file-size-check); the number also lives in cli-settings as size.guide.",
  },
  conventions_structure: {
    id: "profile-folder-conventions",
    title: "Profile: folder and module conventions",
    type: "user-preference",
    tags: ["profile", "onboarding", "conventions"],
    recall_when: [
      "creating a new file — which folder does it belong in",
      "project folder structure convention",
      "where do hooks api components utils live",
    ],
  },
  role: {
    id: "profile-company-and-role",
    title: "Profile: company and role",
    type: "project-fact",
    tags: ["profile", "onboarding", "business"],
    recall_when: ["what company does the user run", "business context for a decision or draft", "who is the user professionally"],
  },
  people: {
    id: "profile-key-people",
    title: "Profile: key people",
    type: "project-fact",
    tags: ["profile", "onboarding", "people"],
    recall_when: ["who does the user work with", "drafting a message to a colleague", "who is this person the user mentioned"],
    note: "Split into one memory per person (memories/people) when a person starts accumulating their own history.",
  },
  duties: {
    id: "profile-assistant-duties",
    title: "Profile: what to prepare and watch",
    type: "workflow",
    tags: ["profile", "onboarding", "duties"],
    recall_when: ["what should I proactively prepare for the user", "meeting or mail preparation", "daily assistant duties"],
  },
  world: {
    id: "profile-my-world",
    title: "Profile: my day-to-day world",
    type: "user-preference",
    tags: ["profile", "onboarding", "personal"],
    recall_when: ["personal context — people, places, routines", "planning something in the user's daily life", "who or what matters to the user"],
  },
  remember: {
    id: "profile-never-forget",
    title: "Profile: never forget",
    type: "user-preference",
    tags: ["profile", "onboarding", "personal"],
    recall_when: ["important dates or standing preferences", "what must never be forgotten", "before making plans for the user"],
  },
  goals: {
    id: "profile-personal-goals",
    title: "Profile: current goals",
    type: "project-fact",
    tags: ["profile", "onboarding", "goals"],
    recall_when: ["what is the user working toward", "goal context for advice or planning"],
  },
  freeform: {
    id: "profile-about-me",
    title: "Profile: about me (self-described)",
    type: "user-preference",
    tags: ["profile", "onboarding"],
    recall_when: ["session start — who is the user", "general context about the user", "what did the user say about themselves"],
  },
};

function clip(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Persona choice + answers → ready-to-save memories. Always includes the
 * usage-profile memory (what this vault is for — the signal future surfaces
 * like the Bastra app can tailor to); one memory per non-empty answer.
 */
export function buildOnboardingMemories(persona: Persona, answers: Record<string, string>): SaveMemoryInput[] {
  const out: SaveMemoryInput[] = [
    {
      id: "profile-recall-usage",
      title: "Profile: what this vault is for",
      type: "user-preference",
      scope: "user-preference",
      summary: `The user's memory profile: ${PERSONA_LABELS[persona]}.`,
      body: `**${PERSONA_LABELS[persona]}** (persona: ${persona})\n\nChosen during onboarding — the primary lens for what this vault should hold and how features should be tailored.`,
      topic_path: ["profile", "usage"],
      tags: ["profile", "onboarding", "persona"],
      recall_when: ["what does the user use this memory for", "tailoring features to the user's persona", "session start context"],
      write_origin: "user-directed",
      overwrite: true,
    },
  ];
  for (const q of questionsFor(persona)) {
    const answer = (answers[q.id] ?? "").trim();
    if (!answer) continue;
    const t = TEMPLATES[q.id];
    out.push({
      id: t.id,
      title: t.title,
      type: t.type,
      scope: "user-preference",
      summary: clip(answer, 240),
      body: answer + (t.note ? `\n\n*${t.note}*` : ""),
      topic_path: ["profile", q.id],
      tags: t.tags,
      recall_when: t.recall_when,
      write_origin: "user-directed",
      overwrite: true,
    });
  }
  return out;
}

/**
 * `{ persona, answers }` from untrusted input — the map's POST body or the
 * `bastra onboard --answers` file (#645). Persona must be one of PERSONAS;
 * only string (or number) answers are kept (unknown ids are dropped later by
 * buildOnboardingMemories, which walks the persona's catalog).
 */
export function parseOnboardingAnswers(
  body: unknown,
): { persona: Persona; answers: Record<string, string> } | { error: string } {
  const b = (typeof body === "object" && body !== null ? body : {}) as { persona?: unknown; answers?: unknown };
  const persona = typeof b.persona === "string" && (PERSONAS as readonly string[]).includes(b.persona)
    ? (b.persona as Persona)
    : null;
  if (!persona) return { error: `persona required — one of: ${PERSONAS.join(", ")}` };
  const answers: Record<string, string> = {};
  if (typeof b.answers === "object" && b.answers !== null) {
    for (const [k, v] of Object.entries(b.answers as Record<string, unknown>)) {
      // A YAML answers file reads `conventions_size: 500` as a number.
      if (typeof v === "string") answers[k] = v;
      else if (typeof v === "number" && Number.isFinite(v)) answers[k] = String(v);
    }
  }
  return { persona, answers };
}

export type OnboardingSurface ="ui:onboarding" | "cli:onboard";

/**
 * Save one interview as one user-authored audit run, regardless of surface.
 *
 * `user` describes who supplied the answers, not which process wrote the
 * files. One UUID groups the whole interview; `surface` preserves whether it
 * came through the UI or CLI. A real memory-write failure stops onboarding,
 * while `recordAudit` absorbs an audit-only failure after the write lands.
 */
export async function saveOnboardingMemories(
  vaultPath: string,
  memories: SaveMemoryInput[],
  surface: OnboardingSurface,
): Promise<void> {
  // Keep this outside the loop: per-memory UUIDs would destroy batch
  // reconstruction even though every individual audit entry looked valid.
  const runId = randomUUID();
  for (const memory of memories) {
    await saveMemoryWithAuditTrail({
      vaultRoot: vaultPath,
      input: memory,
      actor: "user",
      actorDetail: surface,
      sessionId: runId,
    });
  }
}

/**
 * Konventions-Antworten in die cli-settings spiegeln, damit deterministische
 * Checks sie nutzen: der Dateigrößen-Richtwert (conventions_size) speist den
 * file-size-check im PreToolUse-Hook. Erste Zahl in der Antwort zählt
 * (clamp 100..5000); keine Zahl → keine Änderung. Best-effort — ein
 * Settings-Fehler bricht nie ein Onboarding ab.
 */
export async function persistConventionSettings(
  answers: Record<string, string>,
  settingsPath?: string,
): Promise<void> {
  const raw = (answers.conventions_size ?? "").trim();
  if (!raw) return;
  const m = /\d{2,5}/.exec(raw.replace(/[.,](?=\d{3}\b)/g, ""));
  if (!m) return;
  const n = Math.min(5000, Math.max(100, Number(m[0])));
  try {
    await setSizeGuide(n, settingsPath);
  } catch {
    /* settings write is best-effort */
  }
}

/**
 * Sprachnamen → ISO-639-1. Lateinische Namen (inkl. Eigen- und deutscher
 * Bezeichnung) matchen an Unicode-Wortgrenzen, damit z.B. "german" nicht in
 * einem größeren Token feuert; script-spezifische Namen (Kyrillisch/CJK/Hangul)
 * matchen als bloßer Substring — sie tauchen nicht zufällig in anderem Text auf.
 */
const LANGUAGE_NAME_HINTS: ReadonlyArray<{ code: string; latin: string[]; script?: string[] }> = [
  { code: "de", latin: ["deutsch", "german"] },
  { code: "en", latin: ["englisch", "english"] },
  { code: "ru", latin: ["russisch", "russian"], script: ["русский"] },
  { code: "fr", latin: ["französisch", "franzoesisch", "french", "français", "francais"] },
  { code: "es", latin: ["spanisch", "spanish", "español", "espanol"] },
  { code: "it", latin: ["italienisch", "italian", "italiano"] },
  { code: "pt", latin: ["portugiesisch", "portuguese", "português", "portugues"] },
  { code: "pl", latin: ["polnisch", "polish", "polski"] },
  { code: "nl", latin: ["niederländisch", "niederlaendisch", "dutch", "nederlands"] },
  { code: "ja", latin: ["japanisch", "japanese"], script: ["日本語"] },
  { code: "zh", latin: ["chinesisch", "chinese"], script: ["中文"] },
  { code: "ko", latin: ["koreanisch", "korean"], script: ["한국어"] },
];

/** First explicitly named language in `text` → its ISO code (earliest mention wins), or null. */
function explicitLanguage(text: string): string | null {
  const hay = text.toLowerCase();
  let bestCode: string | null = null;
  let bestPos = Infinity;
  for (const hint of LANGUAGE_NAME_HINTS) {
    let pos = -1;
    for (const name of hint.latin) {
      const m = new RegExp(`(?<![\\p{L}])${name}(?![\\p{L}])`, "u").exec(hay);
      if (m && (pos < 0 || m.index < pos)) pos = m.index;
    }
    for (const name of hint.script ?? []) {
      const i = hay.indexOf(name.toLowerCase());
      if (i >= 0 && (pos < 0 || i < pos)) pos = i;
    }
    if (pos >= 0 && pos < bestPos) {
      bestPos = pos;
      bestCode = hint.code;
    }
  }
  return bestCode;
}

/**
 * User-Sprache aus den Onboarding-Antworten in die cli-settings spiegeln (#231,
 * Language-first recall): Der Session-Hook weist den Agenten dann an, Memories in
 * dieser Sprache zu verfassen. Primär zählt eine explizit in der identity-Antwort
 * genannte Sprache ("Deutsch, Du-Form" → de); fällt das aus, greift die
 * heuristische Detection über den zusammengefügten Text ALLER Antworten (liefert
 * nur de/en). Kein eindeutiges Signal → nichts schreiben. Best-effort — ein
 * Settings-Fehler bricht nie ein Onboarding ab.
 */
export async function persistLanguageSetting(
  answers: Record<string, string>,
  settingsPath?: string,
): Promise<void> {
  const identity = (answers.identity ?? "").trim();
  let code = identity ? explicitLanguage(identity) : null;
  if (!code) {
    const all = Object.values(answers).join(" \n ").trim();
    if (all) code = detectLanguage(all).lang;
  }
  if (!code) return;
  try {
    await setPrimaryLanguage(code, settingsPath);
  } catch {
    /* settings write is best-effort */
  }
}

export async function isOnboardingDone(vaultPath: string): Promise<boolean> {
  try {
    await readFile(join(vaultPath, ONBOARD_MARKER), "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function markOnboardingDone(vaultPath: string, via: string): Promise<void> {
  await writeFile(
    join(vaultPath, ONBOARD_MARKER),
    `onboarded ${new Date().toISOString().slice(0, 10)} via ${via}\n`,
    "utf8",
  );
}

export async function isOnboardingNeeded(vaultPath: string, vaultSize: number): Promise<boolean> {
  if (vaultSize >= FRESH_VAULT_MAX) return false;
  return !(await isOnboardingDone(vaultPath));
}

/** GET /hook/onboarding — loopback-only, NOT ui-gated (the session hook
 *  needs it regardless of whether the map is enabled). */
export async function handleHookOnboarding(
  res: ServerResponse,
  vaultPath: string,
  vaultSize: number,
): Promise<void> {
  sendJsonPlain(res, 200, { needed: await isOnboardingNeeded(vaultPath, vaultSize) });
}

/**
 * GET/POST /ui/onboarding — the map's onboarding dialog. GET returns the
 * catalog + whether the dialog should auto-open; POST saves the answers as
 * user-directed memories (or just sets the marker on {skip:true}).
 */
export async function handleUiOnboarding(
  req: IncomingMessage,
  res: ServerResponse,
  vaultPath: string,
  vaultSize: number,
  settingsPath?: string,
): Promise<void> {
  if (!(await getUiEnabled(settingsPath))) {
    sendJsonPlain(res, 404, { error: "ui disabled" });
    return;
  }
  if (req.method === "GET") {
    sendJsonPlain(res, 200, {
      needed: await isOnboardingNeeded(vaultPath, vaultSize),
      personas: PERSONAS.map((p) => ({ id: p, label: PERSONA_LABELS[p] })),
      questions: QUESTIONS,
    });
    return;
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 256 * 1024) {
      sendJsonPlain(res, 413, { error: "body too large" });
      return;
    }
  }
  let body: { persona?: unknown; answers?: unknown; skip?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    sendJsonPlain(res, 400, { error: "invalid JSON body" });
    return;
  }
  if (body.skip === true) {
    await markOnboardingDone(vaultPath, "map (skipped)");
    sendJsonPlain(res, 200, { saved: 0, skipped: true });
    return;
  }
  const parsed = parseOnboardingAnswers(body);
  if ("error" in parsed) {
    sendJsonPlain(res, 400, { error: parsed.error });
    return;
  }
  const { persona, answers } = parsed;
  const memories = buildOnboardingMemories(persona, answers);
  // Keep the completion marker after this call: a real write failure must
  // leave onboarding retryable instead of recording a partial interview as done.
  await saveOnboardingMemories(vaultPath, memories, "ui:onboarding");
  await persistConventionSettings(answers, settingsPath);
  await persistLanguageSetting(answers, settingsPath);
  await markOnboardingDone(vaultPath, "map");
  sendJsonPlain(res, 200, { saved: memories.length, skipped: false });
}
