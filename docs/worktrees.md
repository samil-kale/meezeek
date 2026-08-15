# Worktrees in meezeek

Design notes, not an implementation — nothing of this is built. What was decided is marked as
such; what is still open says so. `worktree-research.md` next to this file is the survey of what
other agent workspaces do and is referenced by section number below.

## The model

A worktree is a second folder of the same repository with another branch checked out in it. All
worktrees share the repository's history, remotes and stashes; only working tree and index are
their own. Git allows a branch to be checked out in **one** worktree at a time, so every new
worktree gets a branch of its own — the **worktree branch**. That branch is an ordinary branch
(it can be pushed, merged and deleted like any other); the worktree is where it is checked out.
Branch = *what* is worked on, worktree = *where*.

Today a checkout in the git pane switches the branch of the one folder every terminal of the
project runs in — an agent working there carries on in the other branch without noticing. With
worktrees the main project stays on its base branch, and each worktree is another checked-out
branch in a folder of its own with terminals of its own.

## What GitHub Desktop does

Read from the source rather than from memory, because CLAUDE.md makes Desktop the reference for
the git half and it turns out to have shipped this. `enableWorktreeSupport()` returns `true`
unconditionally — it is not a beta flag.

**Worktrees are not in the branches view.** They have a **dropdown of their own in the toolbar**,
and where it sits is the whole argument (`app.tsx`):

```
Repository  →  Worktree  →  Branch  →  Push/Pull
```

Between "which repository" and "which branch", because a worktree is not a ref but a place — it
belongs on the axis the repository selector is on, not on the branch selector's. A branch dropdown
answers "switch the branch of this folder", and a worktree is what you use *instead* of that. The
dropdown only appears once a repository has at least one linked worktree.

What the branches view gets is a single action, in the context menu of a branch and of a pull
request: "Checkout in new worktree…". No entry, no marking. The rest of the surface is the
repository list's context menu ("Show worktrees", "New worktree…"), a `confirmWorktreeRemoval`
preference that defaults to on, and a git layer of `list` / `add -b` / `remove [--force]` / `move`.

Two things there bear directly on the decisions below.

**Desktop already does what this document decided for the double click.** From `app-store.ts`:

> If the branch is checked out in another worktree, switch to that worktree instead of checking out
> the branch in the current worktree.

Not an error and not a question — it jumps. Which means "if the branch is already in one, it just
jumps there" is not an invention here.

**Where meezeek deliberately differs is only the placement.** Desktop puts the switcher in the
toolbar; meezeek puts it in the project list as a child row. Same axis, different furniture, and
the reason is that meezeek's projects each own mounted terminals — switching to a worktree has to
switch the tab strip with it, which is what selecting a project already does. Desktop has no
terminals to carry, so a dropdown is enough for it.

## Decided

