# bastra-recall

Persistent **recall memory** for AI coding agents — ChatGPT Desktop, Codex, Claude Code, Claude Desktop, and Cursor. This package is a thin launcher that installs and wires up bastra-recall across every supported MCP client with one command.

## Install

```bash
# zero-install, one-off — guided setup with selection lists:
npx bastra-recall install

# or install the CLI globally:
npm install -g bastra-recall
bastra install
```

Both expose the `bastra` CLI. After installing, restart your AI client.

- `bastra install` — guided setup (interactive): pick vault, AI clients, semantic recall.
- `bastra install all` — register the MCP server, Skill, and hooks across ChatGPT Desktop/Codex, Claude Code, Claude Desktop, and Cursor (script-friendly).
- `bastra install codex` — install the shared Codex/ChatGPT Desktop MCP entry, native hooks, and `~/.agents/skills/bastra-recall`.
- `bastra doctor` — check / repair registrations.
- `bastra uninstall all` — remove everything again.

The CLI itself ships in [`@bastra-recall/daemon`](https://www.npmjs.com/package/@bastra-recall/daemon); this package just re-exports its `bastra` entry point under the unscoped name.

## Requirements

macOS (Apple Silicon) today. Node 22+. Semantic recall is opt-in (BM25 is the default); set `BASTRA_EMBEDDING_PROVIDER=ollama` to enable embeddings.

Full docs & source: <https://github.com/n0mad-ai/bastra-recall>

MIT © Daniel Nevoigt
