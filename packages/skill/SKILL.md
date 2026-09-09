---
name: bastra-recall
description: Persistent external brain for ChatGPT, Codex, Claude, and other MCP clients — documents (PDFs, contracts, scans with OCR), personal facts (appointments, decisions, items, amounts), AND code lessons / preferences / project topology. USE PROACTIVELY in three modes. (1) RECALL — whenever the user asks about anything from their past, vault, projects, or personal life, INCLUDING direct retrieval phrasings like "find...", "where is...", "when was...", "how much was...", "do I have a ...", "such mal meinen ...". Call bastra-recall (recall + find_document) BEFORE conversation_search, before web_search, before any other lookup tool. (2) CAPTURE — when the user expresses frustration about a recurring issue (in any language: "again", "wieder", "снова", "how often", emphatic caps in any script), states an explicit durable rule ("always X", "never Y", "on this project we …"), corrects a recurring tendency in your behavior, finalizes an architectural decision after weighing options, confirms a workflow ("let's always do it this way"), or completes a coherent feature / multi-file refactor / sub-system milestone (save the file map as project-fact). (3) APPLY — at session start, before writing/editing code, before a new coding block in an area you haven't touched this session (recall the topology map first), and before giving multi-step plans. Tools: recall, load_memory, save_memory, find_document, read_document.
---

# bastra-recall — autonomous teammate memory

You have a persistent memory across sessions via the `bastra-recall` MCP server. Treat it as YOUR own long-term memory, not as a tool the user has to invoke.

The single success metric: **the user does not have to think for you anymore.** Recurring mistakes don't recur. Stable preferences don't get re-stated. Project facts don't get re-discovered.

**This file is triggers — WHEN to reach for the vault.** The mechanics of each call (score bands, valence params, quality bars, admission rules) live in the tool descriptions, at the point of use. Anything not covered here is covered there.

**Reflex order — RECALL first.** The highest-frequency, highest-cost failure is skipping recall and re-deriving what the vault already holds. So the first reflex on every turn is RECALL: before acting, before any other lookup tool, and before the capture machinery below. When you're unsure whether a recall is worth it, recall.

---

## When to RECALL — before acting, not only when prompted

Call `recall(query, k=5)` proactively in these moments:

| Moment | Query shape |
|---|---|
| **Session start** (once per session) | `"<project name> preferences user-preference active context"` — preloads durable context |
| **Before writing/editing a file** | `"writing <filetype> at <path>, contains <topics>"` — catches lessons before mistakes |
| **Before a new coding block / plan in a feature area** | `"<project> <feature/area> current state files architecture"` — which files matter, what's already built (→ `topology.md`) |
| **Before a multi-step plan or recommendation** | `"giving plan/recommendation for <topic>"` — surfaces format preferences |
| **Before asserting a number, a measurement or project history** in text meant for anyone else — a reply, release notes, a changelog entry, an issue comment, docs | the claim itself: `"<project> <what is being claimed> measured"` |
| **User asks for retrieval / lookup** ("find...", "where is...", "how much was...", "when did...", "do I have a...", "such mal meinen...") | the prompt itself + direct nouns — ALWAYS before any other search tool |
| **User prompt touches a stored topic** | the prompt itself, optionally with project context |
| **Before `save_memory`** | the title/topic — duplicate check |

**What goes into a query:** ask the vault what only memory can answer — durable preferences, lessons, decisions, past facts and documents. What is already in the prompt or an upload, or findable by reading the project's files and logs, is not a recall — it is context you already have. Decide what you are looking for, then phrase THAT; never shovel a convoluted prompt's background into queries.

**When context is tight, say so in tokens.** `k` counts results, not context, and the same `k=5` answer varies by more than 2× in size. Pass `max_tokens` — an optional budget for that one call: hits come back in rank order until the payload would exceed it, and a response that had to leave hits out says so with `truncated_by_budget` and `dropped_by_budget`. `k` stays the hard upper bound, and without `max_tokens` nothing changes.

`recall` is **step 1 of two**: it returns lean candidates, no bodies. Spend the `summary` + `score` to decide, then `load_memory(id)` only for the ones you actually need — loading every hit burns context for nothing. Never ignore a `lesson` hit that matched on `recall_when` or title. Don't reload a memory you already loaded this turn. (Score bands and the `weak_result` / `no_home` signals: `recall` tool description.)

**Claims that leave the machine are the strictest case.** A number, a measurement, a date or a piece of project history that goes into a reply, release notes, a changelog, an issue comment or documentation gets quoted back later — so it gets recalled first, every time, no matter how confident the recollection feels. If the vault does not answer the claim, **write that you don't know**; do not assert it from model memory, and do not soften it into a hedge that reads like knowledge. This is the one case with no safety net: no file is edited, so nothing else fires.

### Tool priority for retrieval

When the user asks about anything personal, factual, historical, or document-shaped, try the vault **first**:

1. **`recall`** — memories, lessons, decisions, project facts, personal facts.
2. **`find_document`** — PDFs, scans, OCR'd content. Same two-step discipline: lean candidates first, then `read_document(id)` for the ones you need.
3. **`conversation_search`** — chat history. Fallback only.
4. **`web_search`** — external info. Last resort for personal queries.

Skipping straight to `conversation_search` or `web_search` on a "find my …" query is the #1 failure mode this skill exists to prevent. The vault is the canonical store; if it's there, `recall` / `find_document` will find it.

---

## When to SAVE — autonomous, no permission asked

### STRONG signals — fire `save_memory` immediately, then a one-line ack

The cue column holds **examples, not a word list** — the user may write in any language, and the signal is the situation, not the sample phrase (#476).

| Signal | Cue (examples) | Memory `type` |
|---|---|---|
| User-frustration about a recurring issue | "again", "wieder", "снова", "how often", emphatic CAPS in any script | `lesson` + `emotion: frustration`, `salience: 0.8` |
| Explicit durable rule | "always X", "never Y", "on this project we use Z" | `preference` / `workflow` |
| Correction of a recurring tendency | "you overcomplicate CSS", "keep it simpler" | `meta-working` |
| Architectural decision finalized after weighing options | "ok then, we take Drizzle" | `decision` |
| Workflow confirmation | "let's always do it this way" | `workflow` |
| Bug fixed after >2 iterations with non-obvious root cause | — | `lesson` (capture the FAILED PATH too) + `emotion: success`, `salience: 0.7` |
| User marks something as important | "this is important", "remember that" | `salience: 0.9` |
| **Feature / coding block completion** (multi-file feature done, sub-system stabilized, refactor finalized, issue closed with code) | — | `project-fact` → `topology.md` |
| **Substantive exchange with a person/contributor** (Discord / dev.to / GitHub — not one-liners) | — | identity → `taxonomy.md`, content → `project-fact` |

Set `salience`/`emotion` ONLY when a row above fires or the user marks importance — never invent them.

After a real back-and-forth with a contributor lands, memorize it on **two rails**: identity into the person's one canonical memo (`taxonomy.md`), content and decisions as a `project-fact` that links the person via `[[handle]]`. Before propagating any code claim a contributor makes, **verify it against HEAD** — never write an unverified assertion into memory.

### ANTI-signals — do NOT save

- One-off task descriptions ("baue mir bitte X") — that's a task, not a memory.
- Speculation, "maybe", tentative ideas.
- Anything derivable from code, git history, or CLAUDE.md.
- Sensitive personal data unless it's a stable preference.
- **When in doubt: do NOT save.** False saves erode trust faster than missed saves.

Two failure modes that outlive their cause, both spelled out in the `save_memory` description: **negative capability claims** ("X is broken") harden into standing refusals — capture the fix instead; and **stale-in-7-days artifacts** (task progress, PR numbers, "phase N done") belong in git and issues, not in memory.

### Before saving

Always `recall()` the title/topic first. If a near-duplicate exists, update it with `overwrite=true` instead of creating a second one. If the fact itself *changed*, save the new version with `replaces: <old-id>` — the old one stays loadable as a previous version. Merely related? That's a `[[wikilink]]`, not a supersede.

The quality bars for every field — title, summary length, `recall_when` authoring, language, `verify_cmd` — are in the `save_memory` tool description. Follow them there.

### After saving — ack format

One line, prefixed with `→`, then continue with the actual task:

```
→ saved: <title> (id: <id>)
```

Nothing more. The user can ignore it, correct it, or delete it.

---

## Reference files — read on the signal, not every turn

Four subsystems fire rarely and carry their own instructions. Each names the moment it becomes relevant; until then, ignore them.

| Read | When |
|---|---|
| `topology.md` | A coherent piece of work just landed — or you're about to start in an area you haven't touched this session. |
| `taxonomy.md` | A recurring cluster has no home yet, you're re-filing memories, or you're saving anything about a person. |
| `intake.md` | A recall hit comes from `memories/imported/`, right after `bastra import vault`, or an `<adoption-candidate>` block appears. |
| `commons.md` | A recall hit carries `scope: commons`, or the user asks about sharing, contributing or bridges. |

**Applying** an active convention needs none of them: the `<vault-taxonomy>` block injected at session start lists the vault's self-learned conventions, and they are BINDING. Follow a listed convention's `folder`/`topic_path`/`tags` exactly rather than inventing variant tags that fragment recall. Only *establishing* a new one sends you to `taxonomy.md`.

**Product docs** are OFF by default. When enabled, the session hook injects a `<bastra-product-docs>` block carrying its own complete instructions — follow that block. No block means the feature is off; never write product docs on your own.

---

## Tone with the user

- If you load a memory and apply it, you don't need to mention it unless asked. Just behave correctly. Silence is the best compliment to a working memory.
- Never ask permission for a strong-signal save — that defeats the purpose.
- Never narrate "I'm going to call recall now" — just call it.

---

**Meta-rule against regrowth:** new *mechanics* go into the tool description, where they are read at the point of use. Only a new *trigger* — a new moment to reach for the vault — earns a line in this file.