- **A worktree is a project row, not a new pane type.** It is a full project (its own
  `Repository`, its own terminals, its own git pane), drawn as a child under the repository it
  belongs to:

  ```
  meezeek
  |-> meezeek worktree 1
  |-> meezeek worktree 2
  ```

  Closing the parent takes the children out of the list without removing anything. Same as
  research §5.1 (hive, superset, mulmoterminal, vibe-tree all show worktrees where projects live).

  Two other models were weighed and lost, and both lose to an invariant rather than to taste, so
  they should not come back without one of those invariants changing. **A worktree as a property
  of a tab** ("this terminal runs over there") looks like the smallest change and is the largest:
  everything here assumes `tab.cwd` is inside `project.path` — the link providers resolve a
  ctrl-clicked path against it, a saved command's `cwd` is relative to it, the shell transcript and
  the diff dialog hang off it — so a tab standing elsewhere makes the git pane, the branch bar and
  the diff statements about the wrong directory. **A worktree as a switch inside one project** ("this
  project now points at worktree X") contradicts terminals staying mounted: they are the stateful
  half, and a project that moves its working directory leaves them running somewhere it no longer
  claims to be.

- **Created by one click** on a new icon in the project row, fully automatic — no dialog. Branch
  name and base are generated (open, see below).

- **They live under meezeek's own `userData`** (`worktrees/<projectId>/<name>`), not inside the
  repository and not beside it. The repository and its parent folder stay untouched, nothing has
  to be ignored, the parent's watcher never sees them, and "we only ever delete paths we created"
  is trivial. The trade-off (research §1.1): far from the project in a file manager, and relative
  tooling paths like `../shared-config` break.

- **Existing worktrees are adopted.** When a repository opens, `git worktree list --porcelain` is
  read **once** — not in the refresh path, that one counts its git invocations — and every linked
  worktree becomes a child, wherever it lives. There is therefore no "hide from the list" state:
  it would be a second record next to git, and the child would be back on the next start anyway.

- **The pane no longer offers a plain checkout; it offers "open in worktree".** Double-clicking a
  branch creates the worktree for it if there is none (`worktree add <path> <branch>`, no `-b`)
  and selects the child; if the branch is already in one, it just jumps there. A new branch is a
  new worktree branch, i.e. the icon on the project row. What this saves: no agent whose branch
  changes under it, no "your local changes would be overwritten", no question about unsaved work
  on a switch, and one action in the branch tree instead of two.

  Two honest limits. meezeek can only forbid *itself*: a `git checkout` in a terminal, by the user
  or by an agent, still happens, `Repository` sees it and shows it, and the pane must treat that
  as a state, not an error. And the price is the fresh folder: a worktree brings tracked files
  only — no `node_modules`, no `target/`, no `.env`, no build cache — so every branch switch is an
  install/build in a new folder (research §1.4). `meezeek.json` should get a line for "what a new
  worktree needs" (vibe-tree's `post-create` hook), or the first impression is an empty folder in
  which nothing builds.

- **Moving a checked-out branch into a worktree.** When the main project stands on `feature/x`
  (because someone switched in a terminal, or from before this model), the pane offers "move to
  worktree". Uncommitted changes belong to the *folder*, so they travel by stash — stashes are
  shared across worktrees:

  1. `git stash push -u` in the main folder (`-u` for untracked files; skipped on a clean tree)
  2. `git checkout <base>` — the main project back on its base branch
  3. `git worktree add <path> feature/x` — existing branch, no `-b`
  4. `git stash pop` in the new worktree — conflict-free, the same commit is underneath

  One `runAction`, four git calls; hive's "duplicate" mode, except nothing is copied, the state
  moves. Ignored files do not move, as with every new worktree. Ask first when `state.operation`
  says a merge or rebase is underway, and when an agent is working in that folder — that is the
  very case the model exists to avoid.

- **Removing is one action, behind a question.** "Remove worktree" runs `git worktree remove
  <path>` without `--force`, through `runAction` (it wants the index lock). A dirty worktree is
  refused by git and its message is the notice — commit, stash, or `--force` in a terminal, like
  everything that needs a judgement per file. The worktree branch stays; deleting it is the action
  the branch tree already has (the one checkbox a `confirm` may carry could offer it). Nothing
  goes to the trash here: git deletes the folder itself, and a restored folder is no worktree
  without `worktree repair`, so the trash would only look safer. The child and its terminals go
  with the refresh after it. Never offered for the main worktree, nor for the one a terminal is
  standing in (research §2, wmux and agent-deck both check this).

- **No merge UI.** Getting the work back is a merge of the worktree branch, and that is a command
  an agent runs in the parent's terminal — CLAUDE.md's rule for anything needing a decision per
  line. If one is ever added, wmux's integration worktree (merge in a throwaway worktree, verify
  gate, land or discard, recoverable from git's own `MERGE_HEAD` on disk) is what it should be.

- **Nothing is removed automatically.** In none of the surveyed tools does a worktree go away on
  its own; it is always a user action. What meezeek *can* see is the state after a merge: a
  worktree whose branch was deleted stands there detached and branch-less — tuicommander calls
  that an orphan and *offers* removal (a detached HEAD with a rebase or bisect in progress is
  deliberately not one). Mark the child, offer "remove", do not act.

## What it costs to ask git

Three questions this needs answered, and where each one is cheapest. Both commands below were run
against a real repository with a linked worktree, not read out of the documentation.

- **Which branch sits in which worktree** — needed continuously, because it is what makes a branch
  row offer "open in worktree" rather than "jump there", and because an agent that runs `git
  worktree add` in a terminal must show up without a restart. It costs **no process of its own**:
  `%(worktreepath)` is one more field on the `for-each-ref` call `readRefs` already makes, and it
  answers from either side — from the main checkout and from inside a linked worktree alike.

  ```
  --format=%(refname)%00%(symref)%00%(worktreepath)
  ```

  This is the same trade the `%(symref)` field already won (CLAUDE.md, "Two things the tree needs
  cost no git process of their own"). It is empty for a branch nobody has checked out anywhere.

- **Every worktree, including the ones no branch points at** — `git worktree list --porcelain`,
  once when the repository opens, as decided above. It is not redundant with the field above and
  the two must not be collapsed into one: `for-each-ref` cannot see a **detached** worktree at
  all, and a detached, branch-less worktree is exactly the orphan the "nothing is removed
  automatically" section wants marked. So: the list finds the children at open, the ref field
  keeps the branch tree honest on every refresh, and neither belongs in the other's place.

- **Whether a project row is itself a worktree, and whose** — one process, `git rev-parse
  --git-common-dir --show-toplevel`. In the main checkout the first line is a relative `.git`; in a
  linked worktree it is an absolute path into the parent's `.git`, and the parent is that path with
  `/.git` cut off. Read **once when the project opens** and merged into every state emitted, which
  is `Repository.loadRemoteUrls`'s existing pattern and its existing justification: a worktree's
  identity changes never, and the refresh path spends its processes on what does.

  A restored `projects.json` needs this on its own account. The children are found from the
  parent's `worktree list`, but a row whose parent is not open — or is further down the file — has
  to be able to say what it is before that happens.

  **The parent's path is therefore written on the project row as well, and treated as a hint.**
  This is the one place a second record beside git earns its keep, and GitHub Desktop pays for it
  too (`Repository.mainWorktreePath`, `resolveMainWorktreePath`). Its comment says why the
  derivation alone is not enough:

  > Deleting a linked worktree can take its administrative git metadata with it, so the worktree
  > set is not always discoverable after the fact. This records the main worktree while it is still
  > known.

  `git worktree remove` and `git worktree prune` both delete that metadata, and after either one
  `rev-parse --git-common-dir` has nothing left to answer with. So: record the path when the row is
  created, check it still exists before believing it, and fall back to deriving otherwise —
  Desktop's order exactly, and for the reason it gives, that a recorded path can outlive the
  location it names and is a hint rather than the answer.

  There is one derivation left even when git has given up: in a linked worktree `.git` is a *file*
  reading `gitdir: <parent>/.git/worktrees/<name>`, which agetor's `parseWorktreeGitPointer` reads
  with plain `fs` (research §2). It still names the parent after a prune, because nothing rewrites
  it — which is also its limit: move or delete the parent and the file keeps naming the old path
  while every git command in the folder fails with `fatal: not a git repository`. Opening a
  worktree project has to survive that; `Repository` already turns a failed git call into an error
  in the state, and this is one more way in.

## Open

1. **Branch name and base on click.** Generated name (`worktree-1`, `-2`, … or two-word names
   like superset's `friendly-words`), based on `HEAD` of the parent or on the remote's default
   branch. The name is one right-click → "Rename" away either way.
2. **What `meezeek.json` says about a new worktree** — the install/build a fresh folder needs
   (see the fresh-folder limit above), and whether ignored files such as `.env` are copied
   (research §1.4 lists who copies, symlinks or hooks).
3. **The child's row.** Which name it shows (branch, folder, or the generated one), whether the
   session marks (spinner, bubble) roll up into the parent row, and how "open in worktree" from
   the parent's git pane selects the child. That last one has a shape to copy rather than invent:
   a tab opened from outside the terminals pane is brought to the front through `openedTabId`,
   applied once per id and then remembered, precisely so a re-render does not drag the user back.
   Selecting a project has the same problem and wants the same answer.

## Reading order for whoever builds it

- `worktree-research.md` §2 ("hard-won details worth stealing verbatim"): prune before add, the
  removal ladder, `existsSync` on top of `worktree list` before spawning anything into a path,
  `--` before every ref, refuse refs starting with `-`, never the main worktree, never the one
  you stand in, never delete a branch you did not create.
- `worktree-research.md` §5: the meezeek-specific ranking, in particular that git stays in
  `git-host.ts` and everything goes through `Repository.runAction`.
- `worktree-research.md` "Windows notes" at the end: path length, file locks held by a running
  agent (`worktree remove` fails on them — a notice, not a retry loop), case-insensitive paths.
- GitHub Desktop itself, `desktop/desktop`: `app/src/lib/git/worktree.ts` (the whole git layer, ~170
  lines), `app/src/models/worktree.ts`, and the `_switchWorktree` / `checkoutBranch` path in
  `app/src/lib/stores/app-store.ts`. It is the closest thing to a reference implementation in a
  codebase this one already borrows its shapes from.
- `worktree-research.md` §4, AgentsCommander: the one surveyed tool that rejects worktrees, in
  favour of a full `git clone --depth 1` per team. Worth reading for the trade-off table alone,
  and for what it gives up — its agents share one checkout, and the only thing keeping two of them
  off the same file is prose in a task file. Whichever way that question is answered, it is the
  same question this document answers with "a branch is checked out in one worktree at a time".
