# Worktrees — decision record

The feature was built, tested, and then deliberately taken back out. This document exists so the
research and the reasons do not have to be redone if the decision is revisited — it is not a
description of anything currently in the codebase.

## What GitHub Desktop does

Read from the source (`desktop/desktop`), not from memory. `enableWorktreeSupport()` returns `true`
unconditionally — it is not a beta flag.

Worktrees are not in the branches view. They have their own toolbar dropdown, between the
repository selector and the branch selector (`app.tsx`):

```
Repository  →  Worktree  →  Branch  →  Push/Pull
```

Between "which repository" and "which branch", because a worktree is not a ref but a place. The
dropdown only appears once a repository has at least one linked worktree.

What the branches view gets is a single action, in the context menu of a branch and of a pull
request: "Checkout in new worktree…". The repository list's own context menu carries "Show
worktrees" and "New worktree…". Both open the same `AddWorktreeDialog`.

`AddWorktreeDialog` (`app/src/ui/worktrees/add-worktree-dialog.tsx`) asks for a folder name (which
becomes the path, changeable via a browse button) and a branch name (autocompleted against every
branch). `onSubmit` decides what `git worktree add` means from that one field:

- an existing **local** branch → checked out as itself (no `-b`)
- an existing **remote** branch → `-b <name-without-remote> <path> <remote-ref>`, creating the
  local tracking branch on the spot
- anything else → `-b <name> <path>`, a brand new branch off HEAD

The git layer (`app/src/lib/git/worktree.ts`, ~170 lines) is `listWorktrees`, `addWorktree`,
`removeWorktree(force?)`, `moveWorktree`, and `resolveMainWorktreePath`. Its comment on the last one
is worth keeping regardless of what UI sits on top of it:

> Deleting a linked worktree can take its administrative git metadata with it, so the worktree set
> is not always discoverable after the fact. This records the main worktree while it is still
> known.

`git worktree remove` and `git worktree prune` both delete `.git/worktrees/<name>`, and after either
one `git rev-parse --git-common-dir` from inside that worktree has nothing left to answer with —
which is exactly why Desktop persists the parent path rather than deriving it fresh every time.

**Desktop already answers "what if the branch is already checked out somewhere?"** — not with an
error and not with a question. From `app-store.ts`:

> If the branch is checked out in another worktree, switch to that worktree instead of checking out
> the branch in the current worktree.

It jumps. The context menu's "Checkout in New Worktree…" is never disabled for the branch already
checked out in the *current* worktree either — clicking it there just lets `git worktree add` fail,
and the dialog surfaces that failure the same way it would surface any other.

## What meezeek built (and removed again)

**Placement.** GitHub Desktop's worktree switcher sits in the toolbar because Desktop has nothing
else to carry when you switch. meezeek's projects each own mounted terminals, so switching to a
worktree has to switch the whole tab strip with it — which is what selecting a project already
does. The chosen shape was therefore a child row under its repository in the project list:

```
meezeek
|-> meezeek-feature-worktree-test
autocontract
```

Marked by reusing the existing branch icon on the row rather than by indenting it — "Branch = what
is worked on, worktree = where it is worked on", and the icon says exactly that without a second
nesting measure to invent in the sidebar.

**Adoption, not storage.** A repository's worktrees were never written to `projects.json`. They
were read from `git worktree list --porcelain` once when the project opened, again after any action
that could have changed the set, and again when the filesystem watcher saw `.git/worktrees/<name>`
appear or disappear. This means: no "hide from the list" state was needed (it would have been a
second record beside git, and the row would have been back on the next start anyway), a worktree
created in a terminal showed up on its own, and one removed with `git worktree remove` in a terminal
disappeared on its own.

**Where the new folder went.** Explicitly decided as a sibling of the repository
(`<repo>-<branch>`, slashes in the branch name flattened to hyphens), not inside meezeek's own
`userData`. The trade-off that was weighed and set aside: a folder under `userData` needs no name
prompt either, keeps the repository's own parent directory untouched, and makes "we only ever
delete paths we created" trivial — but it sits far from the project in a file manager and breaks
relative tooling paths (`../shared-config`). The sibling folder was the deliberate choice anyway,
matching GitHub Desktop's own naming.

**Two entry points**, deliberately not unified into one dialog the way Desktop's is:

- **"Checkout in new worktree"**, on a branch row's context menu (local and remote). Takes an
  *existing* branch only, no prompt. meezeek disabled it for the branch currently checked out in
  that project — a deliberate divergence from Desktop, which leaves the entry active everywhere and
  lets git's own refusal surface as the error.
- **"New worktree…"**, on a repository's own context menu in the project list. One prompt, one
  field: a branch name. The same three-way decision Desktop's dialog makes from its branch field —
  existing local → checkout, existing remote → track, anything else → new branch off HEAD — made in
  the main process, `Repository.createWorktree(branch, remote?)`, since that is where the branch
  lists already live.
- A third case Desktop's dialog also covers in one field but meezeek split out: **a new branch off
  a *specific* ref**, not HEAD. Added as a checkbox, "Create it in a new worktree", on the existing
  "Create branch from `<ref>`…" prompt (`BranchTree.askCreateBranch`) — ticked, it calls
  `Repository.createBranchInWorktree(name, startPoint)`, which is `git worktree add -b <name>
  <path> <startPoint>` with nothing inferred, since the dialog only offers this where the branch is
  known to be new.

**What the row could not do.** No close button and no "Close repository" entry on a worktree row —
removing one is git's business (`git worktree remove` in a terminal, or from wherever this feature
would have grown a delete action), not the list's. The row would have reappeared on the very next
`git worktree list` if the list had merely hidden it.

## The bug that was found and fixed before the feature was pulled

A worktree child project's `id` was built as `worktree:<full path>` — meant to be stable across
restarts (derived, not random) and to double as a lookup key. It was never audited against every
*other* place a `Project.id` is used, and there are two: `ShellContext`'s log directory and the
per-agent session storage root are both `path.join(storageRoot, "...", project.id)` — the id is used
**verbatim as a filesystem path segment**.

A single colon is enough to break that on Windows:

```
fs.mkdirSync('...\projects\worktree:abc123', { recursive: true })
// ENOENT: no such file or directory, mkdir '...\projects\worktree:abc123'
```

With the *full path* (backslashes and a drive-letter colon) as the id, `mkdirSync` failed the same
way, deep inside `openProject(child)` → `SessionManagerRegistry.open` → `new ShellContext`. That
failure was an **unhandled promise rejection** in a chain that started from a synchronous callback
(`Repository.onWorktrees` → `RepositoryManager`'s wrapper → `syncWorktrees`), which aborted
`syncWorktrees` before it reached its own `send("projects:changed", ...)` call at the end. The push
to the renderer therefore never happened — silently, with nothing in the UI, nothing in the
renderer's console, and nothing but a stderr line in the terminal `npm start` was run from, a
channel nothing in the app itself reads.

Fixed (while the feature still existed) by hashing the path instead:
`worktree-${sha1(worktree.path)}` — no colon, no backslashes, still derived rather than random.

**The lesson, kept regardless of whether worktrees come back**: before picking the shape of any
new `id`, grep every existing use of that field across the codebase. `project.id` was already load-
bearing as a path segment in two places that had nothing to do with the feature being added, and
neither showed up by reasoning about worktrees alone.

**A second, smaller finding**: `git worktree remove` can fail with `Permission denied` on Windows
while something (a running terminal, an open Explorer window, an agent process) still holds the
directory open — matches the general "Windows notes" caution about file locks. Observed once with a
worse outcome than a clean failure: git had already pruned its own `.git/worktrees/<name>` metadata
before the removal of the directory itself failed, leaving an orphaned folder on disk that `git
worktree remove` no longer recognised (`fatal: '<path>' is not a working tree`) and that needed a
plain `rm -rf` to finish the job.

## Reading order if this is picked back up

- This document, start to finish.
- `desktop/desktop`, `app/src/lib/git/worktree.ts` and `app/src/ui/worktrees/add-worktree-dialog.tsx`
  — the closest thing to a reference implementation, in a codebase this one already borrows its
  shapes from for everything else git.
- Re-derive the "child row in the project list, adopted from git, never stored" decision from
  scratch before touching code — it followed directly from meezeek's projects owning mounted
  terminals, and that constraint has not changed.
- Re-run the id audit above before choosing how to identify a worktree row, whatever shape that
  takes next time.
