# bastra-recall

Keep preferences, decisions and lessons available across AI sessions. Bastra Recall stores memories as readable Markdown files and connects them to Claude Code, Claude Desktop, Codex, ChatGPT Desktop and Cursor. Check the [support matrix](https://github.com/n0mad-ai/bastra-recall#supported-surfaces) for each integration’s tested status.

This package provides the installer and `bastra` command. Storage and keyword search are local; retrieved context is passed to your AI client. See [privacy and network use](https://github.com/n0mad-ai/bastra-recall/blob/main/docs/PRIVACY.md).

## Install

```bash
# guided setup, without a prior global npm installation:
npx bastra-recall install

# or install the CLI globally:
npm install -g bastra-recall
bastra install
```

Both expose the `bastra` CLI. After installing, restart your AI client.

- `bastra install` — guided setup (interactive): pick vault, AI clients, semantic recall.
- `bastra install all` — register the MCP server, Skill, and hooks across ChatGPT Desktop/Codex, Claude Code, Claude Desktop, and Cursor (script-friendly).
- `bastra install codex` — install the shared Codex/ChatGPT Desktop MCP entry, native hooks, and `~/.agents/skills/bastra-recall`.
- `bastra doctor` — check registrations; add `--fix` to repair them.
- `bastra rules cursor` — add memory guidance in the current Cursor project.
- `bastra uninstall all` — unregister every client again. The installed package, your vault, logs and settings stay; removing the package is a separate `brew uninstall` / `npm uninstall -g`.

The CLI itself ships in [`@bastra-recall/daemon`](https://www.npmjs.com/package/@bastra-recall/daemon); this package just re-exports its `bastra` entry point under the unscoped name.

## Requirements

Node 22+. Keyword search works by default. Run `bastra embeddings on` to set up optional local semantic search with Ollama, or `bastra embeddings off` to return to keyword-only search.

Platforms — the full matrix is in the [main README](https://github.com/n0mad-ai/bastra-recall#supported-platforms):

- **macOS** (Apple Silicon and Intel) — supported, everything included.
- **Linux** (x86_64 and arm64) — daemon, CLI, MCP and hooks, compiled hook client included. Without `bastra autostart` (LaunchAgent, macOS-only — the forwarder starts the daemon on demand), without the `.mcpb` extension install and without `open_document`.
- **Windows** — not covered: no compiled hook client is built for it, and nothing here is tested on it.

Full docs & source: <https://github.com/n0mad-ai/bastra-recall>

MIT © Daniel Nevoigt
