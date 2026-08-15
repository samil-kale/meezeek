# How other agent workspaces handle git worktrees

Research notes for adding worktree support to meezeek. Twenty-one projects were read at the
source level (shallow clone + `git grep`, not just READMEs). Three of them turned out not to use
worktrees at all and are recorded at the end, because *why* they don't is itself a data point.

Everything below is what the code does, not what the README claims.

---

## 1. The decisions every one of them had to make

Six questions come up in every implementation. The interesting part is that the answers diverge
hard, and each divergence is a real trade-off rather than an accident.

### 1.1 Where the worktree directory lives

| Location | Projects | Consequence |
| --- | --- | --- |
| Inside the repo (`<repo>/.worktrees/`, `.dmux/worktrees/`, `.bat-worktrees/`, `.cmux/worktrees/`) | parallel-code, dmux, better-agent-terminal, cmux, agent-deck (option), tuicommander (option) | Must be added to `.gitignore` **or** `.git/info/exclude`, or every worktree shows up as an untracked change in the parent. Recursive tooling (ripgrep, watchers, `npm run build`) walks into them. |
| Sibling of the repo (`<repo>-<branch>`, `<repo>-worktrees/<branch>`, `<repo>__wt/`) | wmux, vibe-tree, agent-of-empires (default template), agent-deck (default), tuicommander (option) | Nothing to ignore, repo stays clean. Pollutes the parent directory. |
| App data dir (`~/.hive-worktrees/`, `~/.superset/worktrees/`, `~/.mulmoterminal/worktrees/`, `~/.codexia/worktrees/`, `~/.claude-squad/worktrees/`, `%LOCALAPPDATA%\wimux\worktrees`, agetor's `dataDir/worktrees`, mapcli's `dataDir/worktrees`) | hive, superset, mulmoterminal, codexia, claude-squad, wimux, agetor, mapcli | Repo untouched, easy "we only ever delete paths we created" guard. Worktrees are far from the project in a file manager, and relative tooling paths (`../shared-config`) break. |
| User-configurable, several strategies | tuicommander (4: sibling / app-dir / inside-repo / `.claude/worktrees`), agent-deck (3: sibling / subdirectory / custom path template), agent-of-empires (path template with `{repo-name}`, `{branch}`, `{session_id}`), superset (per-project override > global setting > default) | The honest answer — every one of the above is right for somebody. |

Two projects that put worktrees inside the repo add the ignore rule to **`.git/info/exclude`**
rather than `.gitignore`, deliberately: `.gitignore` is a tracked file and writing into a user's
repo is a commit they didn't ask for. better-agent-terminal (`worktreeAddToGitExclude`) and cmux
(`ensureCmuxWorktreeDirectoryIsLocallyIgnored`, which resolves the path via
`git rev-parse --git-path info/exclude` rather than assuming `.git/info/exclude` — correct inside
a worktree, where `.git` is a file).

Three of the app-data-dir projects key the per-repo subdirectory by **basename + a hash of the
absolute path** so two checkouts of the same repo name don't collide:
mulmoterminal (`sha1(toplevel)[0..8]`), codexia (a rolling 24-bit hash), superset uses the project
name only.

### 1.2 What the branch is called

- **Prefix + session/task name** — claude-squad (`cfg.BranchPrefix + sessionName`, then sanitized),
  agetor (`agetor/<id12>-<slug>`), wimux (`wimux/<batch>/<i>`), better-agent-terminal
  (`bat/worktree-<hex8>`), mulmoterminal (`agent/<slug>` or `issue/<N>-<slug>`).
- **Random memorable names** — hive picks a dog or cat breed (`golden-retriever`, `beagle`, …) from
  a curated list of names that are already valid git refs; superset uses `friendly-words`
  predicate+object pairs (`brave-otter`) optionally prefixed with the GitHub username or git
  author name (`sakakale/brave-otter`).
- **The user types it** — parallel-code, vibe-tree, wmux, agent-deck, tuicommander,
  agent-of-empires.
- **No branch at all** — mapcli and codexia create **detached** worktrees
  (`git worktree add --detach <path> <sha>`). mapcli's comment says it plainly: detached HEAD
  "to avoid branch conflicts". Codexia then harvests by copying changed files back rather than
  merging.

Everyone who mints names has a **uniqueness loop**, and everyone learned the same lesson: checking
only for an existing branch ref is not enough.

- mulmoterminal checks the branch ref **and** whether the worktree directory name is free, because
  its directory name drops the first path segment — so `agent/1171-x` and `issue/1171-x` are two
  branches competing for one directory.
- hive collects existing branches *and* worktree branches *and* directory listings into one `Set`
  before picking, and retries the whole create up to three times on "already exists".
- agetor keeps a `takenBranches` set of names pinned on task rows that have **no git ref yet**
  (branches are created lazily at start time), so a ref-only search cannot see them.
- mulmoterminal and codexia serialize creation process-wide (a promise chain / a per-path mutex) so
  the `uniqueBranch → worktree add` sequence is atomic; without it two concurrent creates both
  pick the same name (TOCTOU) and one add fails.

Sanitization is universal and boring: lowercase, non-`[a-z0-9-_/.]` → `-`, collapse runs, trim.
claude-squad's comment names the real-world case — a Windows domain username `DOMAIN\user` leaking
a backslash into the branch name.

### 1.3 What the new branch forks from

This is where the most bugs were fixed, judging by the comment density.

- **Naive**: `git worktree add -b <branch> <path>` with no start point → forks from whatever HEAD
  the main checkout happens to be on. wimux, vibe-tree, better-agent-terminal do this.
- **HEAD commit, pinned**: claude-squad resolves `rev-parse HEAD` first and passes the SHA, with the
  comment *"Otherwise, we'll inherit uncommitted changes from the previous worktree"* — it also
  stores that SHA as `baseCommitSHA` and every later diff is computed against it.
