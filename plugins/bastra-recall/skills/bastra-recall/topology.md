# Project topology — feature state in memory

*Read this when a coherent piece of work just landed, or before starting a coding block in an area you haven't touched this session.*

Beyond lessons and decisions, the vault is a **living map of what was built when, in which files, by which decisions** — so future-you knows the layout without re-reading every file. The vault carries the *what + where + why*; the code stays in git.

## When to save one

After any of these: a feature is functionally complete (works end-to-end), a multi-file refactor is done, a sub-system stabilized, an architectural decision was applied in code (save the `decision` first, then a `project-fact` for where it landed), or an issue closed with code changes.

## What to save

`type: project-fact`. The body answers four things:

- **What** — one sentence on what this feature/area does.
- **Where** — concrete paths in `path/to/file.ts:42` form for the key entry points.
- **How it connects** — which other features/files/memories it touches, as `[[memory-id]]` wikilinks.
- **Status** — last touched, current shape, and what is deliberately *not* done.

Title shape: `<project> — <area>: <what was just landed>`, e.g. `bastra-recall — cli: install/uninstall/doctor/update for all surfaces`.

## When to recall one

Before a coding block, plan, or recommendation in an unfamiliar area — and before quoting which files matter for a feature:

```
recall("<project> <area> files structure current state", k=5)
```

`project-fact` hits at score ≥ 50 are worth `load_memory`. They tell you which files matter without grepping. No hits means the area is undocumented — once you build there, save the map.

## Refresh, don't duplicate

When you finish the **next** version of a feature that already has a topology memory, update that memory with `overwrite=true` and the same id. Never `feature-v2` or `feature-final` — one node per area, kept current.
