# Bastra Recall roadmap

The goal is to reduce repeated explanations: keep preferences, decisions and
lessons available across sessions and connected AI tools. This roadmap separates
the published product from work in preparation and longer-term research.

## Available in the public releases

- Local Markdown memory storage, search and retrieval through MCP and REST.
- Guided setup, updates and diagnostics through the `bastra` CLI.
- Memory guidance and supported client integrations. The [README support matrix](./README.md#supported-surfaces) distinguishes tested clients from implementations awaiting field testing.
- A local browser-based vault map, memory import, onboarding and memory care.
- Optional semantic search and community recipes.

See the [latest release](https://github.com/n0mad-ai/bastra-recall/releases/latest)
for the published version and [CHANGELOG.md](./CHANGELOG.md) for exact version
boundaries. `main` can contain work not yet available through the published installer.

## v1.0 — in preparation

| Work | What it means for users |
|---|---|
| Reproducible recall measurements | Judge behavior with documented methods; ranking scores alone are not evidence of relevance. |
| Relevance evidence and abstention | Avoid supplying context simply because something ranked first when nothing fits. |
| Project-aware session context | Start from the relevant project's preferences and decisions. |
| Context-use measurement and controls | Make the cost of retrieved context visible and allow a budget on individual recall calls. |
| Codex integration | Connect Codex through the shared MCP service, Skill and native hooks; keep the CLI, desktop and IDE verification status explicit. |
| Installation and update hardening | Make registration, diagnostics and failure messages consistent across supported installation paths. |

**Budget boundary:** the cumulative session-wide context ledger runs in shadow
mode. It measures what a global limit would have withheld; it does not yet
enforce that limit live. Enabling live enforcement is a measured post-1.0
step, tracked in [#458](https://github.com/n0mad-ai/bastra-recall/issues/458).

Follow the [v1.0 milestone](https://github.com/n0mad-ai/bastra-recall/milestone/18)
for remaining work. A prepared implementation is not a claim that every client
or environment has been field-tested.

## After v1.0

- Verify additional clients and complete the packaged [ChatGPT Custom GPT Actions integration](https://github.com/n0mad-ai/bastra-recall/issues/13).
- Evaluate deeper retrieval, episodic memory, consolidation and learned ranking before enabling them in normal use.
- Continue the native Mac app as a separate interface over the same memory service.

The technical [evolution design](./docs/Evolutionsarchitektur%20V1%20zu%20V2.md)
defines the research stages and their measurement gates. It is a design reference,
not a list of features already shipped.

## Boundaries

The open-source service must remain useful without a paid app. The local vault
map is included today. A hosted synchronization service is not part of the current
scope: a vault folder can use an OS-level sync provider, with that provider's data
handling and conflict behavior. See [privacy and control](./docs/PRIVACY.md).

Contribution guidance is in [CONTRIBUTING.md](./CONTRIBUTING.md), the runtime design
in [docs/architecture.md](./docs/architecture.md), and security reporting in
[SECURITY.md](./SECURITY.md).
