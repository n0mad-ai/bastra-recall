# Bastra.Recall Roadmap

## Product Bet

Bastra.Recall is a local-first memory layer for AI assistants. The user should
not have to re-state durable preferences, project facts, decisions, workflows,
or lessons across connected surfaces — Claude Code, Claude Desktop, Codex and ChatGPT Desktop today,
more via MCP/HTTP as they are verified (see the README support matrix).

The single success metric:

> The user does not have to think for the AI anymore.

## Current Runtime

| Area | Current state |
|---|---|
| Storage | Plain markdown + YAML frontmatter, recursive Obsidian-compatible vault scan |
| Search | In-memory MiniSearch BM25, boosted `recall_when`, optional OpenAI/Ollama embeddings with RRF fusion |
| Daemon | Node 22+ TypeScript daemon with stdio MCP + loopback HTTP REST on `127.0.0.1:6723` |
| Multi-client | MCP forwarder auto-spawns/reuses one shared daemon so clients share one vault/index |
| Save path | `save_memory` validates and writes markdown, then force-reindexes the file |
| Claude Code reflex layer | Hooks for `SessionStart`, `UserPromptSubmit`, `PreToolUse` edits/todos/bash, `PostToolUse` bash failures, plus optional `Stop` save-eval |
| Codex/ChatGPT reflex layer | Shared `~/.codex/config.toml`, Skill under `~/.agents/skills`, and Codex-native hooks for sessions, prompts, `apply_patch`, `update_plan`, Bash and Stop |
| Distribution | `bastra install/uninstall/doctor/update`, Homebrew tap, double-click macOS installer, npm live (OIDC trusted publishing) |
| Human editor | Obsidian or any markdown editor; no hosted service required |

## Done

| Milestone | Result |
|---|---|
| M0 Recall eval | Own-trigger baseline passed on the dogfood vault; BM25 + authored `recall_when` was sufficient for v0 |
| M1 Read path | `recall` and `load_memory` work through MCP and REST |
| M2 Save path | `save_memory` writes schema-valid markdown and reindexes immediately |
| M3 Reflex layer | Claude Code hooks surface recall hints before action, failure, and stop moments |
| Multi-surface baseline | Claude Code, Claude Desktop, Codex/ChatGPT Desktop, Cursor MCP registration via `bastra install` |
| Distribution | npm + Homebrew tap + `Install Bastra.command` live; releases auto-publish via OIDC trusted publishing |
| Claude Desktop autonomy | Server instructions + first-call session context — autonomous memory without hooks |
| Self-serve layer | Vault map, onboarding interview, `bastra import` (lists, conversations, rules, vaults), vault care, valence & reflex lane |

## Active Hardening

1. **Distribution confidence**
   - Keep Homebrew formula and npm package layout aligned (npm publishes with provenance via OIDC — live).
   - Ensure `Install Bastra.command` fails visibly when install or doctor fails.

2. **Public test fixtures**
   - Keep `fixtures/sample-vault` as a public smoke-test vault.
   - Gate CI on build, typecheck, tests, smoke, update-check tests, and pack dry-runs.

3. **Docs truth**
   - README, package README, hook docs, architecture docs, and OpenAPI spec must reflect the current code.
   - Historical design choices stay out of first-run docs unless clearly marked as historical.

4. **OSS trust**
   - Add security policy, dependency update config, dependency review, CodeQL, and OpenSSF Scorecard.
   - Keep contribution instructions lightweight but explicit.

## Next Product Work

| Stage | Work | Why it matters |
|---|---|---|
| v0.9 — Honest numbers, nothing silently lost (shipped) | 45 issues of hardening from contributor field reports plus a manual end-to-end release gate ([#213](https://github.com/n0mad-ai/bastra-recall/issues/213)), and update safety: local patches survive `bastra update` ([#268](https://github.com/n0mad-ai/bastra-recall/issues/268)/[#269](https://github.com/n0mad-ai/bastra-recall/issues/269)) | Contributors run local fixes; an update must never silently revert them — and nothing may report success it did not achieve. The self-improvement line moved to V1.0. |
| V1.0 — Release contract (specified) | Measurement truth + reproducible eval baselines, deterministic relevance evidence with real abstention, project-aware session assembler, global context budget, and the complete Codex/ChatGPT Desktop adapter ([#15](https://github.com/n0mad-ai/bastra-recall/issues/15)) — milestone [#18](https://github.com/n0mad-ai/bastra-recall/milestone/18) | Today's scores are rank sums, not relevance promises; V1.0 makes recall reproducibly measured, selective, controllable and available on the current OpenAI desktop/coding surfaces. See `docs/Evolutionsarchitektur V1 zu V2.md`. |
| V1.x → V2.0 (measurement-gated) | Accessibility zones, deep recall, episodic memory, typed graph, consolidation, HNSW, learned ranking — each behind its own gate | Long-term target: an adaptive multi-layer memory. Nothing ships on analogy; every stage needs its measured gate. |
| Planned surfaces | ChatGPT Custom GPT action ([#13](https://github.com/n0mad-ai/bastra-recall/issues/13)), Cursor verification | The support matrix in the README is the single source of truth for surface status. |

## Deliberately Out Of Scope For Now

- Hosted sync service. Use iCloud, Google Drive, Dropbox, or git-backed vaults today.
- Browser-based vault editor. Markdown editors already solve this well.
- Moving core OSS functionality behind the Mac app. The OSS daemon must remain useful by itself.
