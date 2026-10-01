# Archiving `rm` and git snapshots — how it works / Archivierendes `rm` und Git-Schnappschüsse — so funktioniert es

[English](#english) · [Deutsch](#deutsch)

<a id="english"></a>

## English

> **Designed and implemented by [@zzallirog](https://github.com/zzallirog) (PRs [#689](https://github.com/n0mad-ai/bastra-recall/pull/689), [#690](https://github.com/n0mad-ai/bastra-recall/pull/690), [#692](https://github.com/n0mad-ai/bastra-recall/pull/692)); this page preserves those PR descriptions.**
> The work reached `main` through [#696](https://github.com/n0mad-ai/bastra-recall/pull/696) as one squashed commit, so his commits are not in `main`'s history. His PR descriptions are the explanation of how the feature works without reading the code. The text below follows them, adjusted to what was merged. The short reference (settings, env table) stays in [hooks.md](./hooks.md#bastra-recall-bash-pre-hook-34).

### What #696 changed on the way in

- **Opt-in, off by default.** `bastra config set archive.enabled on` (stored in `~/.bastra/cli-settings.json`, read on the next Bash call), or `BASTRA_RM_ARCHIVES=1` in the daemon's environment. The env wins when set; any other value turns it off. One switch covers the archiving `rm` and the git snapshots. `bastra install` and onboarding never turn it on; `bastra doctor` lists it among the features that are off on purpose.
- **Only for proven Claude Code calls.** The hook call must carry Claude Code's client marker `BASTRA_HOOK_CLIENT=claude-code`, which `bastra install` now writes in front of every Claude Code hook command (re-run it once). An unmarked call keeps the STOP. The PR text said "every surface except `claude-code`"; the merged gate is this marker.
- **Off means as before.** With the opt-in off, `rm -r` and the git acts get exactly the hint they get without the feature: no rewrite, no `allow`, no extra line, no shadow event.
- **The narrow switches.** `BASTRA_RM_SHIM=0` / `BASTRA_GIT_SHIM=0` only narrow an enabled opt-in: they leave out the `rm` part or the git part.
- **`BASTRA_RM_ARCHIVES=host`** is the setting for a host that brings its own archiving `rm` (receipt text only, no rewrite). In the PR, `=1` meant that; now `=1` turns bastra's own archive on.
- **Node path.** The rewrite names Homebrew's `opt/<formula>/bin/node` when it resolves to the daemon's node, so a `brew upgrade node` does not break it; if that path is gone anyway, the shim runs `node` from PATH.

### Why: the problem, measured (#690)

A harvest of every Bash `rm` that was stopped in the transcripts of two hosts (2026-05-29 to 09-26):

- **826** stop events: 712 on a real delete, **114 (13.8%)** on text that only contains `rm` (a commit message, a test string, a heredoc).
- **565** distinct tool calls were stopped, in 190 sessions. **359** of them got only bastra's STOP hint and ran anyway: the hint is context, it blocks nothing.
- **206** calls were really blocked (Claude Code's permission check or a host guard). Afterwards the model retreated in 76.2% of cases (re-ran without the `rm`, or dropped the cleanup), deleted the same target another way in 10.2%, used a workaround (`mv`, `find -delete`, …) in 5.8%, repeated the blocked command in 5.3%, and handed it to the user in 1.9%.
- What the blocked deletes hit: temp 61.2%, build junk 7.1%, the model's own scratch 12.7%, git-tracked 6.6%, **user/project/system files 12.2% (24)** — most of those 24 were deletions the task had asked for.
- **Did a STOP ever save something that mattered? None found.**

So the stop costs a little every time and saved nothing that could be found. But nobody can tell in advance which deletes are harmless, and 12% of the blocked ones hit real files. That is why this is a trash with an address, not a plain allow.

### The archiving `rm` (#690)

**1. bash-pre: rewrite and allow.** For a Claude Code command made *only* of `rm` (boundary below), the bash-pre lane answers `permissionDecision: "allow"` with an `updatedInput` whose command is:

```
[ -x '<pkg>/shims/rm' ] || exit 97; unset -f rm git 2>/dev/null; export PATH='<pkg>/shims':"$PATH" BASTRA_RM_CALL='<tool_use_id>' BASTRA_NODE='<node>'
<the command exactly as written>
```

Globs, variables and `cd` are expanded by the shell as usual. The shim receives exactly the arguments the system `rm` would have received. The hint says bastra runs this command with its archiving `rm`, instead of STOP.

**2. The shim** (`shims/rm` → `rm-shim.js`, source `packages/daemon/src/rm-archive.ts`) moves each target to `~/.bastra/archive/<date>/<HHMMSS-pid>/<full path>`. On the same filesystem this is a rename. A target on another filesystem goes to `<mount>/.bastra-archive`. The shim keeps `rm`'s exit codes and messages (`-f`, missing operand, "Is a directory", `-d`).

- Temp ground (`/tmp`, `/var/tmp`, `/dev/shm`, `/run/user/<uid>`, `$TMPDIR`, macOS `/private/tmp` and `/private/var/folders`, Claude Code's scratchpads) is **really deleted**.
- `/`, `~`, system dirs, the temp roots themselves, the archive and its ancestors, and `.`/`..` are refused.
- Every act (archived / deleted / refused) is one line in `manifest.jsonl`, tagged with the tool call id.

**3. bash post: the receipt.** The PostToolUse lane reads back the manifest lines of this `tool_use_id` and adds them to `additionalContext`, for example:

```
- archived /…/work/victim g → /…/archive/2026-09-27/000824-78840/…/victim g (restore: `bastra archive restore '/…/work/victim g'`)
```

The model learns what actually happened, not what the pre-hook predicted. The first 25 targets are listed and the rest counted (`… and 15 more (15 archived, 0 deleted, 0 refused)`) — one `find … -exec rm` over a tree once put 600 lines into the context.

**4. Cleanup.** Checked at most hourly: the post lane starts `bastra archive reconcile --yes` as a detached child process when the last reconcile is over an hour old (stamped before it starts, so it never runs in the daemon's event loop). By hand: `bastra archive reconcile [--yes]`. An entry goes when its target came back with the same content, or when it is older than its class keeps it:

| class | what | kept (default) |
|---|---|---|
| `junk` | a node_modules/build/cache target, or anything inside a tool cache | 1 day |
| `in-git` | tracked and unchanged as git itself reports it (a failed or timed-out `git status` is not "clean"), nothing untracked or ignored inside, not a repository root | 2 days |
| `user` | everything else | 2 days |

Change it with `bastra config set archive.retain junk=1,in-git=2,user=2` or `BASTRA_ARCHIVE_RETAIN` (env wins). There is a cap, 10 GB unless configured (below): it drops junk first, then in-git, and never a user entry younger than the user retention. Git snapshots (below) keep the user retention and are never dropped by the cap. Reconcile removes only a destination that lies inside an archive: the manifest is a plain file, and a torn or foreign line must not aim it anywhere else. The manifest is rotated past 1 MB (a rename, so a shim appending at that moment lands in one of the two files); a rotated one goes after 30 days once none of its rows is live. A receipt reads only the current file.

**Limits (#934).** Two sizes are the user's to set, written like `5GB` or `500MB` (KB, MB, GB, TB; 1 GB = 2^30 bytes):

| setting | env (wins) | default | what it does |
|---|---|---|---|
| `bastra config set archive.cap 5GB` | `BASTRA_ARCHIVE_CAP` | 10 GB | What the whole archive may hold. Over it, the hourly reconcile drops junk first, then in-git, and never a user entry younger than the user retention. |
| `bastra config set archive.max-item 2GB` | `BASTRA_ARCHIVE_MAX_ITEM` | none | The largest target the archive takes. `off` removes a stored limit. |

A target over `archive.max-item` is neither archived nor deleted: `rm` exits non-zero, the target stays, and the message names the limit, how far the count got, and the ways out (`/bin/rm`, or a higher limit). It is the #695 rule again: a clear refusal, never a silent real delete. Temp ground is still really removed, whatever its size.

How the size is measured: the shim walks the target with `lstat` and adds up file sizes. Without a limit that walk stops after 50,000 entries, because the number only feeds the manifest. With a limit it has to be right, so the walk goes on past 50,000 entries and stops as soon as the total is over the limit. A target over the limit therefore costs less than before; a very large tree *under* the limit is walked in full (about 80,000 to 220,000 files per second on a laptop SSD). The daemon reads the setting and hands the limit to the shim in the rewritten command (`BASTRA_ARCHIVE_MAX_ITEM=<bytes>B`); the shim itself reads no settings file. `bastra doctor` shows both effective values on the archive line while the archive is on.

**5. CLI:** `bastra archive list | restore <path> | reconcile [--yes]`.

#### Exactly what is rewritten, what keeps the STOP, what is not covered

- **Rewritten and allowed:** a command whose every simple command is one of these:
  - `rm …`, `command rm …` or `\rm …` (with `-r`, `-R` or `--recursive`)
  - `xargs <argument-free flags> rm …` (`-0 -r -t -x -nN -LN -PN` and their long forms)
  - `find … -exec|-execdir|-ok|-okdir rm …`, with no `-delete`, `-fprint*` or `-fls`
  - `bash -c` / `sh -c` / `dash -c` of the same (two levels deep)
  - `cd`

  The only redirections allowed are to `/dev/null` and fd dups (`2>&1`).
- **Keeps the STOP** (no rewrite, no allow — the allow would cover the whole command):
  - anything mixed with other work: `rm -rf x && echo done`, `rm -rf x | sh`, `rm $(…)`, backticks, a heredoc
  - a redirection that writes a file (`rm -rf x > ~/.bashrc`; `/dev/null` passes, `/dev/null-x` does not)
  - a backgrounded `rm -rf x &`: the receipt would come before the shim wrote its lines
  - `${VAR@P}` anywhere: a prompt expansion runs a `$(…)` held in the variable's value
  - an `xargs` flag that takes an argument (`xargs -E rm sh -c '…' rm -rf` runs `sh`)
  - `zsh -c` (it reads `~/.zshenv` first) and `bash -lc`
  - anything that changes what `rm` resolves to: `PATH=`, zsh array `path=(…)`/`path+=(…)`, `printf -v PATH`, `read PATH`, `alias rm=`, `hash -p … rm`, `hash rm=…`, `rm()`, also inside `eval` (see [#689](#the-rm-override-spellings-689))
  - `sudo rm`, `/bin/rm`, `command -p rm`, `env rm`, `ssh host rm`, `docker exec … rm`, `git rm`
  - any call without Claude Code's client marker
- **Not covered at all:**
  - `rm` without `-r`/`-R` (the tripwire has no row for it, so it runs as the system's)
  - `rm x -rf` (flags after the operand: no row; GNU rm permutes and removes recursively, BSD rm does not)
  - a function named `find`, `xargs`, `cd`, `bash` or `sh` in the user's shell snapshot runs as it does today
  - `find -delete`, `rmdir`, `unlink`, deletes from code (`fs.rm`, `shutil.rmtree`); `git clean` only through the git snapshots below
  - `save_document(overwrite: true)` unlinking the previous version inside bastra itself

Archiving is a move: `rm` does not free disk space until the archive lets the entry go. On a full disk the shim refuses instead of freeing space (#695): the target stays, nothing is deleted, and the message names `bastra archive reconcile --yes`, `/bin/rm` and `bastra config set archive.enabled off`. "Full" is an ENOSPC from the move, its directories (the volume's own `.bastra-archive` included) or the manifest line. Empty directories a failed move had made are removed again.

#### Why it is safe

- **Other hooks' `deny` wins over this `allow`, and so do the user's own rules.** Tested with a real `claude -p`: `permissions.deny: ["Bash(rm:*)"]` → denied, target left in place; `permissions.ask: ["Bash(rm:*)"]` → asked. The rewrite keeps `rm …` on a line of its own for this reason: a one-line prefix form (`PATH=<shims>:$PATH rm -rf x`) was tried and ran without asking under the `ask` rule, so it is not used.
- **Fail-closed.** If the shim is not on the client's disk (a daemon on another host), the first check exits 97 and nothing runs. A shim that cannot run its node fails with 126/127 and deletes nothing. An `rm()` function the shell brought along is unset before PATH is changed; Claude Code's snapshot already clears aliases.
- **Refused:** `/`, `~` and the system dirs (`rm -rf "$EMPTY"/` resolves to `/` and is refused); the temp roots themselves; the archive and its ancestors; `.` and `..`; a target on another filesystem with no writable place for `.bastra-archive` (a read-only volume) — refused and left in place.
- **No move without an address.** If the manifest line cannot be written after the rename, the rename is undone and `rm` fails.
- **How Claude Code runs it** (measured on macOS): `/opt/homebrew/bin/bash -c 'source <snapshot> … && eval '<command>' < /dev/null && pwd -P >| …'` — Homebrew's bash 5, not `/bin/bash` 3.2 and not zsh; the rewritten command is the `<command>` inside that `eval`.
- **Tests do not touch `~/.bastra`:** `scripts/test-env.mjs` turns the shim off by default and moves the archive into the run root.

#### Why the trash lives in bastra

1. **The rewrite is the tripwire's decision.** Only the PreToolUse hook sees the command before it runs and can replace it, and bastra already owns that hook. A trash living elsewhere would need a second parser deciding "is this rm-only"; two parsers that disagree produce either an allow on something that is not archived, or a STOP on something that is.
2. **The receipt has to be true.** With the mechanism in the same package, the text "archiving" and the fact ship together: the hint only says it when the shim is on this disk and the command is one the shim will actually run.
3. **The receipt needs the post lane.** "What actually happened" is keyed by `tool_use_id`, and bastra's PostToolUse lane is where that id arrives.
4. **It is not memory.** No note is written per `rm`. The archive is maintenance, like `.bastra/trash` for notes.

The mechanism stays small: a synchronous rename, no daemon on the `rm` path. A daemon that is down changes nothing about `rm`.

### Git snapshots (#692)

The same principle for the git acts that lose work. Claude Code's stop on an irreversible act stays; the act is made reversible so that nothing is left to stop, and the model is told what really happened. A default may change **how** an act runs, never **what the caller observes afterwards**: the same end state, or a refusal the next step cannot miss.

For a Bash command made only of the acts below (plus `cd`, `rm`, and `git -C <dir>`), the bash-pre lane answers `allow` with the same rewrite as the archiving `rm`. `shims/git` sits next to `shims/rm`; for a command with a git act the rewrite also checks that `shims/git` is there (exit 97 if not).

| act | first | then |
|---|---|---|
| `git clean -f…` | lists exactly what `git clean -n` with the same flags lists | moves those paths through the archiving `rm` (same end state, now in the archive), prints git's own `Removing …` lines |
| `git reset --hard [<commit>]` | `git stash create` — a commit of the uncommitted tracked changes, index included; **the stash list is not touched** — pinned as `refs/bastra-archive/reset/<time>-<n>` | runs the act as typed |
| `git checkout [<tree>] -- <paths>`, `git restore [--source=<tree>] [--staged] [--worktree] <paths>` | the same snapshot, pinned; the files the act discards are recorded one by one | runs the act as typed |
| `git branch -D [-r] <name>…` | pins each branch's commit | runs the act as typed |
| `git stash drop [<stash>]`, `git stash clear` | pins each stash commit about to be dropped | runs the act as typed |

An untracked file is in no stash. Where `reset --hard <commit>`, `checkout <tree> -- <path>` or `restore --source` would overwrite one, the file goes through the archiving `rm` first. The end state is the same, and the file is in the archive.

After the command, the receipt names each pin and the command that puts it back, for example:

> before `git reset --hard` in /…/g1: saved fd1f8c3328 as refs/bastra-archive/reset/20260927-034051-29909-0 (restore: `git -C /…/g1 stash apply --index fd1f8c33…`, or `bastra archive restore refs/bastra-archive/reset/…`)

The restore commands:

- reset: `stash apply --index <sha>`
- checkout / restore: `restore --source=<sha> --worktree -- <files>`, and before it `restore --source=<sha>^2 --staged -- <files>` where the act also wrote the index
- branch: `branch <name> <sha>`, or `update-ref refs/remotes/<name> <sha>` for `-r`
- stash: `stash store -m <msg> <sha>`

`bastra archive restore <ref|sha>` runs the recorded command, and only those shapes: the manifest is a plain file, and a row with any other command is refused. A path act whose paths lose nothing gets no pin and no receipt. Pins are refs, so `git gc` cannot take the commits. Reconcile deletes a pin after the user retention (2 days by default), only a ref under `refs/bastra-archive/`, and only while it still names the same sha.

**Visible side effect:** pins show up in `git log --all` and `git for-each-ref` until reconcile deletes them, and a `git push --mirror` would publish them. Branches, tags, the stash list, the worktree and the index are exactly as after the real act.

#### Where it refuses, and what it does not take

The act runs under the hook's `allow`, so it must not become a way to run code the user never approved, and it must not discard what no snapshot holds.

- **Refused before acting** (exit 1, nothing changed, one stderr line that says why):
  - the repository would run its own code on the act: `core.fsmonitor` (any value but false), `core.hooksPath` or a `filter.*` driver set by the repository. The config is read with scopes (`git config --show-scope --list`); a value counts as the repository's when its scope is `local`, `worktree` or `command` — that covers `include.path` / `includeIf`, `config.worktree`, and `GIT_CONFIG_*` in the environment. A global `filter.lfs.*` is the user's own install and does not count.
  - a partial clone (`extensions.partialClone`, `remote.<name>.promisor`): a missing object would be fetched during the act through the repository's own remote settings.
  - an executable hook the act would run: `post-index-change` and `reference-transaction` (reset, checkout, restore), `post-checkout` (checkout, restore), `reference-transaction` (branch, stash).
  - no snapshot can hold what the act discards: submodules with `submodule.recurse` on; an edit in a file marked `assume-unchanged` or `skip-worktree` (git stash does not look at it); an index with unmerged paths (a merge, rebase or cherry-pick in progress), a file added with `git add -N`, a repository without a commit.
  - The shim's own git calls run with fsmonitor off and hooks pointed at `/dev/null`. It needs git 2.26 or newer (`--show-scope`); with an older git it refuses.
- **No allow** (the STOP; where no tripwire row trips, as for a switch, no hint at all):
  - any global option but `-C` (`-c core.fsmonitor=…` would run code)
  - a `VAR=` before `git`, also through `env` (`GIT_DIR`, `GIT_CONFIG_COUNT/KEY/VALUE` inject config)
  - `command -p git`, an absolute `/usr/bin/git`, `zsh -c`, `bash -lc`
  - a `git()` function or `alias git=` in the same command
  - anything mixed with other work, a redirection that writes a file, a backgrounded act
  - a form outside an act's own short list of flags: `-p` / `--patch`, `-m` / `--merge` / `--conflict`, `--recurse-submodules`, `--pathspec-from-file`, `clean -n`, `clean -i`, and a switch written with `--` (`git checkout main --`)
- **Checked again at run time.** The lane allows the command as written; the shell expands it afterwards (`git restore {-p,a}` arrives as `git restore -p a`). Inside an allowed command the shim runs nothing that is not an act: it exits 1 and says so.
- **Not taken, on purpose:** `git commit --amend` and `git rebase` run the repository's hooks and may open an editor; `git push --force` publishes (the hint keeps naming `--force-with-lease`); `git reflog expire` and `git gc --prune` have no reversible form, so the STOP stays — the pins survive them.

#### Tripwire rows

New rows, each with a hint when the shim is off:

- `git restore <paths>` (no `--source`, no `--staged`): the same reversible form as `checkout --`.
- `git checkout <tree> -- <paths>`, and `git restore --source=<tree>` / `--staged --worktree`: their recipe is `git stash push --keep-index -- <paths>` first, then the command as typed. `git restore --staged` alone only resets the index and trips no row.
- `git stash drop|clear`: a receipt; the dropped commit stays until gc, `git fsck --unreachable` finds it and `git stash store` puts it back.

Existing rows read wider: a flag in front used to hide the act from its row (`git checkout -q -- <paths>`, `git reset -q --hard`, `git branch -q -D`, a delete written as `-d -f` or `--delete --force`).

#### What our own transcripts say

From a transcript harvest of agent sessions on two hosts (losses are the ones stated in prose, read by hand, so a lower bound): `checkout … -- <paths>` ran 172 times with 3 stated losses, `reset --hard` 25, `branch -D` 15, `stash drop` 7, `restore` 4, `clean -f` 1, all without a stated loss. The shim takes 224 of these calls, and 3 of the 9 stated losses are in them, all three `checkout --` over uncommitted edits. 56 of the checkouts and resets had a tree or a flag in front and tripped no row before #692. The other losses came from `git stash` / `git stash pop` in the wrong place (4, git kept the content each time), one `push --force` to the wrong remote, and one commit that swept in another session's file.

### The rm override spellings (#689)

The archiving `rm` depends on knowing when a command changes what `rm` resolves to. #689 widened that check:

- `hash -p <path> <names…>` counts when `rm` is among the names; `hash -p /usr/bin/python3 python; rm -rf dist` keeps its normal receipt. (#696 extended this to every listed name, e.g. `hash -p /x rm python`.)
- zsh array assignments `path=(…)` and `path+=(…)` change PATH. So do `hash rm=<path>`, `printf -v PATH …`, `read PATH`, and a nameref such as `declare -n p=PATH`; they keep STOP before a later destructive `rm`.
- The verb is read at command position, past assignments, the reserved words that open a compound (`{ ! if then else elif do while until`, `time [-p]`, #694) and the `builtin` / `command` prefixes, so `{ hash -p /x rm; }`, `builtin hash …` and `command hash …` count, while `echo hash -p /bin/rm rm` or `sudo hash …` (a child shell) do not.
- An `eval` body is shell, so it is read again (up to two levels); a body the scanner cannot read counts as a change. This also closes `eval 'export PATH=/x:$PATH'; rm -rf x`.
- An `rm()` definition is found without a quote boundary, so `grep -rn "rm()" src; rm -rf dist` keeps its receipt, while a quoted `eval` definition is still a STOP through the eval re-read.

### Turning it on and off

- On: `bastra config set archive.enabled on`, or `BASTRA_RM_ARCHIVES=1` in the daemon's environment (env wins). Re-run `bastra install` once so the Claude Code hooks carry the client marker; `bastra doctor` warns when the opt-in is on but the Bash hook lacks it.
- With the opt-in on, `BASTRA_RM_SHIM=0` leaves out the `rm` part and `BASTRA_GIT_SHIM=0` the git part. A command the switched-off shim would have taken keeps the STOP and gets one extra line saying what it would have saved; the wording follows the user's own Claude Code permission rules (with an `ask` rule it says the command would still be asked about; with a `deny` rule there is no line). Each such command is a telemetry event `rm_shim_shadow` / `git_shim_shadow`. Nothing is written to the vault.
- Each shim runs only where it is on: with one of the two switched off, a command that needs both (`rm -rf build && git stash drop`) is not rewritten. `shims/git` also reads `BASTRA_GIT_SHIM=0` from its own environment and then hands every call to the real git.
- A host with its own archiving `rm` sets `BASTRA_RM_ARCHIVES=host`: receipt text, no rewrite.

### How it was tested (at the time of the PRs)

- Real `claude -p` end-to-end runs on Linux and macOS (Claude Code 2.1.283, default permission mode): rm-only allowed and archived with a quoted receipt, temp really deleted, mixed commands and file redirections kept the STOP, user `deny` / `ask` rules won; for git, `reset --hard`, `checkout HEAD~1 -- a`, `clean -fd && stash drop` and others were allowed with pins that `bastra archive restore` brought back, and a repository with `core.fsmonitor` in an included config file was refused with the planted program not run.
- Two independent attack passes on the archiving `rm` (second volumes incl. read-only and full images, symlinks, odd names, 200 parallel `rm` processes on one manifest, over 70 and 135 commands through the policy) and one adversarial pass on the git shim; each finding got a repro and a test. Mutation checks: 31/31 red for `rm-archive`, 60/60 for the git part, each named in the test's `Revert-check:` comment.
- The details, tables and every finding are in the PR descriptions: [#690](https://github.com/n0mad-ai/bastra-recall/pull/690), [#692](https://github.com/n0mad-ai/bastra-recall/pull/692).

### Known limits and left for later

- **Full disk:** archiving is a move, so `rm` refuses with ENOSPC instead of freeing space, and says how to free it (#695). A "free space now" path is not built.
- **Other volumes:** a target on a USB or network drive goes to `<mount>/.bastra-archive` there, outside `~/.bastra`, or is refused where none can be made.
- **Restore edges:** after `rm -r a/b a`, restoring `a/b` first recreates `a`, and `a` then refuses to overwrite it — restore the parent first. A path typed through a symlinked parent that has since gone is not found by that spelling; the receipt names the resolved path, which is.
- **Cost per target:** three `git` calls per target inside a repository (for the class). `find … -exec rm {} \;` starts one node per file (about 83 ms per tracked file measured); `-exec {} +` batches.
- **Not built:** restore via MCP (`restore_file`, `trash_list`); `save_document(overwrite: true)` into the same archive; a hint on a bare `git stash pop`; `git read-tree -u --reset`; snapshots during a merge in progress (refused today); a single rolling ref per repository instead of one pin per act; other clients (Codex, Cursor, …) keep the STOP.
- Reserved words (`{ …; }`, `if`, `!`, `time`) in front of an rm redefinition: #694.

<a id="deutsch"></a>

## Deutsch

> **Entworfen und umgesetzt von [@zzallirog](https://github.com/zzallirog) (PRs [#689](https://github.com/n0mad-ai/bastra-recall/pull/689), [#690](https://github.com/n0mad-ai/bastra-recall/pull/690), [#692](https://github.com/n0mad-ai/bastra-recall/pull/692)); diese Seite bewahrt die Beschreibungen dieser PRs.**
> Die Arbeit kam über [#696](https://github.com/n0mad-ai/bastra-recall/pull/696) als ein gesquashter Commit nach `main`; seine Commits stehen deshalb nicht in der Historie von `main`. Seine PR-Beschreibungen erklären, wie die Funktion arbeitet, ohne dass man den Code lesen muss. Der Text unten folgt ihnen, angepasst an den gemergten Stand. Die Kurzreferenz (Einstellungen, Variablen-Tabelle) steht in [hooks.md](./hooks.md#deutsch).

### Was #696 beim Übernehmen geändert hat

- **Opt-in, standardmäßig aus.** `bastra config set archive.enabled on` (steht in `~/.bastra/cli-settings.json`, gilt ab dem nächsten Bash-Aufruf) oder `BASTRA_RM_ARCHIVES=1` in der Umgebung des Daemons. Ist die Variable gesetzt, gewinnt sie; jeder andere Wert schaltet aus. Ein Schalter für das archivierende `rm` und die Git-Schnappschüsse. `bastra install` und das Onboarding schalten es nie ein; `bastra doctor` führt es unter den bewusst ausgeschalteten Funktionen.
- **Nur für belegte Claude-Code-Aufrufe.** Der Hook-Aufruf muss die Kennung `BASTRA_HOOK_CLIENT=claude-code` tragen, die `bastra install` jetzt vor jeden Claude-Code-Hook-Befehl schreibt (einmal neu ausführen). Ein Aufruf ohne Kennung behält das STOP. Im PR hieß es „jede Oberfläche außer `claude-code`"; gemergt entscheidet diese Kennung.
- **Aus heißt wie bisher.** Ist der Opt-in aus, bekommen `rm -r` und die Git-Befehle genau den Hinweis wie ohne die Funktion: kein Umschreiben, kein `allow`, keine Zusatzzeile, kein Shadow-Ereignis.
- **Die schmalen Schalter.** `BASTRA_RM_SHIM=0` / `BASTRA_GIT_SHIM=0` schränken einen eingeschalteten Opt-in nur ein: Sie lassen den `rm`- oder den Git-Teil weg.
- **`BASTRA_RM_ARCHIVES=host`** ist die Einstellung für einen Host mit eigenem archivierenden `rm` (nur Quittungstext, kein Umschreiben). Im PR bedeutete das `=1`; jetzt schaltet `=1` bastras eigenes Archiv ein.
- **Node-Pfad.** Die Umschreibung nennt Homebrews `opt/<formula>/bin/node`, wenn das auf die Node des Daemons zeigt, damit `brew upgrade node` sie nicht bricht; fehlt der Pfad trotzdem, nimmt der Shim `node` aus dem PATH.

### Warum: das Problem, gemessen (#690)

Eine Auswertung aller gestoppten Bash-`rm` in den Transkripten zweier Rechner (29.05. bis 26.09.2026):

- **826** Stopps: 712 bei echtem Löschen, **114 (13,8 %)** bei Text, der `rm` nur enthält (Commit-Nachricht, Test-String, Heredoc).
- **565** verschiedene Tool-Aufrufe wurden gestoppt, in 190 Sitzungen. **359** davon bekamen nur bastras STOP-Hinweis und liefen trotzdem: Der Hinweis ist Kontext, er blockiert nichts.
- **206** Aufrufe wurden wirklich blockiert (Claude Codes Berechtigungsprüfung oder ein Host-Wächter). Danach zog sich das Modell in 76,2 % zurück (ohne `rm` neu gestartet oder das Aufräumen gelassen), löschte dasselbe Ziel in 10,2 % auf anderem Weg, nahm in 5,8 % einen Umweg (`mv`, `find -delete`, …), wiederholte den blockierten Befehl in 5,3 % und gab es in 1,9 % an den Nutzer weiter.
- Was die blockierten Löschungen trafen: Temp 61,2 %, Build-Müll 7,1 %, eigene Scratch-Dateien des Modells 12,7 %, git-verfolgt 6,6 %, **Nutzer-/Projekt-/Systemdateien 12,2 % (24)** — die meisten dieser 24 hatte die Aufgabe verlangt.
- **Hat ein STOP je etwas Wichtiges gerettet? Kein Fall gefunden.**

Der Stopp kostet also jedes Mal ein wenig und hat nachweisbar nichts gerettet. Vorher weiß aber niemand, welche Löschung harmlos ist, und 12 % der blockierten trafen echte Dateien. Deshalb ein Papierkorb mit Adresse, kein bloßes Freigeben.

### Das archivierende `rm` (#690)

**1. bash-pre: umschreiben und freigeben.** Für einen Claude-Code-Befehl, der *nur* aus `rm` besteht (Grenze unten), antwortet die bash-pre-Lane mit `permissionDecision: "allow"` und einem `updatedInput` mit diesem Befehl:

```
[ -x '<pkg>/shims/rm' ] || exit 97; unset -f rm git 2>/dev/null; export PATH='<pkg>/shims':"$PATH" BASTRA_RM_CALL='<tool_use_id>' BASTRA_NODE='<node>'
<der Befehl genau wie geschrieben>
```

Globs, Variablen und `cd` expandiert die Shell wie immer. Der Shim bekommt genau die Argumente, die das System-`rm` bekommen hätte. Der Hinweis sagt, dass bastra den Befehl mit seinem archivierenden `rm` ausführt, statt STOP.

**2. Der Shim** (`shims/rm` → `rm-shim.js`, Quelle `packages/daemon/src/rm-archive.ts`) verschiebt jedes Ziel nach `~/.bastra/archive/<Datum>/<HHMMSS-PID>/<voller Pfad>`. Auf demselben Dateisystem ist das ein Umbenennen. Ein Ziel auf einem anderen Dateisystem geht nach `<mount>/.bastra-archive`. Exit-Codes und Meldungen von `rm` bleiben (`-f`, fehlender Operand, „Is a directory", `-d`).

- Temp-Bereiche (`/tmp`, `/var/tmp`, `/dev/shm`, `/run/user/<uid>`, `$TMPDIR`, unter macOS `/private/tmp` und `/private/var/folders`, Claude Codes Scratchpads) werden **wirklich gelöscht**.
- `/`, `~`, Systemverzeichnisse, die Temp-Wurzeln selbst, das Archiv und seine Elternverzeichnisse sowie `.`/`..` werden verweigert.
- Jede Tat (archiviert / gelöscht / verweigert) ist eine Zeile in `manifest.jsonl`, markiert mit der Tool-Call-ID.

**3. bash post: die Quittung.** Die PostToolUse-Lane liest die Manifest-Zeilen dieser `tool_use_id` zurück und hängt sie an `additionalContext`, etwa:

```
- archived /…/work/victim g → /…/archive/2026-09-27/000824-78840/…/victim g (restore: `bastra archive restore '/…/work/victim g'`)
```

Das Modell erfährt, was tatsächlich passiert ist, nicht was der Pre-Hook vorhergesagt hat. Die ersten 25 Ziele werden genannt, der Rest gezählt — ein `find … -exec rm` über einen Baum brachte einmal 600 Zeilen in den Kontext.

**4. Aufräumen.** Höchstens stündlich: Die Post-Lane startet `bastra archive reconcile --yes` als abgekoppelten Kindprozess, wenn der letzte Lauf über eine Stunde her ist (vor dem Start gestempelt, läuft also nie in der Event-Loop des Daemons). Von Hand: `bastra archive reconcile [--yes]`. Ein Eintrag geht, wenn sein Ziel mit gleichem Inhalt zurückgekommen ist oder wenn er älter ist als seine Klasse ihn hält:

| Klasse | was | Frist (Standard) |
|---|---|---|
| `junk` | ein node_modules-/build-/cache-Ziel oder alles in einem Tool-Cache | 1 Tag |
| `in-git` | verfolgt und laut git unverändert (ein fehlgeschlagenes oder abgelaufenes `git status` gilt nicht als sauber), nichts Unverfolgtes oder Ignoriertes darin, keine Repository-Wurzel | 2 Tage |
| `user` | alles andere | 2 Tage |

Ändern mit `bastra config set archive.retain junk=1,in-git=2,user=2` oder `BASTRA_ARCHIVE_RETAIN` (die Variable gewinnt). Es gibt eine Obergrenze, 10 GB, wenn nichts anderes eingestellt ist (unten): Sie wirft zuerst junk, dann in-git, und nie einen user-Eintrag vor Ablauf seiner Frist. Git-Schnappschüsse (unten) halten die Nutzer-Frist und fallen nie der Obergrenze zum Opfer. Reconcile entfernt nur ein Ziel, das in einem Archiv liegt: Das Manifest ist eine einfache Datei, und eine kaputte oder fremde Zeile darf es nirgendwo anders hinlenken. Ab 1 MB wird das Manifest rotiert (ein Umbenennen, ein gleichzeitig schreibender Shim landet in einer der beiden Dateien); ein rotiertes geht nach 30 Tagen, wenn keine seiner Zeilen mehr lebt. Eine Quittung liest nur die aktuelle Datei.

**Grenzen (#934).** Zwei Größen stellt der Nutzer selbst ein, geschrieben wie `5GB` oder `500MB` (KB, MB, GB, TB; 1 GB = 2^30 Bytes):

| Einstellung | Variable (gewinnt) | Standard | Wirkung |
|---|---|---|---|
| `bastra config set archive.cap 5GB` | `BASTRA_ARCHIVE_CAP` | 10 GB | Wie viel das ganze Archiv halten darf. Darüber wirft der stündliche Reconcile zuerst junk, dann in-git, und nie einen user-Eintrag vor Ablauf seiner Frist. |
| `bastra config set archive.max-item 2GB` | `BASTRA_ARCHIVE_MAX_ITEM` | keine | Das größte Ziel, das das Archiv aufnimmt. `off` entfernt eine gespeicherte Grenze. |

Ein Ziel über `archive.max-item` wird weder archiviert noch gelöscht: `rm` endet mit einem Fehlercode, das Ziel bleibt, und die Meldung nennt die Grenze, wie weit die Zählung kam, und die Auswege (`/bin/rm` oder eine höhere Grenze). Das ist wieder die Regel aus #695: eine klare Verweigerung, nie ein stilles echtes Löschen. Temp-Boden wird weiterhin wirklich entfernt, egal wie groß.

So wird die Größe gemessen: Der Shim läuft das Ziel mit `lstat` ab und addiert die Dateigrößen. Ohne Grenze endet dieser Lauf nach 50.000 Einträgen, weil die Zahl nur ins Manifest geht. Mit Grenze muss sie stimmen, also läuft er über 50.000 Einträge hinaus und hört auf, sobald die Summe über der Grenze liegt. Ein Ziel über der Grenze kostet damit weniger als bisher; ein sehr großer Baum *unter* der Grenze wird ganz abgelaufen (etwa 80.000 bis 220.000 Dateien pro Sekunde auf einer Laptop-SSD). Der Daemon liest die Einstellung und gibt die Grenze im umgeschriebenen Befehl an den Shim (`BASTRA_ARCHIVE_MAX_ITEM=<Bytes>B`); der Shim selbst liest keine Einstellungsdatei. `bastra doctor` zeigt beide wirksamen Werte in der Archiv-Zeile, solange das Archiv an ist.

**5. CLI:** `bastra archive list | restore <Pfad> | reconcile [--yes]`.

#### Was umgeschrieben wird, was das STOP behält, was nicht abgedeckt ist

- **Umgeschrieben und freigegeben:** ein Befehl, dessen einfache Befehle alle so aussehen:
  - `rm …`, `command rm …` oder `\rm …` (mit `-r`, `-R` oder `--recursive`)
  - `xargs <Flags ohne Argument> rm …` (`-0 -r -t -x -nN -LN -PN` und ihre Langformen)
  - `find … -exec|-execdir|-ok|-okdir rm …`, ohne `-delete`, `-fprint*` oder `-fls`
  - `bash -c` / `sh -c` / `dash -c` davon (zwei Ebenen tief)
  - `cd`

  Erlaubte Umleitungen: nur nach `/dev/null` und fd-Duplikate (`2>&1`).
- **Behält das STOP** (kein Umschreiben, kein allow — das allow würde den ganzen Befehl decken):
  - alles, was mit anderer Arbeit gemischt ist: `rm -rf x && echo done`, `rm -rf x | sh`, `rm $(…)`, Backticks, ein Heredoc
  - eine Umleitung in eine Datei (`rm -rf x > ~/.bashrc`; `/dev/null` geht, `/dev/null-x` nicht)
  - `rm -rf x &` im Hintergrund: Die Quittung käme, bevor der Shim geschrieben hat
  - `${VAR@P}` irgendwo: eine Prompt-Expansion führt ein `$(…)` im Wert der Variablen aus
  - ein `xargs`-Flag mit Argument (`xargs -E rm sh -c '…' rm -rf` startet `sh`)
  - `zsh -c` (liest vorher `~/.zshenv`) und `bash -lc`
  - alles, was ändert, was `rm` ist: `PATH=`, zsh-Arrays `path=(…)`/`path+=(…)`, `printf -v PATH`, `read PATH`, `alias rm=`, `hash -p … rm`, `hash rm=…`, `rm()`, auch in `eval` (siehe [#689](#die-schreibweisen-einer-rm-umdefinition-689))
  - `sudo rm`, `/bin/rm`, `command -p rm`, `env rm`, `ssh host rm`, `docker exec … rm`, `git rm`
  - jeder Aufruf ohne Claude-Code-Kennung
- **Gar nicht abgedeckt:**
  - `rm` ohne `-r`/`-R` (der Tripwire hat keine Zeile dafür, es läuft als System-`rm`)
  - `rm x -rf` (Flags nach dem Operanden: keine Zeile; GNU-rm sortiert um und löscht rekursiv, BSD-rm nicht)
  - eine Funktion `find`, `xargs`, `cd`, `bash` oder `sh` im Shell-Snapshot des Nutzers läuft wie bisher
  - `find -delete`, `rmdir`, `unlink`, Löschen aus Code (`fs.rm`, `shutil.rmtree`); `git clean` nur über die Git-Schnappschüsse unten
  - `save_document(overwrite: true)`, das in bastra selbst die Vorversion löscht

Archivieren ist Verschieben: `rm` gibt keinen Platz frei, bis das Archiv den Eintrag loslässt. Auf einer vollen Platte verweigert der Shim, statt Platz zu schaffen (#695): Das Ziel bleibt, nichts wird gelöscht, und die Meldung nennt `bastra archive reconcile --yes`, `/bin/rm` und `bastra config set archive.enabled off`. „Voll" heißt: ENOSPC beim Verschieben, bei dessen Verzeichnissen (auch dem `.bastra-archive` des Laufwerks) oder bei der Manifestzeile. Leere Verzeichnisse, die ein gescheitertes Verschieben angelegt hatte, werden wieder entfernt.

#### Warum es sicher ist

- **Das `deny` anderer Hooks gewinnt über dieses `allow`, ebenso die eigenen Regeln des Nutzers.** Getestet mit echtem `claude -p`: `permissions.deny: ["Bash(rm:*)"]` → verweigert, Ziel bleibt; `permissions.ask: ["Bash(rm:*)"]` → nachgefragt. Deshalb steht `rm …` in der Umschreibung auf einer eigenen Zeile: Eine einzeilige Präfix-Form (`PATH=<shims>:$PATH rm -rf x`) lief unter der `ask`-Regel ohne Nachfrage und wird darum nicht benutzt.
- **Fail-closed.** Liegt der Shim nicht auf der Platte des Clients (Daemon auf einem anderen Rechner), endet die erste Prüfung mit Exit 97 und nichts läuft. Ein Shim, der seine Node nicht starten kann, endet mit 126/127 und löscht nichts. Eine mitgebrachte `rm()`-Funktion wird vor dem PATH-Wechsel entfernt; Aliase räumt Claude Codes Snapshot schon ab.
- **Verweigert:** `/`, `~` und Systemverzeichnisse (`rm -rf "$EMPTY"/` wird zu `/` und verweigert); die Temp-Wurzeln selbst; das Archiv und seine Elternverzeichnisse; `.` und `..`; ein Ziel auf einem anderen Dateisystem ohne beschreibbaren Platz für `.bastra-archive` (schreibgeschütztes Laufwerk) — verweigert und liegen gelassen.
- **Kein Verschieben ohne Adresse.** Lässt sich die Manifest-Zeile nach dem Umbenennen nicht schreiben, wird das Umbenennen rückgängig gemacht und `rm` schlägt fehl.
- **Wie Claude Code es ausführt** (gemessen unter macOS): `/opt/homebrew/bin/bash -c 'source <snapshot> … && eval '<command>' < /dev/null && pwd -P >| …'` — Homebrews bash 5, nicht `/bin/bash` 3.2 und nicht zsh; der umgeschriebene Befehl ist das `<command>` in diesem `eval`.
- **Tests fassen `~/.bastra` nicht an:** `scripts/test-env.mjs` schaltet den Shim standardmäßig ab und legt das Archiv ins Laufverzeichnis.

#### Warum der Papierkorb in bastra wohnt

1. **Das Umschreiben ist die Entscheidung des Tripwires.** Nur der PreToolUse-Hook sieht den Befehl vorher und kann ihn ersetzen, und diesen Hook hat bastra schon. Ein Papierkorb anderswo bräuchte einen zweiten Parser für „ist das nur rm"; zwei Parser, die sich widersprechen, geben entweder ein allow ohne Archiv oder ein STOP auf etwas, das archiviert würde.
2. **Die Quittung muss stimmen.** Mit dem Mechanismus im selben Paket kommen der Text „archiviert" und die Tatsache zusammen: Der Hinweis sagt es nur, wenn der Shim auf dieser Platte liegt und den Befehl wirklich ausführt.
3. **Die Quittung braucht die Post-Lane.** „Was tatsächlich passiert ist" hängt an der `tool_use_id`, und die kommt in bastras PostToolUse-Lane an.
4. **Es ist kein Gedächtnis.** Pro `rm` wird keine Notiz geschrieben. Das Archiv ist Wartung, wie `.bastra/trash` für Notizen.

Der Mechanismus bleibt klein: ein synchrones Umbenennen, kein Daemon auf dem `rm`-Pfad. Ein Daemon, der nicht läuft, ändert an `rm` nichts.

### Git-Schnappschüsse (#692)

Dasselbe Prinzip für Git-Taten, die Arbeit verlieren. Claude Codes Stopp bei einer unumkehrbaren Tat bleibt; die Tat wird umkehrbar gemacht, sodass nichts mehr zu stoppen ist, und das Modell erfährt, was wirklich passiert ist. Ein Standard darf ändern, **wie** eine Tat läuft, nie **was der Aufrufer danach sieht**: derselbe Endzustand oder eine Verweigerung, die der nächste Schritt nicht übersehen kann.

Für einen Bash-Befehl nur aus den Taten unten (plus `cd`, `rm` und `git -C <dir>`) antwortet die bash-pre-Lane mit `allow` und derselben Umschreibung wie beim archivierenden `rm`. `shims/git` liegt neben `shims/rm`; bei einem Befehl mit Git-Tat prüft die Umschreibung zusätzlich, dass `shims/git` da ist (sonst Exit 97).

| Tat | zuerst | dann |
|---|---|---|
| `git clean -f…` | listet genau, was `git clean -n` mit denselben Flags listet | verschiebt diese Pfade über das archivierende `rm` (gleicher Endzustand, jetzt im Archiv), gibt gits eigene `Removing …`-Zeilen aus |
| `git reset --hard [<commit>]` | `git stash create` — ein Commit der nicht committeten verfolgten Änderungen samt Index; **die Stash-Liste bleibt unberührt** — gepinnt als `refs/bastra-archive/reset/<Zeit>-<n>` | führt die Tat wie getippt aus |
| `git checkout [<tree>] -- <Pfade>`, `git restore [--source=<tree>] [--staged] [--worktree] <Pfade>` | derselbe Schnappschuss, gepinnt; die verworfenen Dateien werden einzeln festgehalten | führt die Tat wie getippt aus |
| `git branch -D [-r] <Name>…` | pinnt den Commit jedes Branches | führt die Tat wie getippt aus |
| `git stash drop [<stash>]`, `git stash clear` | pinnt jeden Stash-Commit, der gleich verworfen wird | führt die Tat wie getippt aus |

Eine unverfolgte Datei steckt in keinem Stash. Wo `reset --hard <commit>`, `checkout <tree> -- <Pfad>` oder `restore --source` eine überschreiben würde, geht sie zuerst durch das archivierende `rm`. Endzustand gleich, Datei im Archiv.

Nach dem Befehl nennt die Quittung jeden Pin und den Befehl, der ihn zurückholt, etwa:

> before `git reset --hard` in /…/g1: saved fd1f8c3328 as refs/bastra-archive/reset/20260927-034051-29909-0 (restore: `git -C /…/g1 stash apply --index fd1f8c33…`, or `bastra archive restore refs/bastra-archive/reset/…`)

Die Befehle zum Zurückholen:

- reset: `stash apply --index <sha>`
- checkout / restore: `restore --source=<sha> --worktree -- <Dateien>`, davor `restore --source=<sha>^2 --staged -- <Dateien>`, wo die Tat auch den Index geschrieben hat
- branch: `branch <Name> <sha>`, bei `-r` `update-ref refs/remotes/<Name> <sha>`
- stash: `stash store -m <msg> <sha>`

`bastra archive restore <ref|sha>` führt den festgehaltenen Befehl aus, und nur diese Formen: Das Manifest ist eine einfache Datei, eine Zeile mit anderem Befehl wird verweigert. Eine Pfad-Tat, deren Pfade nichts verlieren, bekommt keinen Pin und keine Quittung. Pins sind Refs, `git gc` nimmt die Commits also nicht. Reconcile löscht einen Pin nach der Nutzer-Frist (Standard 2 Tage), nur unter `refs/bastra-archive/` und nur, solange er noch auf denselben sha zeigt.

**Sichtbare Nebenwirkung:** Pins erscheinen bis dahin in `git log --all` und `git for-each-ref`, und ein `git push --mirror` würde sie veröffentlichen. Branches, Tags, Stash-Liste, Arbeitsverzeichnis und Index sind genau wie nach der echten Tat.

#### Wo es verweigert und was es nicht übernimmt

Die Tat läuft unter dem `allow` des Hooks. Sie darf also weder Code ausführen, den der Nutzer nie freigegeben hat, noch verwerfen, was kein Schnappschuss hält.

- **Vorab verweigert** (Exit 1, nichts geändert, eine stderr-Zeile mit Grund):
  - das Repository würde bei der Tat eigenen Code ausführen: `core.fsmonitor` (jeder Wert außer false), `core.hooksPath` oder ein `filter.*`-Treiber, vom Repository gesetzt. Die Konfiguration wird mit Scopes gelesen (`git config --show-scope --list`); ein Wert gilt als die des Repositorys bei Scope `local`, `worktree` oder `command` — das deckt `include.path` / `includeIf`, `config.worktree` und `GIT_CONFIG_*` in der Umgebung. Ein globales `filter.lfs.*` ist die eigene Installation des Nutzers und zählt nicht.
  - ein Partial Clone (`extensions.partialClone`, `remote.<name>.promisor`): Ein fehlendes Objekt würde während der Tat über die Remote-Einstellungen des Repositorys geholt.
  - ein ausführbarer Hook, den die Tat starten würde: `post-index-change` und `reference-transaction` (reset, checkout, restore), `post-checkout` (checkout, restore), `reference-transaction` (branch, stash).
  - kein Schnappschuss hält, was die Tat verwirft: Submodule mit `submodule.recurse`; eine Änderung in einer Datei mit `assume-unchanged` oder `skip-worktree` (git stash sieht sie nicht); ein Index mit ungemergten Pfaden (Merge, Rebase oder Cherry-Pick läuft), eine mit `git add -N` hinzugefügte Datei, ein Repository ohne Commit.
  - Die eigenen Git-Aufrufe des Shims laufen mit fsmonitor aus und Hooks auf `/dev/null`. Er braucht git 2.26 oder neuer (`--show-scope`); mit älterem git verweigert er.
- **Kein allow** (das STOP; wo keine Tripwire-Zeile greift, etwa bei einem Branchwechsel, gar kein Hinweis):
  - jede globale Option außer `-C` (`-c core.fsmonitor=…` würde Code ausführen)
  - ein `VAR=` vor `git`, auch über `env` (`GIT_DIR`, `GIT_CONFIG_COUNT/KEY/VALUE` schleusen Konfiguration ein)
  - `command -p git`, ein absolutes `/usr/bin/git`, `zsh -c`, `bash -lc`
  - eine `git()`-Funktion oder `alias git=` im selben Befehl
  - alles mit anderer Arbeit Gemischte, eine Umleitung in eine Datei, eine Tat im Hintergrund
  - eine Form außerhalb der kurzen Flag-Liste der Tat: `-p` / `--patch`, `-m` / `--merge` / `--conflict`, `--recurse-submodules`, `--pathspec-from-file`, `clean -n`, `clean -i` und ein Branchwechsel mit `--` (`git checkout main --`)
- **Zur Laufzeit erneut geprüft.** Die Lane gibt den Befehl frei, wie er geschrieben ist; die Shell expandiert ihn danach (`git restore {-p,a}` kommt als `git restore -p a` an). Innerhalb eines freigegebenen Befehls führt der Shim nichts aus, was keine Tat ist: Exit 1 mit Meldung.
- **Bewusst nicht übernommen:** `git commit --amend` und `git rebase` starten die Hooks des Repositorys und öffnen evtl. einen Editor; `git push --force` veröffentlicht (der Hinweis nennt weiter `--force-with-lease`); `git reflog expire` und `git gc --prune` haben keine umkehrbare Form, das STOP bleibt — die Pins überstehen sie.

#### Tripwire-Zeilen

Neue Zeilen, jede mit Hinweis, wenn der Shim aus ist:

- `git restore <Pfade>` (ohne `--source`, ohne `--staged`): dieselbe umkehrbare Form wie `checkout --`.
- `git checkout <tree> -- <Pfade>` und `git restore --source=<tree>` / `--staged --worktree`: ihr Rezept ist zuerst `git stash push --keep-index -- <Pfade>`, dann der Befehl wie getippt. `git restore --staged` allein setzt nur den Index zurück und löst keine Zeile aus.
- `git stash drop|clear`: eine Quittung; der verworfene Commit bleibt bis zum gc, `git fsck --unreachable` findet ihn, `git stash store` legt ihn zurück.

Bestehende Zeilen lesen breiter: Ein Flag davor versteckte die Tat vor ihrer Zeile (`git checkout -q -- <Pfade>`, `git reset -q --hard`, `git branch -q -D`, ein Löschen als `-d -f` oder `--delete --force`).

#### Was unsere eigenen Transkripte sagen

Aus einer Auswertung von Agenten-Sitzungen auf zwei Rechnern (Verluste = in Prosa genannte, von Hand gelesen, also eine Untergrenze): `checkout … -- <Pfade>` lief 172-mal mit 3 genannten Verlusten, `reset --hard` 25-mal, `branch -D` 15, `stash drop` 7, `restore` 4, `clean -f` 1, alle ohne genannten Verlust. Der Shim übernimmt 224 dieser Aufrufe; 3 der 9 genannten Verluste liegen darin, alle drei `checkout --` über nicht committete Änderungen. 56 der Checkouts und Resets hatten einen Tree oder ein Flag davor und lösten vor #692 keine Zeile aus. Die übrigen Verluste kamen von `git stash` / `git stash pop` an der falschen Stelle (4, git hielt den Inhalt jedes Mal), einem `push --force` auf das falsche Remote und einem Commit, der die Datei einer anderen Sitzung mitnahm.

### Die Schreibweisen einer rm-Umdefinition (#689)

Das archivierende `rm` muss wissen, wann ein Befehl ändert, was `rm` ist. #689 hat diese Prüfung erweitert:

- `hash -p <Pfad> <Namen…>` zählt, wenn `rm` unter den Namen ist; `hash -p /usr/bin/python3 python; rm -rf dist` behält seine normale Quittung. (#696 hat das auf jeden genannten Namen ausgedehnt, z. B. `hash -p /x rm python`.)
- zsh-Array-Zuweisungen `path=(…)` und `path+=(…)` ändern PATH. Das gilt auch für `hash rm=<Pfad>`, `printf -v PATH …`, `read PATH` und eine Referenz wie `declare -n p=PATH`; vor einem späteren verlustreichen `rm` bleibt es bei STOP.
- Das Verb wird an Befehlsposition gelesen, hinter Zuweisungen, den reservierten Wörtern, die einen zusammengesetzten Befehl öffnen (`{ ! if then else elif do while until`, `time [-p]`, #694), und den Präfixen `builtin` / `command`: `{ hash -p /x rm; }`, `builtin hash …` und `command hash …` zählen, `echo hash -p /bin/rm rm` oder `sudo hash …` (eine Kind-Shell) nicht.
- Ein `eval`-Rumpf ist Shell und wird erneut gelesen (bis zu zwei Ebenen); ein Rumpf, den der Scanner nicht lesen kann, gilt als Änderung. Das schließt auch `eval 'export PATH=/x:$PATH'; rm -rf x`.
- Eine `rm()`-Definition wird ohne Anführungszeichen-Grenze erkannt: `grep -rn "rm()" src; rm -rf dist` behält seine Quittung, eine in Anführungszeichen stehende `eval`-Definition bleibt über das erneute Lesen ein STOP.

### Ein- und ausschalten

- Ein: `bastra config set archive.enabled on` oder `BASTRA_RM_ARCHIVES=1` in der Umgebung des Daemons (die Variable gewinnt). `bastra install` einmal neu ausführen, damit die Claude-Code-Hooks die Kennung tragen; `bastra doctor` warnt, wenn der Opt-in an ist, dem Bash-Hook die Kennung aber fehlt.
- Mit Opt-in lässt `BASTRA_RM_SHIM=0` den `rm`-Teil weg, `BASTRA_GIT_SHIM=0` den Git-Teil. Ein Befehl, den der abgeschaltete Shim übernommen hätte, behält das STOP und bekommt eine Zusatzzeile, was er gesichert hätte; die Formulierung folgt den eigenen Claude-Code-Berechtigungsregeln des Nutzers (bei einer `ask`-Regel: würde weiter nachgefragt; bei einer `deny`-Regel keine Zeile). Jeder solche Befehl ist ein Telemetrie-Ereignis `rm_shim_shadow` / `git_shim_shadow`. In den Vault wird nichts geschrieben.
- Jeder Shim läuft nur, wo er an ist: Ist einer der beiden aus, wird ein Befehl, der beide braucht (`rm -rf build && git stash drop`), nicht umgeschrieben. `shims/git` liest `BASTRA_GIT_SHIM=0` auch aus der eigenen Umgebung und reicht dann jeden Aufruf an das echte git weiter.
- Ein Host mit eigenem archivierenden `rm` setzt `BASTRA_RM_ARCHIVES=host`: Quittungstext, kein Umschreiben.

### Wie getestet wurde (Stand der PRs)

- Echte `claude -p`-Durchläufe unter Linux und macOS (Claude Code 2.1.283, Standard-Berechtigungsmodus): reines `rm` freigegeben und archiviert mit zitierter Quittung, Temp wirklich gelöscht, gemischte Befehle und Datei-Umleitungen behielten das STOP, `deny`-/`ask`-Regeln des Nutzers gewannen; bei git wurden `reset --hard`, `checkout HEAD~1 -- a`, `clean -fd && stash drop` u. a. mit Pins freigegeben, die `bastra archive restore` zurückholte, und ein Repository mit `core.fsmonitor` in einer eingebundenen Konfigurationsdatei wurde verweigert, das präparierte Programm lief nicht.
- Zwei unabhängige Angriffsdurchgänge auf das archivierende `rm` (zweite Laufwerke inkl. schreibgeschützter und voller Images, Symlinks, seltsame Namen, 200 parallele `rm` auf ein Manifest, über 70 bzw. 135 Befehle durch die Regeln) und einer auf den Git-Shim; jeder Fund bekam eine Reproduktion und einen Test. Mutationsprüfung: 31/31 rot für `rm-archive`, 60/60 für den Git-Teil, jede im `Revert-check:`-Kommentar des Tests benannt.
- Details, Tabellen und alle Funde stehen in den PR-Beschreibungen: [#690](https://github.com/n0mad-ai/bastra-recall/pull/690), [#692](https://github.com/n0mad-ai/bastra-recall/pull/692).

### Bekannte Grenzen und offen

- **Volle Platte:** Archivieren ist Verschieben, `rm` verweigert mit ENOSPC, statt Platz zu schaffen, und sagt, wie Platz frei wird (#695). Ein Weg „jetzt Platz freigeben" ist nicht gebaut.
- **Andere Laufwerke:** Ein Ziel auf USB- oder Netzlaufwerk landet dort unter `<mount>/.bastra-archive`, außerhalb von `~/.bastra`, oder wird verweigert, wo sich keins anlegen lässt.
- **Grenzfälle beim Zurückholen:** Nach `rm -r a/b a` legt das Zurückholen von `a/b` zuerst `a` an, und `a` weigert sich danach, es zu überschreiben — erst das Elternverzeichnis zurückholen. Ein Pfad über ein inzwischen verschwundenes symverlinktes Elternverzeichnis wird in dieser Schreibweise nicht gefunden; die Quittung nennt den aufgelösten Pfad, der gefunden wird.
- **Kosten pro Ziel:** drei `git`-Aufrufe pro Ziel in einem Repository (für die Klasse). `find … -exec rm {} \;` startet eine Node pro Datei (gemessen etwa 83 ms pro verfolgter Datei); `-exec {} +` bündelt.
- **Nicht gebaut:** Zurückholen über MCP (`restore_file`, `trash_list`); `save_document(overwrite: true)` ins selbe Archiv; ein Hinweis bei nacktem `git stash pop`; `git read-tree -u --reset`; Schnappschüsse während eines laufenden Merges (heute verweigert); ein einzelner rollierender Ref pro Repository statt eines Pins pro Tat; andere Clients (Codex, Cursor, …) behalten das STOP.
- Reservierte Wörter (`{ …; }`, `if`, `!`, `time`) vor einer rm-Umdefinition: #694.