- **Default branch, fetched first**: agent-of-empires, agent-deck, hive, mulmoterminal (only for
  issue-started worktrees), superset (`origin/main` by default). agent-deck's comment cites the
  regression: rooting a new branch at the caller's local HEAD once landed a branch on an old tag,
  a "414-file near-miss".
- **Local-vs-remote arbitration**: mulmoterminal's `baseStartPoint` is the most careful version I
  found. Forking from local `main` silently starts work on however stale that clone is; always
  taking `origin/main` silently drops unpushed local commits. So: local wins **only when it already
  contains the remote** (`merge-base --is-ancestor origin/base base`), otherwise the remote wins.
- **Multi-remote scoring**: agent-of-empires walks *every* configured remote and scores its tracking
  refs by ancestry to HEAD and commit recency, because on a fork + `upstream` layout hardcoding
  `origin/<base>` lands new branches on the stale fork tip.

superset adds `--no-track` plus `git config --local push.autoSetupRemote true` in the worktree: the
new branch does not track `origin/main`, but the first `git push` still creates the remote branch
and sets upstream.

### 1.4 What gets carried into the fresh checkout

A worktree is a clean checkout, which means everything gitignored is *gone* — `node_modules`,
`.env`, `.venv`, build caches, per-agent state. Every project deals with this and no two the same:

| Approach | Projects |
| --- | --- |
| Symlink selected gitignored dirs from the main repo | parallel-code — a user-picked list, defaults `.cursor .aider .copilot .codeium .continue .windsurf .env node_modules`; the created names are then appended to the worktree's `.git/info/exclude` |
| Symlink / junction untracked `.claude/` entries | better-agent-terminal — `symlink` on POSIX, `junction` for directories on Windows, plain `copyFile` for files on Windows |
| Copy `.env*` files | codexia — a fixed list of eight (`.env`, `.env.local`, `.env.development`, …), only when absent in the destination |
| Seed and sanitize `.claude/` | parallel-code again — Claude Code's bwrap sandbox read-only-binds `settings.json` / `settings.local.json`, so they must *exist* or the sandbox fails before Claude launches; `.claude` may therefore **never** be a symlink (bwrap refuses to bind-mount at symlink paths) |
| Run a user script | vibe-tree (`.vibetree/hooks/post-create`), agent-deck (`.agent-deck/worktree-setup.sh`), hive (a worktree-create script configured per project, which may even run the `git worktree add` itself), dmux (`worktree_created` hook), tuicommander (archive script) |
| Copy the parent's uncommitted work | agent-deck's `--with-state` — applies the parent's staged diff, then its unstaged diff, then copies untracked files, so the child's `git status --porcelain` equals the parent's. Explicitly read-only on the parent: no stash push, no index mutation. Refuses when the parent is mid-rebase/merge/cherry-pick/revert/bisect. hive's "duplicate worktree" does the same with `stash apply` + untracked copy. |
| Inherit the project's *app* config | mulmoterminal — see 1.6 |
| Nothing | claude-squad, wmux, mapcli, wimux, agent-of-empires (except submodules) |

**Running a repo-committed script is an arbitrary-code-execution surface**, and two projects say so
out loud:

- agent-deck gates it behind a **trust-on-first-use consent policy** (`prompt` is the fail-closed
  default; `always` and `never` are opt-in), keyed by a SHA-256 of the script content, because the
  script runs with the caller's full environment — `SSH_AUTH_SOCK`, `GITHUB_TOKEN`,
  `ANTHROPIC_API_KEY`.
- tuicommander deliberately **skips** `.tuic.json`-declared scripts entirely: *"executing
  repo-committed scripts without TOFU prompt is unsafe. Re-add when trust-on-first-use confirmation
  is implemented."* Only per-repo app settings and global defaults can supply a script.

vibe-tree uses git's own trust model instead: the hook is a file at `.vibetree/hooks/<name>` and
**the executable bit is the opt-in**. It refuses a hooks directory symlinked outside the project,
spawns without a shell, caps output at 64 KB, kills the process group after 120 s.

### 1.5 Taking the work back

Four distinct harvest models:

1. **Plain merge into the base branch.** vibe-tree, wmux (`WorktreeManager.mergeWorktree`),
   wimux, agent-deck (`MergeBack`), better-agent-terminal (`merge --no-ff` *or* replay commits with
   `cherry-pick`, user's choice).
2. **Merge with guards.** parallel-code's `mergeTask` is the most defensive:
   - Refuses when the worktree's actual current branch ≠ the task's branch, or when its HEAD is
     detached — *"AI agents sometimes check out a different branch (or detach HEAD), and merging
     the original branch would silently discard their work."*
   - Refuses when the merge root's working tree is dirty.
   - Captures the original branch before `git checkout <main>` and restores it afterwards.
   - Recovers from a failed squash with `reset --hard HEAD`, from a failed merge with
     `merge --abort`, and restores the branch in both paths.
   - Serialized per repo through a promise-chain lock keyed by the repo, because two merges race
     for the same index lock.
3. **Two-phase merge.** dmux merges `main` **into** the worktree first (to surface conflicts where
   the agent lives and can fix them), then merges the worktree into `main`. It has an AI-assisted
   conflict-resolution path and a dedicated handler for uncommitted worktree changes.
4. **Never merge — apply.**
   - codexia diffs `base_commit..worktree HEAD` plus the worktree's uncommitted status, then copies
     each changed file into the main checkout (and deletes the deleted ones).
   - wmux's *"atomic adoption"*: the user ticks hunks in a diff view, wmux writes them to a patch
     file, gates it with `git apply --check`, then runs `git apply` — the target tree takes the
     whole selection or stays untouched.

**wmux's integration worktree deserves its own mention** as the most sophisticated thing in this
whole survey. Rather than merging in the user's checkout, it:

- resolves the base branch and requires it to be checked out cleanly *somewhere*,
- captures the source worktree's HEAD **as an OID**, not as a branch name (a branch moves),
- refuses a dirty source worktree, because only the committed HEAD is merged and uncommitted work
  would be silently dropped — *"especially risky in AI worktrees"*,
- creates a **throwaway integration worktree** at the base OID and runs `merge --no-commit --no-ff`
  of the captured source OID there,
- runs a **verify gate** (the project's test command) in that worktree before offering Land,
- offers Land / Discard, and — because the source of truth is git's on-disk `MERGE_HEAD` — it
  **recovers the session from disk after an app restart** (`recoverSession` reads
  `HEAD`/`MERGE_HEAD` out of the integration worktree).

agent-deck has a smaller version of the same idea for bare-repo layouts: when the target branch
cannot be checked out (bare repo has no working tree), it creates a throwaway worktree of the
target, merges there, and removes it.

### 1.6 What else the worktree needs to be a real workspace

Two projects noticed that **a worktree isolates files, not ports and not databases**:

- **mulmoterminal** — a project declares in `.mulmoterminal.json`:
  ```json
  "worktreeEnv": { "PORT": { "kind": "port", "base": 3000 }, "DB_NAME": { "kind": "slug" } }
  ```
  and every tree's terminals are started with those variables set to values nothing else holds.
  Reservations live in a JSONL log in the app home. The comments are worth reading in full: probing
  is done **only at allocation time**, never at spawn time, because a spawn-time probe would find
  the tree's *own* dev server on its port, call it taken, and move the number — *"the tree would
  flee from itself"*. And a tmux reattach never re-reads the environment, so a value that moves is
  a value the running program no longer agrees with.
- **hive** — a simpler `~/.playwright-mcp-ports.json` registry starting at 3011, one port per
  worktree directory, with dead directories swept on load.

mulmoterminal also **inherits the parent project's app config into the worktree** so the new cell
doesn't look like an unrelated project: name, theme, terminal palette, font, model, and the
`worktreeEnv` declaration copy verbatim; the *chrome* colours (badge, header, cell, border, dot,
button) are rotated 12° around the hue wheel per worktree index, so the family still reads as one
project but each tree is its own shade. It is written to `.mulmoterminal.local.json` (gitignored)
and **only when git actually ignores that filename** — because an untracked file in the worktree
makes `git status` dirty, and its own `removeWorktree` refuses to clean up a dirty worktree. Their
comment: *"removeWorktree would go on refusing to clean up a worktree whose only change we wrote
ourselves."*

---

## 2. Hard-won details worth stealing verbatim

These are the things that only show up after the feature has shipped and broken.

**Removal is never one command.** Every mature implementation is a ladder:

```
git worktree remove --force  →  rm -rf the directory  →  git worktree prune  →  git branch -D
```

- parallel-code retries the `rm` with backoff `[0, 500, 1500, 3000] ms` because *"Docker Desktop's
  VirtioFS bind-mount may still be releasing after the container exits"*, and then — if files are
  owned by a foreign uid a root container left behind — runs a throwaway `docker run --user 0:0
  --entrypoint chown` to reclaim ownership. Deliberately a chown and not an `rm -rf` inside the
  container, *"so a mis-resolved mount cannot destroy anything"*.
- codexia's four-step cleanup additionally deletes `.git/worktrees/<name>` by hand when
  `git worktree remove` fails, after locating it by reading each `gitdir` file.
- hive only `rm -rf`s a path **git itself was tracking** as a registered worktree: *"A pre-existing
  dir at the same path that was not created by our script attempt is left alone, so a misconfigured
  collision can never wipe user data."*
- mulmoterminal, agetor and tuicommander all validate the path against the managed root / the
  actual `git worktree list` output before deleting anything, explicitly as an
  arbitrary-directory-deletion guard.

**`git worktree add` can fail *after* creating the worktree.** Post-checkout hooks (pre-commit's
`hook-type=post-checkout`, `uv sync`, `npm install`) run after the checkout and can exit non-zero
or blow past a timeout with the worktree fully created. superset's `execWorktreeAdd` and
agent-of-empires both treat this as a **warning, not a failure**, after verifying the worktree is
registered and on the expected branch. superset's timeout for `worktree add` is **600 s** for
exactly this reason.

**Classify the failure, don't string-match "already exists".** tuicommander and agent-of-empires
each have a dedicated classifier, because git emits several distinct "already exists" failures from
one command and conflating them swallows real errors:

- `a branch named 'X' already exists` → no worktree was created, retry without `-b`
- `'<path>' already exists` / `is already checked out` / `already used by worktree` → a directory
  may genuinely be there; treat as idempotent **but verify the directory exists first**
- anything else → propagate

agent-of-empires goes further and determines ownership from **porcelain output** rather than the
diagnostic string, *"Git localizes the 'already used by worktree' diagnostic"*.

**Prune before you add.** Both agetor and agent-of-empires call `git worktree prune` before every
`worktree add`, because git rejects adding a path it still tracks as a missing-but-registered
worktree.

**`git worktree lock` as prune protection.** agent-of-empires locks every worktree it creates
(`--reason "aoe-managed worktree (prevents cross-boundary prune)"`) so a `prune` run from a context
that cannot see the checkout — a sibling sandbox, or the host when the worktree lives inside a
container mount — cannot reap its admin entry and break the linkage. It unlocks again before every
intentional remove/move, since git refuses both on a locked worktree.

**Relative `.git` pointers for containers.** agent-of-empires rewrites the worktree's `.git` file
from `gitdir: /abs/path/.bare/worktrees/name` to `gitdir: ../.bare/worktrees/name`, so the repo
works when mounted at a different location. wimux's reader handles the same thing from the other
side: git may write a relative `gitdir:` (`worktree.useRelativePaths`, or
`git worktree add --relative-paths`), so it resolves relative to the `.git` file's own directory.

**A linked worktree's `.git` is a *file*, not a directory.** Both agetor
(`parseWorktreeGitPointer`) and agent-deck read it to answer "which repo did this orphaned
directory come from" without spawning git. AgentsCommander notes the same for its repo detection:
*"worktrees and submodules use a `.git` FILE"*.

**A worktree the user deleted by hand still appears in `git worktree list`.** mulmoterminal's
`issueWorktree` checks `existsSync(w.path)` on top of the list, because the caller starts an agent
in what it returns — *"trusting the list alone would spawn an agent in a directory that no longer
exists"*.

**Never remove the main worktree, or the one you're standing in.** wmux checks both: the first
porcelain block is the main worktree by git's own contract, and the caller's own toplevel is where
the pane's cwd points. agent-deck has a whole regression test named
`issue1200_no_delete_main_worktree_test.go`.

**Never delete a branch you didn't create.** claude-squad tracks `isExistingBranch` and skips
`branch -D` on cleanup. agetor tracks `branchSource: "existing"` (a PR's head branch) and skips it
for the same reason. vibe-tree and better-agent-terminal make it a parameter.

**Distinguish "remove" from "detach"/"archive"/"pause".** Three projects separate throwing work
away from freeing disk:

- claude-squad's **Pause** removes the worktree but keeps the branch (and copies the branch name to
  the clipboard); **Resume** re-creates the worktree from that branch.
- agetor's **`detachWorktree`** removes only the checkout, deliberately never calls `branch -D`,
  refuses when the worktree is dirty (with an explicit user-confirmed `force` escape hatch), and
  its `prepareWorkdir` re-materializes at the same deterministic path later. The point is that the
  session state — Claude's JSONL, run history, the codex thread id — lives *outside* the worktree,
  so an archived task can be resumed.
- tuicommander's **archive** moves the directory to `<worktrees_dir>/__archived/<branch>/`, picking
  `<branch>-2`, `-3`, … so archiving the same branch twice never clobbers a prior archive.

**End-of-options guard.** tuicommander appends `--` before the path/ref because the branch value can
be attacker-influenced (a PR's `head_ref`). agent-dashboard does it on `merge-base --is-ancestor`
so a state-file value like `--version` can't fake a merged verdict. wmux, agetor and agent-of-empires
all reject refs starting with `-` outright, plus control characters, `..`, and over-long names.

**Serialize per repository.** parallel-code (`withWorktreeLock` keyed by the repo), hive (an Effect
semaphore per repo path), codexia (a per-path mutex map), mulmoterminal (a global create queue),
wmux (`withRepoLock`, and its comment records the exact bug: add used the main worktree's path as
the key and remove used the *caller's* toplevel, so add/remove on one repo never serialized against
each other). Two of anything fighting for `.git/index.lock` is the failure mode.

**A brand-new repository has no HEAD.** claude-squad and parallel-code both detect this and say so:
*"Cannot create a worktree in a repository with no commits. Please make an initial commit first."*

**Sparse checkout.** agent-deck can inherit the invoking worktree's sparse-checkout patterns into
the new one, and does it with `worktree add --no-checkout` + pattern replay so the full tree is
**never materialized** — installing patterns after a full checkout would defeat the purpose. A
failed replay rolls back the worktree *and* the branch it created.

**Submodules.** agent-of-empires runs `git submodule update --init --recursive` in the new worktree
when a `.gitmodules` file is present, behind a user setting.

---

## 3. What each project actually does

Ordered roughly by how much of it is relevant to meezeek.

### johannesjo/parallel-code — Electron + SolidJS, macOS/Linux
The closest architectural sibling: Electron main-process git via `execFile`, IPC to the renderer,
one worktree per task.

- Path `<repo>/.worktrees/<branch>`; `createWorktree(repoRoot, branch, symlinkDirs, baseBranch, forceClean)`.
- Symlinks a user-selected list of gitignored dirs in, records the names in
  `.git/info/exclude` under a `# parallel-code: worktree symlinks` header, and validates each name
  against traversal and CR/LF injection in the backend — *"the backend does not trust the UI's
  candidate list"*.
- Seeds `.claude/` from the main repo (minus `plans` and `steps.json`, which are per-worktree), and
  writes root-anchored exclude patterns for the char-device placeholders bwrap leaves behind
  (`/.bashrc`, `/.gitconfig`, `/.mcp.json`, …) so they don't surface in changed-files.
- Removal ladder with retry + Docker ownership reclaim (§2).
- `mergeTask` with branch-mismatch/detached-HEAD guards, squash option, rollback, per-repo lock.
- Also: `listImportableWorktrees` (adopt worktrees created outside the app), `getBranchWorktreePath`
  (resolve a branch already checked out somewhere without creating anything), a `detectDiffBase` /
  `refineDiffBaseWithCherryPick` layer for what to diff against.

### morapelker/hive — Electron + Effect, macOS/Windows/Linux
- Path `~/.hive-worktrees/<projectName>/<projectName>--<breed>`; branch is the breed name.
- Random dog/cat breed names from a curated list, deduped against branches ∪ worktree branches ∪
  directory names, with a numeric suffix and 3 create attempts.
- Optional `--ff-only` pull of the default branch before creating.
- A per-project **worktree create script** may replace `git worktree add` entirely (documented
  example: `git worktree add --no-checkout …` then copy git-crypt keys then `reset --hard HEAD`).
  Shell chosen by shebang (`bash` vs `sh`), spawned `detached` so the whole process group can be
  killed, 5-minute timeout, and `cleanupFailedWorktreeCreate` on failure.
- Modes: new / from existing branch / **duplicate** (stash-apply the source's uncommitted work and
  copy its untracked files into the new tree).
- Per-worktree port registry; worktree "connections" let one agent session span several repos.

### superset-sh/superset — Electron + tRPC + drizzle
- Base dir: project override > global setting > `~/.superset/worktrees`, then `/<project>/<branch>`.
- A **workspace is either type `branch` (the main repo, no worktree) or type `worktree`** — a
  distinction meezeek would need anyway, since not every session wants isolation.
- `friendly-words` two-word branch names, optionally prefixed with the GitHub username (via `gh`)
  or the git author name; prefix modes `none | custom | author | auto`.
- `--no-track` + `push.autoSetupRemote=true`; `execWorktreeAdd` tolerates post-checkout hook
  failures (600 s timeout) after verifying registration + branch; classifies index-lock errors into
  a dedicated `GitEnvironmentError` with an actionable message.
- Imports **external** worktrees (skip main repo, bare, detached, branch-less).

### sahithvibudhi/vibe-tree — Electron + web/server, macOS/Windows/Linux
The simplest complete implementation, and a good minimal target.

- Path: sibling `<repoParent>/<repoName>-<branch>`; `worktree add -b <branch> <path>`.
- Removal: `worktree remove --force` then `branch -D`; a failed branch delete is a **warning**, not
  a failure, since the worktree is already gone.
- Lifecycle hooks `.vibetree/hooks/post-create` and `pre-remove`, git's own trust model (executable
  bit = opt-in), refuses a hooks dir symlinked outside the project, no shell, 120 s timeout, output
  capped, killed as a process group. A failing `pre-remove` warns but never blocks removal —
  *"the user asked to delete and a broken script should not hold that hostage"*.
- Resolves `git` from a fallback list when not on PATH (GUI-launched apps on macOS), falling through
  only on `ENOENT` so a real git failure still surfaces.

### openwong2kim/wmux — Electron + daemon, Windows & macOS
The most ambitious merge story; also the only other one that treats Windows as first-class.

- Path `<mainParent>/<mainName>-worktrees/<branchDir>`, derived by the **handler**, never passed in
  by the renderer — *"the renderer cannot specify an arbitrary disk path"*.
- Three-way branch resolution: existing local branch → `--guess-remote` (so a remote-only branch is
  tracked rather than shadowed by a fresh `-b`) → `-b` from HEAD.
- No `--force` on remove by design: a dirty worktree is refused by git and git's stderr is what the
  user sees.
- Refuses removing the main worktree and the worktree the caller is standing in.
- Merge sessions in an isolated integration worktree with a verify gate, disk-recoverable (§1.5).
- Atomic hunk adoption via `git apply --check` then `git apply` (§1.5).
- No cached state at all: *"git is the on-disk source of truth, so there is no cache or persisted
  state: daemon restarts and app restarts don't matter, every call is a fresh `git worktree …`"*.

### alamops/agetor — Bun server + web UI
- Per-task `isolation: "worktree" | "none"`; path `<dataDir>/worktrees/<taskId>`, branch
  `agetor/<id12>-<slug>`.
- `prepareWorkdir` is idempotent and does the interesting work: reuse if on disk (and verify the
  worktree is still on the expected branch, checking it back out if a user switched it); prune;
  re-attach to an existing branch rather than `-B` (which *"would forcibly rewind the branch back to
  base, discarding any commits the previous run made"*); collision recovery that re-pins a fresh
  unique name — but **only on first materialization**, never on a re-attach, and never for a
  user-supplied (`branchSource: "existing"`) branch.
- Returns a hard error rather than silently falling back to the live working tree when isolation
  was requested and could not be provided.
- `detachWorktree` (keep branch) vs `removeWorktree` (delete branch), §2.
- `rm` is async on purpose: *"a synchronous rmSync over a large worktree (e.g. one with
  node_modules) would block the event loop for seconds, starving every other HTTP connection and
  SSE stream."*

### receptron/mulmoterminal — Node server + Vue, cross-platform incl. Windows
The one to read for "a worktree is a first-class cell in the UI".

- Path `~/.mulmoterminal/worktrees/<repoBasename>-<sha1[0..8]>/<taskDir>`; branch `agent/<slug>` or
  `issue/<N>-<slug>`.
- Managed-root containment guard with canonical paths (`isStrictlyWithin`), so a symlink under the
  root cannot escape it and the root itself is not deletable.
- `realpathSync.native` specifically because on Windows only the native call expands an 8.3 short
  component (`C:\Users\RUNNER~1`) to the long form `git worktree list` reports.
- Per-worktree `PORT` / `DB_NAME` reservation (§1.6); config + hue-rotated colour inheritance (§1.6).
- `baseStartPoint`'s local-vs-remote arbitration (§1.3).
- Drains git's stderr even though it discards it: *"git blocks on a full stderr pipe … an unread
  pipe deadlocks the whole call"*. Collects stdout as `Buffer` and decodes once, because a chunk can
  split a multibyte UTF-8 character.

### standardagents/dmux — Node + Ink TUI over tmux (POSIX only)
- Path `<repo>/.dmux/worktrees/<slug>`; one tmux pane per worktree.
- Eight hook points: `before_pane_create`, `pane_created`, `worktree_created`, `before_pane_close`,
  `pane_closed`, `before_worktree_remove`, `worktree_removed`, `pre_merge`, `post_merge`; each gets
  `DMUX_WORKTREE_PATH` et al. in the environment.
- Two-phase merge with AI-assisted conflict resolution and a dedicated
  `worktreeUncommittedHandler`.

### smtg-ai/claude-squad — Go + tmux (POSIX only)
The most-copied reference implementation; several other projects clearly read it.

- Path `<configDir>/worktrees/<sanitizedBranch>_<hex(unixNano)>`, branch `<cfgPrefix><sessionName>`.
- Setup branches on `isExistingBranch`: existing local → `worktree add <path> <branch>`;
  remote-only → `worktree add -b <branch> <path> origin/<branch>`; new → `worktree add -b <branch>
  <path> <headSHA>`.
- Records `baseCommitSHA` and diffs against it forever (`git add -N .` first so untracked files
  appear; `--numstat` variant for the cheap list view).
- Pause = remove worktree, keep branch; Resume = re-create. Handles the orphaned case (path or
  `.git` gone) by skipping the dirty check, `rm -rf`ing, pruning, and still transitioning to Paused
  so the user can recover.
- `PushChanges` commits with `--no-verify` and pushes via `gh repo sync`, falling back to
  `git push -u origin <branch>`.

### njbrake/agent-of-empires — Rust TUI, git2 + git CLI
- Path from a **template** (`../{repo-name}-worktrees/{branch}` by default) with `{repo-name}`,
  `{branch}`, `{session_id}`; lexically normalized (no filesystem access — the worktree does not
  exist yet) because an un-normalized `/repos/x/../x-worktrees/feat` gets stored as a session
  identity and then compared by string.
- `git worktree lock` on every managed worktree; unlock before remove/move/prune (§2).
- Multi-remote default-branch scoring; explicit `--base-branch` typos become `BranchNotFound`
  rather than a session quietly anchored to a bystander commit.
- Redacts credentials out of any URL in git's stderr before logging or surfacing it.
- Relative `.git` pointer rewriting for container mounts; recursive submodule init.
- Post-checkout hook failure → warning, not abort.

### asheshgoplani/agent-deck — Go CLI + TUI + web
The broadest feature set of the Go implementations.

- Path strategies: `sibling` (`<repo>-<branch>`, default), `subdirectory` (`<repo>/.worktrees/`),
  or a custom path/template; plus special handling for **bare-repo layouts** (`.bare/` nested, or
  bare-at-root, where linked worktrees are direct children).
- Branch resolution: existing local → `--track -b <branch> <path> <remote>/<branch>` → fresh branch
  rooted at a freshly fetched origin default (with a HEAD fallback when offline).
- Sparse-checkout inheritance via `--no-checkout` + pattern replay, with rollback (§2).
- `--with-state` / `--with-state-and-gitignored` WIP materialization from the parent (§1.4).
- `.agent-deck/worktree-setup.sh` and `worktree-destruction.sh` behind a TOFU consent gate (§1.4),
  dispatched by the executable bit so the shebang decides the language.
- `MergeBack` handles regular and bare layouts, fast-forwarding via `update-ref` when possible.

### sstraus/tuicommander — Tauri (Rust) + React
- Four storage strategies: `Sibling` (`<parent>/<repo>__wt/`), `AppDir`
  (`<config>/worktrees/<repo>/`), `InsideRepo` (`<repo>/.worktrees/`), `ClaudeCodeDefault`
  (`<repo>/.claude/worktrees/`) — per-repo setting over global default.
- Failure classifier `PathExists | BranchExists | Other` (§2), `--` end-of-options guard.
- Idempotent create: an existing path on the *expected* branch is returned as-is; a **detached HEAD
  is not treated as stale** because it's a transient rebase/bisect state and forcing cleanup would
  destroy an agent's in-progress work.
- **Orphan detection**: linked worktrees that are detached with no branch and no operation in
  progress — i.e. their branch was deleted — offered for removal, with the path validated against
  the real worktree list first.
- **Archive** to `__archived/<branch>[-N]/` with an optional pre-archive script.

### milisp/codexia — Tauri (Rust) + React
- Path `~/.codexia/worktrees/<repoName>-<hash6>/<sanitizedKey>`.
- `git worktree add --detach` — **no branch at all**.
- Harvest by diffing `base..HEAD` plus the worktree's `status --porcelain=v1 -uall` and copying the
  changed files into the main checkout.
- Copies eight `.env*` variants in if absent.
- Four-step cleanup (remove → delete `.git/worktrees/<name>` by hand → `rm -rf` → prune), with the
  internal worktree name found by scanning `.git/worktrees/*/gitdir`. Per-path mutex around
  create/remove.

### tony1223/better-agent-terminal — Tauri + Node sidecar
- Path `<gitRoot>/.bat-worktrees/<hex8>`, branch `bat/worktree-<hex8>`; the **host** picks the slot,
  not the client — the name used to be the client session id's first 8 chars and clients with a
  shared prefix all collided on one path.
- Adds `/.bat-worktrees/` to `.git/info/exclude`.
- Symlinks (junctions on Windows) the main repo's **untracked** `.claude/` entries into the
  worktree.
- `worktreeRehydrate` re-adopts a worktree after a restart from the path alone.
- Merge back as `merge --no-ff --no-edit` or as a `cherry-pick` of `sourceBranch..branch`, after
  refusing a dirty host repo and checking the source branch out.

### pmarsceill/mapcli — Go CLI + daemon (`map` / `mapd`)
- Path `<dataDir>/worktrees/<agentID>`; `git worktree add --detach <path> <sha>` — *"detached HEAD
  to avoid branch conflicts"*. The branch name is only recorded as metadata.
- Removal falls back to `os.RemoveAll` when `git worktree remove --force` fails.
- Minimal (278 lines) — worth reading as the floor.

### fabperso/wimux — Rust server + client
- Path `%LOCALAPPDATA%\wimux\worktrees\<batch>-<i>` (temp dir fallback), branch `wimux/<batch>/<i>`.
- Fan-out: N worktrees created in a loop for one prompt, with **rollback of already-created
  sessions** if any one create or spawn fails.
- Pins `base_sha` and `base_branch` at batch launch as the stable comparison point and PR target.
- Remove is best-effort and logs rather than throws — *"an orphaned worktree after a server crash is
  tolerated"*.

### bjornjee/agent-dashboard — Go TUI + PWA over tmux
**Consumes worktrees, never creates them.** Its value is the topology layer: given any path, resolve
`Worktree` (`rev-parse --show-toplevel`), `Source` (`dirname(rev-parse --git-common-dir)`), and
`Linked` (are they different), with sentinel errors for not-a-repo / inside-a-submodule. Then
`ListWorktrees` enriches each porcelain entry with a per-worktree
`rev-parse --absolute-git-dir` so a session's transcript directory can be mapped back to a worktree.
`IsBranchMerged` uses `merge-base --is-ancestor` and notes that squash merges are invisible to
ancestry, covered by a resume TTL instead.

Relevant to meezeek: this is the shape of "adopt whatever worktrees the user already has" without
owning their lifecycle.

### manaflow-ai/cmux — Ghostty-based macOS terminal
Worktrees are an **extension prototype**, not the core product. `.cmux/worktrees/<branch>` inside
the project, branch `cmux-sidebar-<epoch>-<uuid8>`, `.cmux` added to `info/exclude` via
`rev-parse --git-path info/exclude`.

The one idea worth taking: *the workspace's main process is structurally always the login shell,
and worktree setup is delivered as terminal **input** (with a trailing newline), never as the
surface's primary process* — the type has no primary-command field at all, so *"the 'setup command
became the main process and the tab died when it exited' bug cannot be expressed here."* That is
directly applicable to how meezeek starts a terminal in a new worktree.

---

## 4. The three that don't use worktrees

**mblua-opensource/AgentsCommander** rejects them on purpose, and documents the reasoning:

> Workgroup replicas give each team a separate operating space instead of sharing a plain disposable
> git worktree. A replica includes its own repository copy, agent directories, messaging area,
> filesystem write boundaries, and workgroup-specific executable. This costs more disk space and
> setup time than a basic worktree, but it gives AgentsCommander stronger isolation for parallel
> teams, safer delegation boundaries, and cleaner test or build state per workgroup.

What that actually is on disk, read from `entity_creation.rs`:

```
my-project/.ac/wg-1-feature-x/
├── TASK.md                  # the workgroup's goal, owned by the coordinator
├── messaging/               # every inter-agent message, one timestamped .md each
├── repo-app/                # git clone --depth 1 <url>   ← one per repo, per workgroup
├── repo-admin/
├── __agent_tech-lead/       # coordinator replica: scratch, inbox/, outbox/, sessions
├── __agent_dev-rust/        # worker replica; config.json points at ../repo-app
└── __agent_dev-ts/
```

Three details the prose glosses over:

- **The repo copy is per workgroup, not per replica.** Agents in one team share the checkout; each
  replica's `config.json` just lists `../repo-<name>` for the repos that agent may touch. The
  isolation unit is *one team working one task*, not *one agent*.
- **It is `git clone --depth 1 <url>` from the remote**, not a local clone and not a worktree —
  with `-c core.longpaths=true`, credentials scrubbed from the environment, `CREATE_NO_WINDOW` on
  Windows, a 10-minute timeout, and a `git reset` fallback when `.git/index` is missing afterwards.
  A team defines repos as URLs, with per-repo agent include/exclude lists.
- **The isolation is organisational, not a sandbox.** Its own `security.md` says so plainly: *"AC
  adds visibility and coordination; it does **not** add a sandbox. If the underlying agent can
  `rm -rf ~/`, AC will let it."* What the replica separates is git state, build state and
  delegation authority — not filesystem reach.

Its user-facing hint still lists worktrees as a valid lighter option. It does contain a lot of
worktree-*aware* code — its git status watcher notes that dirtiness is a property of the worktree
and that several replicas legitimately share one, and its repo detection knows `.git` is a file in
a linked worktree.

**Trade-off against a worktree**, since this is the road not taken:

| | Workgroup replica | Worktree |
| --- | --- | --- |
| Cost per unit | Full shallow clone: disk × N, network, minutes on a big repo | Working tree only; object DB shared, seconds |
| git state | Fully separate — own refs, branches, stash, config, hooks, object DB | Shared refs/objects/config/hooks; a branch can only be checked out in one worktree |
| Cleanup | `rm -rf` the directory. No `prune`, no `lock`, no orphaned `.git/worktrees/*` entries | The whole ladder in §2 exists because this is genuinely hard |
| Start point | Guaranteed the remote's tip | Whatever local ref you pick — the §1.3 problem |
| Local uncommitted work | Cannot come along at all | Can be carried over (agent-deck `--with-state`, hive duplicate) |
| History | `--depth 1`: no `git log`, no merge-base against older commits, no rebase onto anything old | Full |
| Needs a remote + network | Yes | No |
| Harvest | Only via push + PR | Local merge, or hunk-level apply |
| Where the user's editor is pointed | Somewhere else entirely | Also somewhere else, but on the same object DB |

**fukuyori/wtmux** is a tmux clone for Windows Terminal. No git anything. The name is a
coincidence.

**multiagentcognition/cmux-agent-mcp** is a thin MCP wrapper around cmux's socket. No git anything.

---

## 5. What I'd take for meezeek

Ranked, with the meezeek-specific reasoning.

1. **A worktree is a project row, not a new pane type.** Every project that made worktrees a
   first-class UI object (hive, superset, mulmoterminal, vibe-tree) shows them in the list where
   projects live, each with its own terminals. meezeek already holds every project's tabs in `App`
   and already has `Repository` as the single source of truth per path — a worktree is just another
   path to open, which means it costs one more `Repository` and one more row, not a new layer.
   superset's `branch | worktree` workspace-type split is the cheapest way to say "this session is
   isolated, that one is not".

2. **Git stays in `git-host.ts`.** All of this is `git worktree add/list/remove/prune` plus
   `rev-parse`/`status`, which is exactly what `git.ts` already wraps. `git.readState`'s
   invocation-count discipline applies unchanged; `worktree list --porcelain` is one more process
   and should not go into the refresh path — read it when the project list is built, not every
   watcher tick.

3. **Everything goes through `Repository.runAction`.** Create, remove and merge all want the index
   lock, and parallel-code, hive, wmux and codexia each independently discovered they need a
   per-repo mutex. meezeek already has one. wmux's bug — add and remove keying the lock differently
   so they never serialized — is the one to avoid: key on the **main** worktree's path, resolved
   from `worktree list`'s first block, never on the caller's toplevel.

4. **Where they go: app-data dir, keyed by basename + path hash.** meezeek already writes to
   `userData`, already has the "we only delete paths we created" instinct in the opencode server
   registry, and putting them inside the repo would put an untracked directory into the very
   `readState` the git pane draws. mulmoterminal's `<basename>-<sha1[0..8]>` keying handles two
   checkouts of the same repo. Make it a setting later, not now.

5. **The removal ladder and the containment guard, from day one.** `worktree remove --force` →
   retry `rm` with backoff → `worktree prune` → conditional `branch -D`, with the path validated
   against `worktree list` and against the managed root before anything is deleted. meezeek's
   discard already uses `shell.trashItem` for the same reason; a worktree directory is a bigger
   version of that decision.

6. **Detach vs delete.** claude-squad's Pause and agetor's `detachWorktree` both exist because the
   session outlives the checkout — and in meezeek the session state (Claude Code's JSONL, opencode's
   server-side session) *already* lives outside the working directory. Removing the checkout while
   keeping the branch, and rematerializing it at the same deterministic path on resume, falls out
   almost for free.

7. **Refuse to remove a dirty worktree, and say why.** wmux's choice — no `--force`, let git refuse
   and surface git's own stderr — fits meezeek's `notify()`-only rule and its "only ask before
   something that cannot be undone" rule better than a confirmation dialog would.

8. **The gitignored-files problem needs an answer before this ships.** A fresh worktree with no
   `node_modules` and no `.env` is a workspace where nothing runs, and meezeek's saved commands are
   exactly the things that would fail. The options, cheapest first: (a) copy `.env*` like codexia,
   (b) symlink a configured list like parallel-code, (c) run a post-create script. (c) is the most
   general and the most dangerous — if it ever happens it should follow agent-deck's TOFU consent
   or vibe-tree's executable-bit trust model, and it must not be a repo-committed script that runs
   unasked. Note that (b) needs junctions on Windows for directories, which better-agent-terminal
   already demonstrates.

9. **Ports.** meezeek's saved commands are `npm run dev` and `java -jar` — two worktrees running
   them fight over the same port immediately. mulmoterminal's `worktreeEnv` declaration is the right
   shape and would sit naturally next to the existing `env` field in `meezeek.json`, since that
   field already exists for exactly this class of problem ("there is no way to write a variable into
   a command that works anywhere"). Its "allocate once, never probe at spawn time" rule is the part
   that is easy to get wrong.

10. **Harvest: start with nothing.** Every merge implementation here is either fragile
    (checkout-merge-restore in the user's own tree) or expensive (wmux's integration worktree).
    meezeek's own CLAUDE.md already says a git command needing a list, a message or a decision per
    line belongs in an agent, not in a dialog — which argues for shipping worktrees with *no* merge
    UI at all: the diff dialog already shows what changed, and the merge is a command the user runs
    in a terminal. If a merge action is ever added, parallel-code's guards (branch mismatch,
    detached HEAD, dirty tree, restore-original-branch, rollback on failure) are the minimum, and
    wmux's integration worktree is what it should grow into.

11. **Adopt, don't only create.** parallel-code's `listImportableWorktrees` and superset's external
    import both exist because users already have worktrees. meezeek's add-repository dialog is the
    natural place: if the selected path is a repo with linked worktrees, offer them.

12. **Things to copy verbatim, cheaply:** prune before add; classify "already exists" into three
    cases rather than string-matching; treat a post-checkout hook failure as a warning once the
    worktree verifies; `--` before any ref argument; reject refs starting with `-`; never remove the
    main worktree or the one a terminal is currently standing in; check `existsSync` on top of
    `worktree list` before spawning anything into a listed path.

### Windows notes

meezeek's cross-platform requirement matters more here than for most of these projects — only
wmux, hive, vibe-tree, mulmoterminal, better-agent-terminal and agent-deck treat Windows as
first-class; parallel-code is macOS/Linux only, and everything tmux-based (claude-squad, dmux,
agent-dashboard) is POSIX-only.

- Directory symlinks need `junction`; file symlinks need Developer Mode or admin, so copy files
  instead (better-agent-terminal's split).
- `realpathSync.native` is required to compare a path against what `git worktree list` reports,
  because of 8.3 short names (mulmoterminal).
- git reports forward slashes even on Windows; normalize before comparing to a `path.join` result
  (mulmoterminal).
- Path length: worktrees under a hashed app-data path plus a deep `node_modules` will hit
  `MAX_PATH`. Cloning these very repos for this research hit exactly that on six of them.
- `rm -rf` of a worktree with a running dev server or a file-watcher holding handles fails
  differently on Windows than the Docker/VirtioFS case parallel-code retries for, but the same
  backoff-retry ladder is the fix.
