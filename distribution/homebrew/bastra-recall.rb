# bastra-recall — Homebrew formula
#
# THIS FILE IS THE SOURCE OF TRUTH for everything EXCEPT `url` and `sha256`.
# The live copy lives in https://github.com/n0mad-ai/homebrew-tap as
# Formula/bastra-recall.rb.
#
# `url` / `sha256` down there are bumped automatically by the tap's own
# .github/workflows/update-formula.yml on every stable release — never copy
# the two lines from here, this file's version deliberately lags behind.
# Everything else (build steps, bin shims, caveats) is authored HERE and has to
# be copied over by hand. The two drifted apart once (the tap sat on v0.7.6 and
# was missing six of the seven hook shims); keep them in lockstep.
#
# Install via:
#   brew tap n0mad-ai/tap
#   brew trust n0mad-ai/tap   # current brew refuses untrusted third-party taps
#   brew install bastra-recall
#   bastra install all

class BastraRecall < Formula
  desc "Persistent teammate memory for AI assistants (Claude, ChatGPT, Cursor)"
  homepage "https://github.com/n0mad-ai/bastra-recall"
  url "https://github.com/n0mad-ai/bastra-recall/archive/refs/tags/v0.8.8.tar.gz"
  sha256 "4ccad2d66dbc0bbd35df74f38498b853fc79525b6cf9d65317c55745cddf1be1"
  license "MIT"
  head "https://github.com/n0mad-ai/bastra-recall.git", branch: "main"

  depends_on "node"

  def install
    system "npm", "install"
    # Root build (--workspaces): daemon imports need core/statusline dist,
    # which the release tarball does not contain (bastra-recall#184). The
    # build also syncs packages/skill/*.md into packages/daemon/skill/, which
    # is where the CLI reads the skill payload from (#232).
    system "npm", "run", "build"
    # Runtime deps + workspace symlinks must ship with the install — without
    # node_modules the ESM resolver cannot find @bastra-recall/core from the
    # daemon dist (bastra-recall#184, second half). Prune dev deps first.
    system "npm", "prune", "--omit=dev"

    libexec.install "packages", "node_modules", "package.json", "package-lock.json"

    # CLI + daemon binaries -> bin shims. All seven hooks belong here: the
    # hook binaries are what `bastra install claude-code` registers, so a
    # missing shim silently costs the user that reflex lane.
    bin.install_symlink libexec/"packages/daemon/dist/cli.js" => "bastra"
    bin.install_symlink libexec/"packages/daemon/dist/index.js" => "bastra-recall"
    bin.install_symlink libexec/"packages/daemon/dist/mcp-forwarder.js" => "bastra-recall-mcp"
    bin.install_symlink libexec/"packages/daemon/dist/bridge.js" => "bastra-recall-bridge"
    bin.install_symlink libexec/"packages/daemon/dist/hook.js" => "bastra-recall-hook"
    bin.install_symlink libexec/"packages/daemon/dist/session-hook.js" => "bastra-recall-session-hook"
    bin.install_symlink libexec/"packages/daemon/dist/prompt-hook.js" => "bastra-recall-prompt-hook"
    bin.install_symlink libexec/"packages/daemon/dist/todo-hook.js" => "bastra-recall-todo-hook"
    bin.install_symlink libexec/"packages/daemon/dist/bash-pre-hook.js" => "bastra-recall-bash-pre-hook"
    bin.install_symlink libexec/"packages/daemon/dist/bash-fail-hook.js" => "bastra-recall-bash-fail-hook"
    bin.install_symlink libexec/"packages/daemon/dist/stop-hook.js" => "bastra-recall-stop-hook"
    bin.install_symlink libexec/"packages/statusline/bin/claude-powerline" => "bastra-statusline"
  end

  def caveats
    <<~EOS
      Finish setup with:
        bastra install all

      That registers bastra-recall with every supported AI client
      (Claude Code, Claude Desktop, Codex/ChatGPT Desktop, Cursor) and verifies the install.

      The MCP forwarder auto-starts the daemon on first use, and it shuts
      down again after 30 minutes idle. That is all Claude Code, Claude
      Desktop and Cursor need.

      To keep it running permanently (REST clients, warm embedding model):
        bastra autostart on
        bastra autostart off    # back to on-demand

      After a plain 'brew upgrade' the running daemon keeps the OLD code in
      memory — Homebrew does not know about it. Either use:
        bastra update           # upgrade + re-register + restart, all in one
      or restart the daemon yourself. 'bastra doctor' says when the running
      daemon is older than what is installed.

      Vault path: pass --vault, set BASTRA_VAULT_PATH, or let the CLI
      auto-detect from an existing claude.json registration.
    EOS
  end

  test do
    assert_match "bastra", shell_output("#{bin}/bastra --version")
    system bin/"bastra", "doctor"
  end
end
