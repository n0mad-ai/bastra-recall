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

import {
  VALIDATOR_INPUT,
  RULE_CATEGORIES_INPUT,
  RULEBOOK_INPUT,
  APPLIES_WHEN_INPUT,
  RULEBOOK_PROPOSED_INPUT,
} from "./tool-defs-rulebook.js";

export const MEMORY_TOOL_DEFS: ToolDef[] = [
  {
    name: "rulebook_check",
    annotations: READ_ONLY,
    description:
      "Self-report that you checked the rulebook index this round. Load applicable rules with load_memory first, then pass applicable:[IDs] or applicable:[]. " +
      "No approval, catalog receipt or action binding is required. Valid only for the caller's session, context and round. " +
      "Workers pass their own agent_id (a Claude subagent without one counts as main); without transport attribution, session_id must be the exact hook session. " +
      "task (main agent only; workers omit it) reports the workflow stage: translate-only, draft-for-review, approved-copy or none. Only this report changes the stage, never prompt wording. " +
      "A self-report may be wrong and proves neither user approval nor permission to send. " +
      "Validators size-check fences and quotes in every stage, ordinary prose only in approved-copy and only in the final assistant text; unmarked long prose without approved-copy is not measured (#1351). Declared validators also check oversized fenced/quoted copy without a task. " +
      "approved-copy needs a validation receipt, bound to task and generation, not proof of later delivered bytes (#1325). " +
      "When the round handles correspondence (reported stage, measured copy under an applied validator, or a native message/draft tool call), every correspondence rule needs a current-round decision: applicable ID, full load, or not_applicable with a reason of 10+ substantive characters; applicable:[] alone is not enough. " +
      'not_applicable:[{category:"correspondence",reason}] covers every unprotected correspondence rule at once, but never rules loaded or declared applicable this round, nor action-required IDs. ' +
      "An action-required ID is discharged only by loading that exact rule or by not_applicable:[{id,reason}] for it (audited, counted as a visible exception); other attempts are ignored and counted as violations, the rest of the check stays valid. " +
      "Prior-round bindings, loads and reflexes may be dismissed later; a retained stage does not replace this round's declaration. " +
      "Exceptions expire at the next user round; loads and pending action obligations keep their own lifecycle. " +
      "Codex records violations only, without same-turn length repair. Hookless clients stay advisory.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["applicable"],
      properties: {
        applicable: { type: "array", maxItems: 10000, items: { type: "string", minLength: 1 } },
        not_applicable: {
          type: "array",
          maxItems: 10000,
          items: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string", minLength: 1, maxLength: 2048 },
                  reason: { type: "string", minLength: 10, maxLength: 500 },
                },
                required: ["id", "reason"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  category: { type: "string", enum: ["correspondence"] },
                  reason: { type: "string", minLength: 10, maxLength: 500 },
                },
                required: ["category", "reason"],
              },
            ],
          },
        },
        task: { type: "string", enum: ["translate-only", "draft-for-review", "approved-copy", "none"] },
        agent_id: { type: "string", minLength: 1, maxLength: 200 },
        session_id: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
  },
  {
    name: "list_rules",
    annotations: READ_ONLY,
    description:
      "Read the complete scoped rulebook catalog, unfiltered. Returns total, catalog_hash, rule IDs/titles/applies_when, next_cursor and an end marker; " +
      "continue with the cursor until end=true (a changed catalog restarts at page one with restarted=true). " +
      "Decide applicability yourself and read bodies with load_memory(id). Unconfirmed legacy candidates are counted, never promoted. " +
      "proposals:true lists pending proposals instead. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        proposals: {
          type: "boolean",
          description: "List pending proposals instead of binding rules. Continue with proposals:true on every page.",
        },
        cursor: {
          type: "string",
          maxLength: 2048,
          description: "Opaque next_cursor from the preceding page or rulebook hook; omit for the first page.",
        },
      },
    },
  },
  {
    name: "recall",
    annotations: READ_ONLY,
    description:
      "Search the memory vault. Returns lean CANDIDATES (id, title, type, scope, summary, score, updated = day last written), no bodies: call load_memory only for the hits you need.\n\n" +
      "WHEN TO CALL (recall is part of acting, not a separate step): at session start (active project, user preferences); " +
      "before writing or editing a file (describe what you are about to write); before a multi-step plan or recommendation; " +
      "when the prompt touches a stored lesson, decision, preference or project fact; before save_memory, to avoid a duplicate.\n\n" +
      "SCORES: read `score_kind` first.\n" +
      '- "rrf" (hybrid BM25 + vector; a scaled rank sum, not a similarity, so a top hit is high by construction): >= ~100 with a title/recall_when match → load and apply before acting; 30-100 → load if the summary is directly relevant; < 30 → usually noise. ' +
      'Under `score_version: "rrf-2"` rank 1 in both arms is 163.934 (241.803 with the Bastra Commons as third arm), rank 1 in one arm only ≈ 65.6 (BM25) or 98.4 (vector); `rrf-1`: 81.967 for either. Compare scores only within the same `score_arms` and `score_version`.\n' +
      '- "bm25" (`unfused: true`; `degraded` says why the vector arm did not run): raw scores on an open scale. Judge hits by title, summary, recall_when match and order, never by the number.\n' +
      '- A batch with `merged_by: "query-rank-fusion"` is unfused too: its order counts, its numbers are no band.\n' +
      "`weak_result: true` means no hit matches by title or recall_when; prefer not to load them. " +
      '`weak_result` (like the bands) only exists on that hybrid path: without an embedding model (`score_kind: "bm25"`) it never appears, so its absence there is no sign of a match. ' +
      "Never ignore a `lesson` hit with a strong recall_when match.\n" +
      "This tool applies no evidence gate: it returns up to k hits above `min_score`. The evidence gate only filters what the hooks inject into the prompt.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What only memory can answer (preferences, lessons, decisions, past facts, documents), or what you are about to do (e.g. 'creating new input component'). Not what is already in the prompt or readable in the project's files and logs. Several angles: use `queries`.",
        },
        queries: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 4,
          description:
            "#351 batch: 2-4 DISTINCT queries in one round trip, each ONE intent (a real paraphrase or a separate sub-question). Near-duplicates are collapsed and waste the batch. Results are merged (best score per hit). Pass query OR queries.",
        },
        k: {
          type: "number",
          description: "Max results (default 5, range 1-20).",
        },
        max_tokens: {
          type: "number",
          description:
            "Optional context budget for this call (~4 characters per token). Hits are emitted in rank order until it is reached; the response then carries `truncated_by_budget: true` and `dropped_by_budget`. `k` stays the upper bound.",
        },
        scope: {
          type: "string",
          description: "Optional exact-match filter, e.g. 'carnexus', " + "'user-preference', 'all-projects'.",
        },
        type: {
          type: "string",
          description: "Optional exact-match filter on memory type, e.g. 'lesson', " + "'preference', 'project-fact'.",
        },
        verbosity: {
          type: "string",
          enum: ["lean", "full"],
          description:
            "'lean' (default): id, title, type, scope, summary, score, updated. 'full' adds matched_terms, mode, hop, topic_path and timings (debugging).",
        },
        min_score: {
          type: "number",
          description:
            "Drop hits below this score (default 30). On the hybrid path the score is a rank sum (~164 = rank 1 in both arms, ~82 = in one), so the floor mostly bites in BM25-only mode.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "load_memory",
    annotations: READ_ONLY,
    description:
      "Load one memory (frontmatter + body) by id: step 2 after recall, only for the hits you need. verbosity:'full' adds the raw frontmatter. " +
      "The result's `revision` goes to edit_memory({ expected_revision }) so a change is refused if the memory moved on (#519). " +
      "For an action-required load without transport attribution, pass the hook session_id and your worker agent_id; known transport attribution wins. " +
      "This records a full read; a lean dismissal cannot fulfil an action requirement.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", minLength: 1, maxLength: 200 },
        agent_id: { type: "string", minLength: 1, maxLength: 200 },
        id: {
          type: "string",
          description: "Memory id (the slug, no .md extension).",
        },
        verbosity: {
          type: "string",
          enum: ["lean", "full"],
          description:
            "'lean' (default): essential frontmatter + body. 'full': complete frontmatter and raw body (debugging).",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "save_memory",
    description:
      "Persist a new memory (markdown + YAML frontmatter). This is YOUR long-term memory — save autonomously when a memory-worthy moment occurs, do not wait to be asked.\n\n" +
      "STRONG SIGNALS — save without confirmation, then a 1-line ack. Match the situation in whatever language the user writes, not sample words (#476):\n" +
      "- repetition/frustration about a recurring issue ('not again', 'schon wieder', 'снова … опять', emphatic caps; the bare word 'again' alone is no signal) → lesson, emotion:'frustration', salience:0.8\n" +
      "- an explicit durable rule ('always X', 'never Y', 'on this project we use Z') → preference / workflow\n" +
      "- a correction of a recurring tendency in your behavior → meta-working\n" +
      "- a decision finalized after weighing options → decision; a confirmed workflow → workflow\n" +
      "- a bug fixed after >2 iterations with a non-obvious cause → lesson with the FAILED PATH too, emotion:'success', salience:0.7\n" +
      "- the user marks something as important → salience:0.9\n" +
      "Set salience/emotion only in these cases, never invent them (#217).\n\n" +
      "DO NOT SAVE: one-off tasks, speculation, anything derivable from code/git/CLAUDE.md, sensitive personal data unless it is a stable preference, " +
      "negative capability claims ('X is broken': capture the fix instead), short-lived progress (PR numbers, 'phase N done'). " +
      "Write declarative facts ('User prefers concise replies'), not self-directives. When unsure, do not save.\n\n" +
      "BEFORE SAVING: recall the topic and update an existing memory (overwrite=true) instead of duplicating it. " +
      "For a recurring cluster (people, places, tools) recall 'taxonomy convention <cluster>' and follow its folder/topic_path/tags. " +
      "Third time the same cluster without one: save a convention (scope 'taxonomy', tag 'convention', body = axes, folder, body shape, one example). " +
      "overwrite=true with a new `folder` moves the memory.\n\n" +
      "CLAIM GATE: a save whose recall_when claims another memory's situation is HELD and nothing is written; `claim_gate` names that memory, its body and `delta.new_terms`. " +
      "Adds nothing → drop it. Adds a fact that belongs there → re-save THAT memory with overwrite=true and the combined body. " +
      "Only a genuinely separate memory re-sends with replaces, conflict_with or sibling_of, or with a narrower recall_when — never unchanged.\n\n" +
      "QUALITY: specific title; summary one sentence, core in the first 160 characters, max 400; body leads with the rule/fact, then **Why:** and **How to apply:**; " +
      "recall_when (highest-weighted field) = 2-4 concrete situations ('about to write a Tailwind grid', not 'CSS questions'). " +
      "Title, summary and recall_when in the user's primary language (<memory-language>), keeping English tech terms.\n\n" +
      "AFTER SAVING: one line `→ saved: <title> (id: <id>)`. Send every argument as its own JSON property, never XML tags such as <body> inside summary. " +
      "session_id / agent_id: pass them when transport attribution is absent, as Stop execution evidence (main omits agent_id); they are not memory metadata.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        session_id: { type: "string", minLength: 1, maxLength: 200 },
        agent_id: { type: "string", minLength: 1, maxLength: 200 },
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
            "'lesson' fix/gotcha, 'preference' project style choice, 'user-preference' the human's cross-project preference, 'project-fact' non-derivable project state, 'decision' committed design decision, 'workflow' recurring procedure.",
        },
        summary: {
          type: "string",
          description:
            "One sentence; core in the first 160 characters (shown in lean recall). Over 400 is truncated at a word boundary.",
        },
        body: {
          type: "string",
          description:
            "Markdown. Lead with the rule/fact, then why and how to apply. [[other-memory-id]] wikilinks are supported.",
        },
        topic_path: {
          type: "array",
          items: { type: "string" },
          description: "Hierarchical topic path, e.g. ['bastra-recall','search','ranking'].",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Flat tags for filtering, at least one.",
        },
        scope: {
          type: "string",
          description:
            "Project/area, e.g. 'bastra-recall', 'user-preference', 'all-projects'. 'taxonomy' is reserved for convention memories.",
        },
        folder: {
          type: "string",
          description:
            "Optional folder relative to the vault root (e.g. 'memories/people'), overriding scope/type routing. With overwrite=true a changed folder moves the memory.",
        },
        recall_when: {
          type: "array",
          items: { type: "string" },
          description:
            "Situations where this memory should surface; the highest-weighted search field. Name the situation, not the content, and do not restate the summary.",
        },
        rulebook: RULEBOOK_INPUT,
        rule_categories: RULE_CATEGORIES_INPUT,
        applies_when: APPLIES_WHEN_INPUT,
        rulebook_proposed: RULEBOOK_PROPOSED_INPUT,
        validator: VALIDATOR_INPUT,
        verify_cmd: {
          type: "string",
          description:
            "Optional short command that proves the claim of a project-fact ('test -f src/x.ts'); for a count it must print the count. Stored and shown on load, never run automatically.",
        },
        derived_claims: {
          type: "array",
          description:
            "Optional claims copied from a file (a number, setting or sentence); each is re-checked read-only against its source when the note is loaded. Resolvers: count.markdown-numbered-list.v1 (expect = the stated count), quote.v1 (exact = the string as in the file, must occur once), sha256.v1 (expect = digest of the whole file). source is relative to the vault.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable lowercase claim id, e.g. 'failure-modes.total'." },
              resolver: {
                type: "string",
                enum: ["count.markdown-numbered-list.v1", "quote.v1", "sha256.v1"],
                description: "How the claim is re-checked against its source.",
              },
              source: { type: "string", description: "Path relative to the vault directory." },
              expect: {
                type: ["number", "string"],
                description:
                  "What the note says: the number for the count resolver, the recorded digest for sha256.v1.",
              },
              exact: {
                type: "string",
                description: "quote.v1: the string exactly as it appears in the source file.",
              },
              case_ref: {
                type: "string",
                description: "Optional stable reference to an independent case; Bastra stores it and leaves it alone.",
              },
            },
            required: ["id", "resolver", "source"],
          },
        },
        replaces: {
          type: "string",
          description:
            "Id of the memory this one is the new VERSION of (the old wording is now wrong). The predecessor stays loadable as a previous version. Not for merely similar memories, and not a delete (that is archive_memory).",
        },
        conflict_with: {
          type: "string",
          description:
            "Id of a memory this save CONTRADICTS. Nothing new is written: a conflict block with both claims lands in that memory and its hits carry `conflict: true` until the user decides and it is re-saved with overwrite=true.",
        },
        sibling_of: {
          type: "array",
          items: { type: "string" },
          description:
            "Ids this memory deliberately stands BESIDE: different entities that share wording and both apply forever (one memo per contributor). Resolves the claim gate for that pair once.",
        },
        related: {
          type: "array",
          items: { type: "string" },
          description: "Optional related ids. [[id]] wikilinks in the body are added automatically.",
        },
        sensitivity: {
          type: "string",
          enum: ["private", "team", "public"],
          description: "Who may see it: 'team' (default, local AI tools), 'private' (Mac app only), 'public'.",
        },
        valid_until: {
          type: "string",
          description: "Explicit expiry date (YYYY-MM-DD); overrides expires_after_days.",
        },
        expires_after_days: {
          type: "number",
          description:
            "Days after 'updated' until the memory ages; overrides the type default (lesson 180, decision 365, ...).",
        },
        last_reviewed_at: {
          type: "string",
          description: "ISO date of the last 'still current' check; resets staleness.",
        },
        affects_files: {
          type: "array",
          items: { type: "string" },
          description: "Optional repository paths this lesson or decision concerns.",
        },
        issues: {
          type: "array",
          items: { type: "string" },
          description: "Optional linked issue ids (e.g. '#42').",
        },
        source: {
          type: "string",
          description: "Optional provenance, e.g. 'the user, 2026-05-01 after retro'.",
        },
        confidence: {
          type: "number",
          description: "0-1, default 1. Lower if the lesson is tentative.",
        },
        salience: {
          type: "number",
          description:
            "0-1 (#217), only when a capture rule fires (frustration 0.8, hard-won fix 0.7, marked important 0.9). Kept on overwrite when omitted.",
        },
        emotion: {
          type: "string",
          enum: ["frustration", "success", "risk", "neutral"],
          description: "Tone of the capture moment (#217), only alongside salience. Kept on overwrite when omitted.",
        },
        recall_mode: {
          type: "string",
          enum: ["reflex", "deliberate"],
          description:
            "'reflex' self-injects on a hard recall_when match; set it ONLY after the user confirmed a promotion. Absent = 'deliberate'. Kept on overwrite when omitted.",
        },
        id: {
          type: "string",
          description: "Optional explicit id/slug. Default: slugified title.",
        },
        overwrite: {
          type: "boolean",
          description: "Replace an existing memory with the same id (default false: error on collision).",
        },
        write_origin: {
          type: "string",
          enum: ["user-directed", "agent-session", "capture-review"],
          description:
            "Provenance (#158): 'user-directed' ONLY when the human explicitly asked to remember this; such memories are exempt from automated lifecycle passes and can immediately bind a new rule or validator. This is the agent caller’s attestation, not authenticated proof. Omit otherwise ('agent-session'); kept on overwrite when omitted.",
        },
        body_ends_with: {
          type: "string",
          description:
            "Optional: the last ~40 characters of `body`, copied verbatim — if the body arrives truncated the save fails with nothing written (#544).",
        },
        dry_run: {
          type: "boolean",
          description:
            "Preview (#1484): true runs every check and returns the file content, save_quality, " +
            "claim gate and delivery (rule, proposal or note) — nothing is written, indexed or audited.",
        },
      },
      required: ["title", "type", "summary", "body", "topic_path", "tags", "scope", "recall_when"],
    },
  },
  {
    name: "edit_memory",
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      "Change PART of an existing memory without re-sending it (#519): an addendum, a corrected sentence, a sharper summary, an extra trigger. " +
      "NEVER edit a vault .md file directly: that skips the audit log, the `updated` stamp, the id lock, the atomic write and the index, and a parallel writer or cloud sync can silently undo it. " +
      "Use save_memory(overwrite: true) only for a full rewrite or a field this tool does not cover.\n\n" +
      "OPERATIONS (combinable, applied as ONE atomic change):\n" +
      "- str_replace: old_str must occur EXACTLY ONCE in the body (copy it verbatim from load_memory); otherwise nothing is written and the error says whether it was missing or ambiguous.\n" +
      "- append: text added at the end of the body, before the auto-related block.\n" +
      "- frontmatter: patch summary, recall_when, tags, issues, related, confidence, valid_until, rulebook, applies_when, rulebook_proposed or validator; agent changes to existing rules apply directly without confirmation (Owner decision #1336). " +
      "id, scope, type, sensitivity and write_origin are rejected here. A list field REPLACES the whole list: send the old entries plus the new one; removed entries come back under `dropped` (#661).\n" +
      "- rulebook_decision: only after an explicit user decision in chat. Load the proposal, then pass {decision: accept|reject, write_origin: user-directed} with expected_revision. " +
      "It attests user direction, not authentication. Never self-confirm; not combinable with other edits. Accept binds the proposal; reject removes only the proposal and keeps an existing rule.\n" +
      "expected_revision (optional): the `revision` from load_memory; the edit is refused if the file changed meanwhile. Never pass the `updated` stamp (day precision, #519). " +
      "session_id / agent_id: pass them when transport attribution is absent, as Stop execution evidence (main omits agent_id); they are not memory metadata.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", minLength: 1, maxLength: 200 },
        agent_id: { type: "string", minLength: 1, maxLength: 200 },
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
          description: "Text appended to the end of the body.",
        },
        frontmatter: {
          type: "object",
          description:
            "Patch for a whitelist of fields; any other key is REJECTED. List fields replace the existing list. Do not combine rulebook_proposed with rulebook or applies_when.",
          properties: {
            summary: { type: "string" },
            recall_when: { type: "array", items: { type: "string" } },
            tags: { type: "array", items: { type: "string" } },
            issues: { type: "array", items: { type: "string" } },
            related: { type: "array", items: { type: "string" } },
            confidence: { type: "number" },
            valid_until: { type: "string" },
            rulebook: RULEBOOK_INPUT,
            rule_categories: RULE_CATEGORIES_INPUT,
            applies_when: APPLIES_WHEN_INPUT,
            rulebook_proposed: RULEBOOK_PROPOSED_INPUT,
            validator: VALIDATOR_INPUT,
          },
        },
        rulebook_decision: {
          type: "object",
          additionalProperties: false,
          required: ["decision", "write_origin"],
          properties: {
            decision: { type: "string", enum: ["accept", "reject"] },
            write_origin: { type: "string", enum: ["user-directed"] },
          },
          description:
            "The user's explicit decision on the exact proposal loaded. Requires expected_revision. Never infer consent or accept your own proposal. Legacy archive:true proposals use archive_memory separately.",
        },
        expected_revision: {
          type: "string",
          description:
            "The `revision` load_memory returned; the edit is refused if the file no longer carries it. Omit to edit the current state.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "archive_memory",
    annotations: { readOnlyHint: false, destructiveHint: true },
    description:
      "Move a memory into the vault trash (recoverable, never a hard delete; restore_memory brings it back). Not a general delete — two uses only: " +
      'closing an INTAKE ADOPTION (after save_memory wrote the full-format version with source "migrated:<label>:<original-id>", archive the original and pass superseded_by), ' +
      "or a memory the user explicitly asked to retire. Existing validator rules are archived directly too, without proposal or confirmation (Owner decision #1336).",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Id of the memory to archive (the intake original).",
        },
        superseded_by: {
          type: "string",
          description: "Id of the memory that replaces it; stamped into the archived copy for audit.",
        },
      },
      required: ["id"],
    },
  },
];
