# Bastra Recall roadmap

The goal is to reduce repeated explanations: keep preferences, decisions and
lessons available across sessions and connected AI tools. This roadmap names
what has shipped, the next planned releases and longer-term work.

## What has shipped

- Local Markdown memory storage, search and retrieval through MCP and REST.
- Guided setup, updates and diagnostics through the `bastra` CLI.
- Memory guidance and supported client integrations. The [README support matrix](./README.md#supported-surfaces) lists the tested clients.
- A local browser-based web UI, memory import, onboarding and memory care.
- Optional semantic search and community recipes.
- Since 1.1.8: the rulebook and remote MCP with OAuth ([remote access](./docs/REMOTE-ACCESS.md)).

See the [latest release](https://github.com/n0mad-ai/bastra-recall/releases/latest)
for the published version and [CHANGELOG.md](./CHANGELOG.md) for exact version
boundaries.

## How releases are made

Development happens on `main`. `main` can therefore contain features that are
not in a release yet; the README marks them. A release is a version tag on
`main` (for example `v1.1.8`). Install from the published release, not from an
unreleased `main`.

## Next releases

Releases continue in the 1.x line. Features from the V2 plan ship in these
releases as they become ready.

| Release | Focus |
|---|---|
| [v1.2.0](https://github.com/n0mad-ai/bastra-recall/milestone/33) | Proactive tasks and reminders, with their follow-up fixes. |
| [v1.3.0](https://github.com/n0mad-ai/bastra-recall/milestone/37) | Follow-ups after 1.2.0. |
| [v1.4.0](https://github.com/n0mad-ai/bastra-recall/milestone/38) | Traceable shared memory and structured hand-offs between agents. |
| [v1.5.0](https://github.com/n0mad-ai/bastra-recall/milestone/39) | Further capture, maintenance, rule reach for clients without hooks, and a complete audit. |

The milestones hold the current scope; it can change.

**Budget boundary:** the cumulative session-wide context ledger runs in shadow
mode. It measures what a global limit would have withheld; it does not yet
enforce that limit live. Enabling live enforcement is a measured later step,
tracked in [#458](https://github.com/n0mad-ai/bastra-recall/issues/458).

## Later

- Test further MCP clients and add them to the support matrix once tested, and follow up the ChatGPT connection with a plugin ([#1279](https://github.com/n0mad-ai/bastra-recall/issues/1279)); the Custom GPT Actions route is retired with OpenAI's 2026-12-11 deadline.
- Evaluate deeper retrieval, episodic memory, consolidation and learned ranking before enabling them in normal use.
- Continue the native Mac app as a separate interface over the same memory service.

The [unified V2 evolution plan](./docs/Evolution%20Plan%20V2.md) describes the
longer-term scope: adaptive recall, proactive commitments, permissioned
actions, causal learning and shared memory. Some of its release rules are out of
date and are being aligned with later decisions in
[#1476](https://github.com/n0mad-ai/bastra-recall/issues/1476). Measurement
windows run in [milestone #30](https://github.com/n0mad-ai/bastra-recall/milestone/30).
Code awareness/Graphify is outside the version roadmap in
[experimental milestone #29](https://github.com/n0mad-ai/bastra-recall/milestone/29).
The [technical architecture](./docs/Evolutionsarchitektur%20V1%20zu%20V2.md)
holds the detailed contracts.

## Boundaries

The open-source service must remain useful without a paid app. The local web UI
is included today. A hosted synchronization service is not part of the current
scope: a vault folder can use an OS-level sync provider, with that provider's data
handling and conflict behavior. See [privacy and control](./docs/PRIVACY.md).

Contribution guidance is in [CONTRIBUTING.md](./CONTRIBUTING.md), the runtime design
in [docs/architecture.md](./docs/architecture.md), and security reporting in
[SECURITY.md](./SECURITY.md).
