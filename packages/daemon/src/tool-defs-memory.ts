/**
 * MCP tool definitions for the memory tools — name, description, input schema.
 *
 * Split out of tool-handlers.ts (#239 follow-up): 436 lines of pure
 * declaration sitting on top of the handler logic. Nothing here executes;
 * keeping it beside the code it describes only made both harder to read.
 *
 * The descriptions are part of the product surface: they are what an agent
 * reads to decide whether to call a tool at all, so they carry the same weight
 * as the SKILL instructions and must not drift from the actual behaviour.
 */

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** MCP tool annotations. readOnlyHint groups the read tools into the
   *  bulk-approvable "Read-only tools" permission category in clients like
   *  Claude Desktop — the one server-side lever against approval friction. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** Read tools: no vault mutation, safe to run unsupervised. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false } as const;

export const MEMORY_TOOL_DEFS: ToolDef[] = [
  {
    name: "recall",
    annotations: READ_ONLY,
    description:
      "Search the memory vault. Returns top-k matching memorys " +
      "(id, title, type, scope, summary, score). " +
      "\n\n" +
      "WHEN TO CALL (recall is part of acting, not a separate step):\n" +
      "- At session start (once): query for active-project + " +
      "user-preferences to load durable context.\n" +
      "- Before writing/editing a file: query with a description of " +
      "what you are about to write (e.g. 'creating React input with " +
      "focus styles'). This catches lessons before mistakes.\n" +
      "- Before giving a multi-step plan or recommendation: query for " +
      "preferences that shape format/scope.\n" +
      "- When the user's prompt touches a topic that may have a stored " +
      "lesson, decision, preference, or project-fact.\n" +
      "- Before save_memory: query to avoid creating a duplicate.\n" +
      "\n" +
      "WHAT TO DO WITH HITS:\n" +
      "READ `score_kind` FIRST — the bands below only exist on the fused " +
      "scale.\n" +
      "- `score_kind: \"rrf\"` (fused rank sum, bounded): score >= ~100 with " +
      "title/recall_when match: load_memory and apply the lesson before " +
      "acting. score 30-100: read the summary, load if directly relevant. " +
      "score < 30: usually noise; skip unless the summary is a perfect " +
      "topic match.\n" +
      "- `score_kind: \"bm25\"` (also flagged `unfused: true`): the vector " +
      "arm did not run — no embedding model, a cold-start timeout, or an " +
      "open circuit breaker (`degraded` names which). These are raw " +
      "MiniSearch scores on an OPEN scale — six figures on a real vault — " +
      "so 100 means nothing here and every hit would look REQUIRED. Judge " +
      "those hits by title, summary and recall_when match, and by their " +
      "ORDER, never by the number.\n" +
      "Never ignore a `lesson` hit with strong recall_when match.\n" +
      "Two scores are comparable only within the same `score_arms` (and the " +
      "same `score_version`): the fused scale reaches 163.934 with the two " +
      "personal arms and 241.803 once the Bastra Commons contribute a third. " +
      "A batch response whose phrasings disagreed on that reports " +
      "`merged_by: \"query-rank-fusion\"` and drops back to `unfused` — its " +
      "order is meaningful, its numbers are not a band.\n" +
      "On the hybrid (BM25 + vector) path the score is a scaled rank sum, " +
      "not a similarity — a top hit is high by construction. When the " +
      "response carries top-level `weak_result: true`, no returned hit has " +
      "a recall_when or title match: the high scores are likely " +
      "rank-1-of-nothing, so prefer not to load them.\n" +
      "\n" +
      "recall returns lean CANDIDATES (no bodies). This is step 1 of a " +
      "two-step flow: call load_memory ONLY for the hits you actually " +
      "need — do not load every hit.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural-language query OR a description of what you are " +
            "about to do (e.g. 'creating new input component', " +
            "'about to give a multi-option plan'). Ask the vault what " +
            "only memory can answer — durable preferences, lessons, " +
            "decisions, past facts, documents. Do NOT query for what is " +
            "already in the prompt or an upload, or findable by reading " +
            "the project's files and logs: recall is memory, not a " +
            "search over the current context. Decide what you are " +
            "looking for, then phrase THAT. For several angles in one " +
            "turn, use `queries` instead.",
        },
        queries: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 4,
          description:
            "#351 batch mode — 2-4 DISTINCT queries, ONE round trip. Each " +
            "entry carries exactly ONE intent: either a real paraphrase of " +
            "the same question in different vocabulary, or a cleanly " +
            "separated sub-question. Never pack several concepts from a " +
            "convoluted prompt into one query, and never send re-mixes of " +
            "the same words — near-duplicates are collapsed server-side " +
            "before searching and waste the batch. Use this instead of " +
            "firing several recall calls in the same turn: results are " +
            "merged (deduped, best score per hit), so the score bands " +
            "above stay valid. Pass query OR queries, not both.",
        },
        k: {
          type: "number",
          description: "Max results (default 5, range 1-20).",
        },
        max_tokens: {
          type: "number",
          description:
            "Optional context budget for THIS call, in estimated tokens " +
            "(~4 characters each). Hits are emitted in rank order until the " +
            "payload would exceed it; the rest are dropped and the response " +
            "says so with `truncated_by_budget: true` and " +
            "`dropped_by_budget: <n>`. Use it when you know how much window " +
            "you can spend — `k` counts results, not context, and a k=5 " +
            "answer varies by more than 2x in size. `k` stays the hard upper " +
            "bound: this can only drop hits, never add them. Leave unset for " +
            "no budget. If the response comes back truncated, re-query with " +
            "a larger budget or load_memory the ids you need.",
        },
        scope: {
          type: "string",
          description:
            "Optional exact-match filter, e.g. 'carnexus', " +
            "'user-preference', 'all-projects'.",
        },
        type: {
          type: "string",
          description:
            "Optional exact-match filter on memory type, e.g. 'lesson', " +
            "'preference', 'project-fact'.",
        },
        verbosity: {
          type: "string",
          enum: ["lean", "full"],
          description:
            "'lean' (default) returns id, title, type, scope, summary, " +
            "score per hit. 'full' adds matched_terms, mode, hop, " +
            "topic_path and the stages timing block — for debugging / the " +
            "Mac-App. Leave unset to keep the context footprint small.",
        },
        min_score: {
          type: "number",
          description:
            "Drop hits below this score (default 30). On the hybrid " +
            "(BM25 + vector) path the score is a scaled reciprocal-rank " +
            "sum, not a content similarity: the bands describe how much " +
            "the two arms agree on rank (~164 = rank 1 in both arms, ~82 " +
            "= rank 1 in one arm only), so a top hit is high by " +
            "construction and the 30 floor practically only bites in " +
            "BM25-only mode (no embeddings). Raise it to require stronger " +
            "rank agreement; see the top-level `weak_result` flag for a " +
            "no-match signal.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "load_memory",
    annotations: READ_ONLY,
    description:
      "Load the content (frontmatter + body) of a single memory by id. " +
      "Step 2 of the recall flow — call this only for the candidates " +
      "recall() surfaced that you actually need. Returns essential " +
      "frontmatter + body by default; pass verbosity:'full' for the raw " +
      "frontmatter (related_via cosines, source, …). " +
      "The result carries a `revision` — hand it to " +
      "edit_memory({ expected_revision }) to have your change refused if the " +
      "memory moved on meanwhile (#519).",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Memory id (the slug, no .md extension).",
        },
        verbosity: {
          type: "string",
          enum: ["lean", "full"],
          description:
            "'lean' (default) returns essential frontmatter + body without " +
            "the auto-related block. 'full' returns the complete frontmatter " +
            "and raw body — for debugging / the Mac-App.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "save_memory",
    description:
      "Persist a new memory into the vault as a markdown file with YAML " +
      "frontmatter. This is YOUR long-term memory — save autonomously " +
      "when a memory-worthy moment occurs, do not wait to be asked.\n" +
      "\n" +
      "STRONG SIGNALS — save without confirmation, then 1-line ack. " +
      "The cues below are EXAMPLES in whatever language the user writes: " +
      "match the situation, not the sample words (#476).\n" +
      "- User expresses repetition/frustration about a recurring issue " +
      "  ('again', 'wieder', 'снова', 'how often', emphatic caps in any " +
      "  script) → lesson, emotion:'frustration', salience:0.8\n" +
      "- User states an explicit durable rule ('always X', 'never Y', " +
      "  'on this project we use Z') → preference / workflow\n" +
      "- User corrects a recurring tendency in your behavior → " +
      "  meta-working\n" +
      "- An architectural decision is finalized after weighing options " +
      "  → decision\n" +
      "- User confirms a workflow ('let's always do it this way') → " +
      "  workflow\n" +
      "- A bug got fixed after >2 iterations with non-obvious root " +
      "  cause → lesson (capture the FAILED PATH too, not just the fix), " +
      "  emotion:'success', salience:0.7\n" +
      "- User marks something as important ('this is important', " +
      "  'remember that') → salience:0.9 on the memory you save\n" +
      "\n" +
      "VALENCE (#217): salience/emotion mark how emotionally charged the " +
      "capture moment was — high salience ages slower and may rank higher. " +
      "Set them ONLY when a capture rule above fires or the user marks " +
      "importance; never invent them. Omit both for routine saves.\n" +
      "\n" +
      "ANTI-SIGNALS — do NOT save:\n" +
      "- One-off task descriptions ('please build me X') — that's a " +
      "  task, not a memory\n" +
      "- Speculation, 'maybe' statements, tentative ideas\n" +
      "- Anything derivable from code/git/CLAUDE.md\n" +
      "- Sensitive personal data (unless a stable preference)\n" +
      "- When unsure: default to NOT saving. False saves erode trust.\n" +
      "\n" +
      "ADMISSION RULES — memories that were true once quietly poison " +
      "later behavior:\n" +
      "- NO negative capability claims ('X tool is broken', 'Y does not " +
      "  work') — they harden into standing refusals that outlive the " +
      "  problem. If something failed due to setup state, capture the FIX " +
      "  (install step, config, env var), never the failure as a constraint.\n" +
      "- NO stale-in-7-days artifacts: task progress, PR numbers, " +
      "  'phase N done' belong in git/issues, not in memory.\n" +
      "- Declarative facts, not self-directives: 'User prefers concise " +
      "  replies' ✓ — 'Always reply concisely' ✗. Imperative phrasing " +
      "  gets re-read as a directive in unrelated later contexts.\n" +
      "\n" +
      "BEFORE SAVING: call recall() with the title/topic to check for " +
      "an existing memory you should update (overwrite=true) instead " +
      "of creating a duplicate.\n" +
      "\n" +
      "THE CLAIM GATE: a save whose recall_when declares a situation " +
      "another memory already declares is HELD — nothing is written, and " +
      "the result carries `claim_gate` naming that memory, both triggers, " +
      "ITS BODY, and `delta.new_terms` — the content words your text would " +
      "add to it. Read that first: if your save adds nothing (empty " +
      "new_terms, or only filler words), DROP it — say the memory already " +
      "covers it, do not link it, do not re-send. If it adds a real fact " +
      "that belongs there, do not create a second memory: re-save THAT one " +
      "with overwrite=true, its id, and a body carrying its existing " +
      "content plus your addition. Only a genuinely separate memory needs " +
      "one of the three links. Two memories answering one cue is a " +
      "successor, a contradiction, or a deliberate pair, and only you can " +
      "tell which. " +
      "Re-send the save with `replaces: <id>` (the older one is out of " +
      "date), `conflict_with: <id>` (both current, incompatible), or " +
      "`sibling_of: [<id>]` (different entities that share wording and " +
      "both apply forever) — or narrow this save's recall_when so it stops " +
      "claiming their situation. Never re-send it unchanged: the gate is " +
      "deterministic and will hold it again. Writing sharp, situation-" +
      "specific triggers in the first place is what keeps this rare.\n" +
      "\n" +
      "QUALITY BARS:\n" +
      "- Title: short, specific, non-generic.\n" +
      "- Summary: one sentence, aim ~250-300 chars, core gist in the first " +
      "  160 (the lean-recall snippet). Hard cap 400 — over-long is " +
      "  auto-truncated at a word boundary, never rejected; still keep it short.\n" +
      "- Body: lead with the rule/fact, then **Why:** (root cause / " +
      "  reason / incident) and **How to apply:** (when this kicks in). " +
      "  For lessons, capture the failure path AND the fix.\n" +
      "- recall_when (CRITICAL — highest-weighted search field): 2-4 " +
      "  CONCRETE contexts/queries where future-you should be reminded. " +
      "  'about to write a Tailwind grid' beats 'CSS questions'. Without " +
      "  good recall_when, the memory is dead weight.\n" +
      "- Language: author title, summary and recall_when in the user's " +
      "  primary language (settings language.primary / the injected " +
      "  <memory-language> block); keep only genuine English tech terms " +
      "  (daemon, deploy, hook, …) as anchors — this mixed style carries " +
      "  cross-lingually.\n" +
      "\n" +
      "TAXONOMY CONVENTIONS (self-learning vault structure):\n" +
      "- The vault can teach itself new categories. A convention is a " +
      "  memory in the reserved scope 'taxonomy' that names a cluster " +
      "  and fixes its axes: folder, topic_path shape, tags, body shape.\n" +
      "- BEFORE saving into a recurring cluster (people, places, tools, " +
      "  …): recall('taxonomy convention <cluster>') — if a convention " +
      "  exists, FOLLOW it exactly (its folder/topic_path/tags), do not " +
      "  invent variant tags that fragment recall.\n" +
      "- When you notice the same ad-hoc cluster for the third time " +
      "  without a convention, establish one: save a memory with " +
      "  scope='taxonomy', tag 'convention', body = the rule (axes + " +
      "  folder + body shape + one example), then apply it. Use the " +
      "  `folder` arg so members get a real home (e.g. 'memories/people').\n" +
      "- Re-filing: overwrite=true with a new folder MOVES the memory " +
      "  (old file goes to the vault trash) — use this to migrate " +
      "  existing memories under a new convention.\n" +
      "\n" +
      "AFTER SAVING: surface a single-line ack to the user, prefixed " +
      "with `→`: `→ saved: <title> (id: <id>)`. Nothing more.\n\n" +
      "CALL FORMAT: send every argument as its own native JSON property. " +
      "Never embed XML tags such as <body> or <topic_path> inside summary.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: {
          type: "string",
          description: "Short, specific title (becomes the slug/id).",
        },
        type: {
          type: "string",
          enum: [
            "lesson",
            "preference",
            "project-fact",
            "meta-working",
            "decision",
            "workflow",
            "reference",
            "user-preference",
          ],
          description:
            "Memory type. Use 'lesson' for fixes/gotchas, 'preference' " +
            "for project-scoped style choices, 'user-preference' for " +
            "the human's cross-project preferences, 'project-fact' for " +
            "non-derivable project state, 'decision' for committed " +
            "design decisions, 'workflow' for recurring procedures.",
        },
        summary: {
          type: "string",
          description:
            "One sentence capturing the gist — appears in recall() hits. " +
            "Aim ~250-300 chars; put the core in the first 160 (shown in lean " +
            "recall). Over 400 is auto-truncated at a word boundary, never " +
            "rejected.",
        },
        body: {
          type: "string",
          description:
            "Full markdown body. Lead with the rule/fact, then explain " +
            "*why* (the reason/incident) and *how to apply* (when this " +
            "kicks in). Wikilinks like [[other-memory-id]] are supported.",
        },
        topic_path: {
          type: "array",
          items: { type: "string" },
          description:
            "Hierarchical topic path, e.g. ['bastra-recall','search','ranking'].",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Flat tags for filtering, at least one.",
        },
        scope: {
          type: "string",
          description:
            "Project/area this memory belongs to, e.g. 'bastra-recall', " +
            "'carnexus', 'user-preference', 'all-projects'. The scope " +
            "'taxonomy' is reserved for convention memories (self-learned " +
            "vault structure rules).",
        },
        folder: {
          type: "string",
          description:
            "Optional target folder relative to the vault root (e.g. " +
            "'memories/people'). Overrides the default scope/type routing — " +
            "use it when a taxonomy convention assigns this cluster a home. " +
            "With overwrite=true a changed folder MOVES the memory (old " +
            "file is trashed, recoverable).",
        },
        recall_when: {
          type: "array",
          items: { type: "string" },
          description:
            "Trigger phrases — situations where this memory should " +
            "surface. Highest-weighted search field. Be specific: " +
            "'about to write a Tailwind grid', not 'CSS questions'. " +
            "Do NOT restate the summary here: this field is indexed at " +
            "weight 5 and the summary already at weight 2, so a copy " +
            "spends the strongest signal on text that is indexed anyway. " +
            "Name the situation, not the content.",
        },
        verify_cmd: {
          type: "string",
          description:
            "Optional anchor command that could PROVE this memory's claim — " +
            "'test -f packages/daemon/src/reflex.ts', 'curl -s localhost:6723/health'. " +
            "Worth adding on a project-fact that asserts a state of the world, because " +
            "those age silently into false statements that keep being recalled as true. " +
            "Nothing ever runs it automatically: it is stored and shown to whoever loads " +
            "the memory, who decides under their own permission rules. Leave it out unless " +
            "the claim is genuinely checkable by one short command.",
        },
        replaces: {
          type: "string",
          description:
            "Id of the memory this one is the new VERSION of. Use it when a " +
            "fact changed and the old wording is now wrong — not for a memory " +
            "that is merely similar (link those with [[wikilinks]] instead). " +
            "The predecessor stays in the vault and stays loadable by its id: " +
            "it becomes a previous version, not a deleted one, and both sides " +
            "of the link are recorded. To retire a memory entirely, that is " +
            "archive_memory — a different thing.",
        },
        conflict_with: {
          type: "string",
          description:
            "Id of an existing memory this save CONTRADICTS (incompatible " +
            "claim on the same fact — not a mere near-duplicate: those are " +
            "overwrite or [[wikilink]] cases). The save is then diverted: " +
            "nothing new is created and nothing is overwritten — a visible " +
            "conflict block carrying both claims lands in the existing " +
            "memory, and its recall hits carry `conflict: true` until " +
            "someone resolves it. Resolve by deciding with the user which " +
            "claim stands, then re-saving that memory with overwrite=true.",
        },
        sibling_of: {
          type: "array",
          items: { type: "string" },
          description:
            "Ids this memory deliberately stands BESIDE. Answer to the claim " +
            "gate: when a save's recall_when declares a situation another " +
            "memory already declares, the save is held and nothing is " +
            "written. Three things resolve it — replaces (the older one is " +
            "out of date), conflict_with (both current, incompatible), or " +
            "this field, for several entities that are permanently valid at " +
            "once and only share wording (one memo per contributor, one per " +
            "project). Use it only when both really do apply forever; " +
            "quittances accumulate, so a pair is never asked about twice.",
        },
        related: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional ids of related memories. Hinweis: `[[id]]`-Wikilinks " +
            "im body werden automatisch ins related[] gespiegelt — du musst " +
            "sie hier nicht doppelt aufzählen.",
        },
        sensitivity: {
          type: "string",
          enum: ["private", "team", "public"],
          description:
            "Wer darf das Memory sehen? Default 'team' (lokale KI-Tools). " +
            "'private' = nur Mac-App (für externe Caller nicht sichtbar).",
        },
        valid_until: {
          type: "string",
          description:
            "Explizites Ablaufdatum (YYYY-MM-DD). Überschreibt expires_after_days.",
        },
        expires_after_days: {
          type: "number",
          description:
            "Tage nach 'updated', ab denen das Memory altert/expires. " +
            "Überschreibt den Type-Default (lesson=180, decision=365, …).",
        },
        last_reviewed_at: {
          type: "string",
          description:
            "ISO-Datum des letzten 'noch aktuell'-Checks. Resetet Staleness.",
        },
        affects_files: {
          type: "array",
          items: { type: "string" },
          description:
            "Optionale Liste von Repo-Pfaden, die diese Lesson/Decision betrifft.",
        },
        issues: {
          type: "array",
          items: { type: "string" },
          description:
            "Optionale Liste verknüpfter Issue-IDs (z.B. '#42').",
        },
        source: {
          type: "string",
          description:
            "Optional provenance, e.g. 'Daniel, 2026-05-01 after retro'.",
        },
        confidence: {
          type: "number",
          description:
            "0-1, default 1. Lower if the lesson is tentative.",
        },
        salience: {
          type: "number",
          description:
            "0-1 (#217): how emotionally charged the capture moment was. " +
            "Set ONLY when a capture rule fires (frustration 0.8, hard-won " +
            "fix 0.7, 'merk dir das gut' 0.9). High salience ages slower. " +
            "Omit for routine saves. On overwrite without this field, the " +
            "existing value is preserved.",
        },
        emotion: {
          type: "string",
          enum: ["frustration", "success", "risk", "neutral"],
          description:
            "Tone of the capture moment (#217): 'frustration' (recurring " +
            "pain), 'success' (hard-won fix), 'risk' (near-miss / danger), " +
            "'neutral'. Only alongside salience. On overwrite without this " +
            "field, the existing value is preserved.",
        },
        recall_mode: {
          type: "string",
          enum: ["reflex", "deliberate"],
          description:
            "#217: 'reflex' lets this memory self-inject (budgeted) when a " +
            "recall_when trigger hard-matches a prompt — set 'reflex' ONLY " +
            "after the user explicitly confirmed a promotion, never " +
            "autonomously. Absent = 'deliberate'. On overwrite without this " +
            "field, the existing value is preserved.",
        },
        id: {
          type: "string",
          description:
            "Optional explicit id/slug. Default: slugified title.",
        },
        overwrite: {
          type: "boolean",
          description:
            "If true, replace an existing memory with the same id. " +
            "Default false (errors on collision).",
        },
        write_origin: {
          type: "string",
          enum: ["user-directed", "agent-session", "capture-review"],
          description:
            "Provenance (#158): set 'user-directed' ONLY when the human " +
            "explicitly asked to remember this ('merk dir das') — such " +
            "memories are exempt from automated lifecycle passes (curator, " +
            "consolidation). Omit otherwise: 'agent-session' is the default " +
            "for autonomous saves. On overwrite without this field, the " +
            "existing provenance is preserved.",
        },
      },
      required: [
        "title",
        "type",
        "summary",
        "body",
        "topic_path",
        "tags",
        "scope",
        "recall_when",
      ],
    },
  },
  {
    name: "edit_memory",
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      "#519 — change PART of an existing memory without re-sending it. " +
      "Use this for every ordinary update: a one-line addendum, a corrected " +
      "sentence, a sharpened summary or an extra trigger. " +
      "\n\n" +
      "NEVER edit a vault .md file directly. A direct file edit skips the " +
      "audit log, the `updated` stamp, the id lock, the atomic write and the " +
      "index refresh — the change becomes unreconstructable and can be " +
      "silently undone by a parallel writer or the cloud sync. This tool is " +
      "the cheap, correct way; there is no longer a reason to take the other " +
      "one.\n" +
      "Use save_memory(overwrite: true) only when the memory is rewritten as " +
      "a whole, or when you need a field this tool does not cover.\n" +
      "\n" +
      "OPERATIONS (combine freely, they apply as ONE atomic change):\n" +
      "- str_replace: old_str -> new_str in the body. old_str must occur " +
      "EXACTLY ONCE; if it is missing or ambiguous NOTHING is written and the " +
      "error says which of the two it was. Copy the text verbatim from " +
      "load_memory, whitespace included.\n" +
      "- append: add text at the end of the body (it lands before the " +
      "auto-related block, never inside it).\n" +
      "- frontmatter: patch summary, recall_when, tags, issues, related, " +
      "confidence or valid_until. Nothing else — id, scope, type, sensitivity " +
      "and write_origin are rejected here and belong to save_memory or a " +
      "dedicated tool.\n" +
      "\n" +
      "expected_revision is optional optimistic concurrency: pass the " +
      "`revision` load_memory gave you, and the edit is refused if the file " +
      "changed meanwhile — by another edit or by a hand edit in Obsidian. " +
      "Do NOT pass the `updated` stamp: it has day precision, so two edits on " +
      "the same day share it and the later one would silently win (#519).",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Id of the memory to change. It must already exist.",
        },
        str_replace: {
          type: "object",
          description:
            "Replace one unique passage in the body. Nothing is written when " +
            "old_str is missing or occurs more than once.",
          properties: {
            old_str: {
              type: "string",
              description:
                "The exact existing text, copied verbatim (including line " +
                "breaks). Must occur exactly once in the body.",
            },
            new_str: {
              type: "string",
              description: "What replaces it. Empty string deletes the passage.",
            },
          },
          required: ["old_str", "new_str"],
        },
        append: {
          type: "string",
          description:
            "Text appended to the end of the body — the cheap way to add an " +
            "addendum to a long memory without re-sending it.",
        },
        frontmatter: {
          type: "object",
          description:
            "Patch for a small whitelist of fields. Any other key is " +
            "REJECTED (not silently ignored).",
          properties: {
            summary: { type: "string" },
            recall_when: { type: "array", items: { type: "string" } },
            tags: { type: "array", items: { type: "string" } },
            issues: { type: "array", items: { type: "string" } },
            related: { type: "array", items: { type: "string" } },
            confidence: { type: "number" },
            valid_until: { type: "string" },
          },
        },
        expected_revision: {
          type: "string",
          description:
            "The `revision` load_memory returned for this memory — an opaque " +
            "digest of the file, new after every write. The edit is refused " +
            "if the file no longer carries it. Omit to edit the current state.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "archive_memory",
    annotations: { readOnlyHint: false, destructiveHint: true },
    description:
      "Move a memory into the vault trash (recoverable — never a hard " +
      "delete). This is the closing step of INTAKE ADOPTION: after an " +
      "imported intake memory has been converted into a full-format memory " +
      "(save_memory with real type/scope/recall_when and source: " +
      "\"migrated:<label>:<original-id>\"), archive the original so the " +
      "intake area shrinks and the vault holds ONE canonical version. " +
      "Pass superseded_by with the new memory's id — it is stamped into " +
      "the archived copy so the adoption stays auditable from both sides. " +
      "Do NOT use this as a general delete: only archive intake originals " +
      "you just adopted, or a memory the user explicitly asked to retire.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Id of the memory to archive (the intake original).",
        },
        superseded_by: {
          type: "string",
          description:
            "Id of the full-format memory that replaces it — stamped into " +
            "the archived copy (obsolete: true, superseded_by) for audit.",
        },
      },
      required: ["id"],
    },
  },
];
