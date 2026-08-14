# CLAUDE.md

## What this is

Meeseek is a git workspace for coding agents: Electron + React + xterm.js, several
repositories open at once, each with its own git pane and its own set of agent and shell
terminals. `meeseek.md` holds the product idea and the deliberate scope limits — read it
before adding anything to the git side, but read its UI sections as history (see "Where it
came from").

Git is there for navigation and control of the repository state. The actual work happens in
the terminals, so anything git can't do in two clicks belongs in an agent or a shell, not in
a new dialog.

## Do not restart the app yourself

Agents run *inside* meeseek, as terminal tabs. Killing the Electron process kills the session
you are running in, mid-turn. Build and typecheck freely, but ask the user to restart and
report back. The same goes for anything that tears down a project's terminals.

## Where it came from

**`sbc-vsc-agents`** (sibling directory, private) is the direct ancestor: a pair of VS Code
extensions that dock `claude` and `opencode` into the sidebar as real terminals. Most of the
terminal half of meeseek is a port of its `shared/`. Its own `CLAUDE.md` records *why* several
things that look arbitrary are the way they are — read it before changing any of them:

- session listing, resume, rename and delete, and the reconcile loop that adopts a session id
  a CLI has only just persisted (`src/agents/*/sessions.ts`, `src/main/session-manager.ts`)
- how each agent is driven: Claude Code is a plain CLI reading `<uuid>.jsonl` transcripts off
  disk; opencode is client/server and **everything** goes through the one server meeseek runs
  (`src/agents/opencode/server.ts`) — never reach for its CLI or its SQLite file instead
- `extractTitle`'s precedence rules for Claude Code session titles — a regression there
  silently shows the wrong tab title with nothing to catch it
- the modifier-gated terminal link providers (`src/renderer/links/`)
- OS notifications and the `background_tasks` stop guard (`src/main/os-notify.ts`,
  `src/agents/claude/hooks.ts`)
- the `--vscode-*` theming layer

Deliberately not ported: the VS Code editor context (active file, cursor, diagnostics,
breakpoints — meeseek has no editor) and the diagnostic quick fix. What survives of that
feature is the shell transcript in `src/main/shell-context.ts`, modelled on how sbc passed a
debug session's console output: a capped file the agent is pointed at, not an excerpt inlined
into every prompt.

**GitHub Desktop** is the reference for the git half, and that is the half that still needs
the most work. It is also Electron + TypeScript, so its repository models, its git process
invocation and its clone/status/branch/checkout/diff paths translate almost directly. Meeseek
needs a small fraction of it — crib the shapes, not the scope.

**VS Code** is the UI reference: tab semantics, the context menu's close actions, the theme
variable names, the sash between two panes.

`meeseek.md` still calls `terminals.view.png` and `local-changes-view.png` a binding visual
reference ("Verbindliche UI-Referenz", and again under "Zielbild"). Both files are gone — the
user deleted them because the tool no longer looks like them. Read those sections as history:
where they and the running app disagree, the app is right. What changed, and stayed changed
by agreement:

- projects live in the left sidebar, not as tabs along the top; the tab strip is one project's
  terminals only
- git is **not** a tab. Where its tab used to sit, the strip carries a button (`.git-toggle`)
  that slides a pane of its own out between the navigation and the terminals: branches over
  changed files, and nothing else. It stays out until it is pressed again (`usePaneToggle`,
  remembered like a pane size), so a terminal and the repository are on screen together
- there is one git pane for all projects, not one per project — it holds nothing a project
  would lose by being switched away from, unlike the terminals, which stay mounted
- the diff is a **dialog** over the whole window, opened by double-clicking a changed file (or
  by ctrl-clicking a path in a terminal). `DiffDialog` is deliberately not part of
  `Dialog.tsx`: that file puts questions and is built around a form with two buttons
- the git tab used to carry a console of its own, with a dropdown for which agent ran in it.
  It is gone: git commands go in an ordinary terminal tab, and with it went the `console` flag
  on a tab, the console's session bookkeeping on the project, and the layer that kept the two
  in step across restarts
- git is a permanent, unclosable, leftmost tab of that strip, not a sidebar view — branches,
  changed files and the diff are all inside it
- the branch bar is the window's bottom strip
- the panes between all of that are draggable (`src/renderer/components/Sash.tsx`)

Do not restore the screenshots, and do not rebuild the layout from `meeseek.md`'s ASCII
diagrams. Its scope limits, on the other hand, still hold.

Further references, none of them adopted yet: **Monaco** for a richer diff view, **Octokit**
and **GitBeaker** for the GitHub and GitLab providers.

## Git

Git is never reimplemented. `src/main/git.ts` wraps the local CLI: `git()` resolves for *any*
exit code — callers decide what a non-zero one means — and rejects only when git itself could
not be started. Never run git from the renderer.

All of `git.ts` runs in a `utilityProcess` of its own (`git-host.ts`), and the main process
reaches it through `git-client.ts` — a proxy whose properties are the module's own functions,
so `git.readState(path)` in `repository.ts` reads like the import it replaced. Add a function
to `git.ts` and it is callable; there is nothing to register. Two rules hold in there: nothing
may import electron (it is a plain node process), and everything crossing the boundary has to
survive a structured clone, which is why an image comes back as a data URL and an error comes
back as its message.

The one thing the split added is a call that can *reject*: `git.ts` reports a failed command in
its return value, but a git process that died takes every call in flight with it. `Repository`
catches that at each of its own entry points and turns it into the same shape the caller
already handles — an error in the state, `ok: false`, an empty list of lines. The client
restarts the process on the next call; nothing in there is worth preserving across one.

`Repository` (`src/main/repository.ts`) is the single source of truth both the git pane and the
terminals observe, so a branch an agent switches in a terminal shows up in the UI on its own.
It watches the working directory, debounces and throttles the burst (see below), and only emits
when the state actually changed — the watcher fires for plenty of edits that leave it
identical, and every emit re-renders. Diffs are loaded when a file is selected, never up front.

**Everything the git pane can do fits in a context menu, an icon button or a question.** That
line is where the scope runs, and it is a limit on the *views*, not on git: a command that
needs a list with checkboxes, a message field or a place to resolve a conflict is one the pane
does not offer, because the work happens in the terminals and that is where such a thing
belongs. What fits, GitHub Desktop's set of it is what we take.

Working today: the branch tree (local branches, remotes, tags, stashes), checkout, status,
per-file diff (including a synthesised one for untracked files, images side by side, `-w` and
opening the gaps between hunks), discarding changes, adding a file to `.gitignore`, and fetch,
pull and push. From the branch tree's own menus: creating a branch off any ref, renaming and
deleting one (the remote copy is that question's checkbox), merging a branch into HEAD,
rebasing HEAD onto one, "Update from <default>", aborting the merge or rebase git is
half-way through, creating and pushing tags, checking one out, deleting it, and applying,
popping or dropping a stash. The changes list takes a ctrl- and shift-click selection, discards
it in one go and opens a file in whatever the OS opens its type with; its header carries the two
that clear the whole list — stash everything, discard everything. Still missing, roughly in
order: clone, then GitHub and GitLab behind one `GitProvider` interface (authenticate, list
repositories, resolve a clone URL) under `src/providers/`. Providers stay separate from the
local git layer — once a repository is cloned, everything goes back through the CLI.

Every one of those commands goes through `Repository.runAction`, which runs one at a time per
repository and refreshes after it: two of them race for the same index lock, and a fetch on top
of a checkout is no better than two checkouts. The renderer holds the matching half in `App`'s
`branchAction` — one project's tree stops offering them while one runs, and the branch bar says
what is happening instead of naming HEAD. `BranchActions.run` is the one way into it: a view
puts its own question first (it is what knows the remote, the current branch, the file count),
then hands over a label and the call.

Two things the tree needs are read without a git process of their own. `readRefs` asks
`for-each-ref` for `%(symref)` alongside the name, which is empty for everything but
`<remote>/HEAD` — that is `defaultBranch`, and "Update from ..." merges the *remote-tracking*
copy of it, since an auto-fetch keeps that one current while a local `main` may be far behind
without anything saying so. And `state.operation` — the merge or rebase git stopped in the
middle of, which is what the "Abort" entry needs — is three `stat` calls in the git directory,
the way GitHub Desktop reads it. Tags cost nothing extra either: `refs/tags` is one more
argument to the same `for-each-ref`.

A remote's url is read once, when the project opens, and again after this app changes one
(`Repository.loadRemoteUrls`), then merged into every state it emits. It is what the project
row's "View on GitHub" and "Change remote URL..." need, and a url changes about never — the
refresh path spends its processes on what does.

The project row in the sidebar carries the repository-wide entries: open it in a terminal, show
it in the file manager, copy its path, view it on whatever host its remote names, change that
url, and close it. Nothing there touches the working tree — those actions live in the git pane,
where what they act on is on screen. "Open in terminal" is a *shell tab in this window*, not the
OS terminal GitHub Desktop opens: the terminals are what meeseek is for. It is created like any
other tab and then brought to the front the way a saved command's is (see Commands).

### Talking to a remote

Every command that reaches a remote — fetch, pull, push, the force push, deleting a branch or
a tag on the remote, pushing a tag — runs with `NETWORK_ENV`, and every part of it is there to
stop git asking a question: `GIT_TERMINAL_PROMPT=0`, an empty `GIT_ASKPASS` (unset, git falls back to the very
terminal the first variable is trying to avoid), and `ssh -oBatchMode=yes`. There is no console
to answer in, and a command waiting for an answer that cannot come would hold the repository's
one action slot open indefinitely. Credentials come from the user's own credential helper or
they do not come at all — meeseek has no login of its own and is not getting one before the
providers land.

Ahead and behind are read from the `git status --branch` header that a refresh already asks
for (`main...origin/main [ahead 1, behind 2]`), not from a `rev-list` of their own — the rule
below about counting invocations applies to them like everything else. `[gone]` counts as no
upstream at all: there is nothing left to compare against.

Each repository also fetches by itself every ten minutes, GitHub Desktop's interval. That one
is deliberately silent when it fails — a remote whose credentials nobody entered would
otherwise put the same notice up six times an hour for something the user never asked for. A
fetch the user pressed the button for reports like anything else.

The branch bar carries one button for all of this, and which one it is follows GitHub Desktop:
publish a branch the remote has never seen, then pull what came in, then push what went out,
and fetch when the two agree. Right-clicking it opens the ones it did not pick — fetch, pull,
pull with rebase, push, and the force push. That last one is `--force-with-lease`, so a push
that would drop commits the remote picked up since the last fetch is refused rather than
carried out, and it is the one entry there that asks before it runs.

The diff view reads its own file for the lines it shows on demand. A hunk header whose gap to
the hunk above is not empty carries an unfold button, and opening it asks `repo:file-lines`
for exactly those lines — context lines are the same in both versions of a file, so the
working tree is the one place they have to come from, and git is not run again for them. The
gaps are what the diff itself proves are there; the end of a file is not one of them, because
nothing in a diff says how far past the last hunk the file goes. Opening a gap rebuilds the
`FileDiff` the view renders, so Shiki colors the new lines along with the rest.

An image is not "Binary file." — `readDiff` recognises it by extension, hands both versions to
the renderer as data URLs (the committed one through `git show HEAD:<path>` read as a *buffer*,
since utf8 would mangle every byte of it) and the view puts them side by side. SVG is
deliberately not in that list: git diffs it as the text it is.

Discarding follows GitHub Desktop rather than `git checkout --`: a file HEAD does not know is
moved to the trash (`shell.trashItem`) instead of being deleted, so the action stays
recoverable. `git restore --source=HEAD --staged --worktree` covers everything else, index and
worktree in one command; a rename is two paths and only the old one is in HEAD.

The stash list costs the third git process a refresh spends (`readStashes`). It earns it by
being read next to the branches it belongs with — but note that a `stash@{n}` is a position,
not an identity: dropping one in a terminal renumbers the rest, so nothing may hold on to a
ref across a refresh. What the stash rows do act on is what the last refresh reported, and
every one of the three commands refreshes after itself, which is as close as this gets.

Deleting a branch is `git branch -D`, GitHub Desktop's choice too: `-d` would refuse a feature
branch whose work is not merged into HEAD, with a message about a state this pane does not
show. What that risks is what the question says out loud instead.

### What the git view deliberately does not do

The rule is the one at the top of this section — it has to fit in a menu, a button or a
question. These do not, and were all built at some point and taken back out again, so do not
put them back without being asked: a commit UI with staging per file or per line; history,
graph, cherry-pick, revert, squash and reorder; bisect and submodules; conflict resolution
beyond aborting; a side-by-side diff; discarding single lines.

The reason is not that any one of them is hard: the work happens in the terminals, and a git
command that needs a list, a message or a decision per line is exactly the kind of thing an
agent should be asked to do — in a place where the answer, the conflict and the fix are all
visible. A second, half-complete way to do it in a side panel makes the tool bigger without
making it better.

Nor does the pane offer a login of its own, PRs or CI status; those wait on the providers.
What *is* still open: clone, and the provider work above.

### git used to share a process with everyone's keystrokes

This is why git has a process of its own, and why the rules below are still worth keeping even
though the pressure that produced them is off.

The main process once read git *and* wrote to the ptys, so every git process a refresh started
was time a keystroke on its way to a terminal waited for. This was not theoretical: it made
typing in an agent's terminal visibly lag, and the event loop lost 7–11 seconds *per minute*.

Two things were wrong, and both are worth not reintroducing. `Repository.refresh` re-ran
immediately when events had arrived while it was running, which bypassed the debounce and
turned a busy working tree into an unbroken chain of git processes; the pending path now goes
back through `scheduleRefresh`, which also keeps a minimum interval between two finished
refreshes. And `readState` spawned four git processes where two do: a folder does not stop
being a repository (checked once in `start()`), and `git status --branch` reports the current
branch along with the changes. Only a detached HEAD still needs a third call.

Starting git is what costs, not the work: on the machine this was measured on — process
creation instrumented by security software — `git rev-parse` in a 58-file repository took
350ms. So the thing to count in this layer is still *invocations*, not what each one does.
Anything added to the refresh path should earn its process; it is now someone else's event
loop it blocks, but a refresh chain that never ends is a waste wherever it runs.

Then fetch, pull and push arrived — seconds to minutes each — and git moved out, which is what
`git-host.ts` and `git-client.ts` are. VS Code has git in the extension host and its terminals
in a pty host, which is why the problem cannot arise there at all. Git was the half to move
rather than the terminals: it is the unpredictable one (seconds to minutes, output of unknown
size), while relaying pty output is small and constant per chunk and is the part that has to
stay responsive. Keep it that way — a git call added straight to the main process puts the lag
back one command at a time.

`src/main/event-loop-monitor.ts` is what measured all of this and is still wired up: it samples
the loop and writes stalls to `event-loop.log` in the app's `userData`, with a tally of what
ran. It stays silent while nothing blocks.

### the watcher feeds itself — measured, not yet fixed

Every open repository refreshes at the floor of `REFRESH_MIN_INTERVAL_MS` for as long as the
window is open, whether or not anything changed. The monitor shows it: `git` sits at a steady
100+ per minute with three projects open, in runs where the user is doing nothing at all.

Where the events come from was measured with a standalone watcher on the same paths, running
the same `isIgnoredEvent`, for 60s: two repositories meeseek had open reported ~107 events
past the filter each, and one it did *not* have open reported zero. Nothing external touches
these repositories — meeseek is the only thing changing them.

They arrive in pairs, `.git\index.lock` and a bare `.git`. `git status` takes the index lock to
write the refreshed stat cache back, and Windows reports both the file and the *directory* it
sits in. The filter catches the first (`endsWith(".lock")`) and misses the second: every rule
in `isIgnoredEvent` matches a `.git/<child>` path, and the bare `.git` matches none of them. So
it schedules a refresh, whose `git status` writes the lock again. The throttle is the only
thing bounding that loop; it slows it down but does not end it. Nothing of this is visible,
because the state comes back identical and the `JSON.stringify` comparison drops it — it costs
only the three git processes per refresh, per repository, forever.

The fix is not another entry in the filter. `git --no-optional-locks status` skips the lock,
which is what the flag exists for — VS Code and GitHub Desktop both poll status with it.
Measured over 5 runs in a repository meeseek did not have open: 50 filesystem events without
it, **0** with it, at 75ms and 77ms per run. Only `readStatus` takes a lock; `for-each-ref` and
`stash list` never did, and the commands that write (checkout, fetch, pull, push) need theirs.
What it costs is that git stops writing the refreshed index back, so a stale index in a large
repository is re-stated by every status instead of being read from the cache once.

Filtering the bare `.git` event instead was considered and rejected: it guesses at which path
form each OS reports for a change inside a directory, it was only ever measured on Windows, and
on a platform that reports *only* the directory it would swallow a real branch switch.

## Commands

The sidebar's lower half is a project's saved shell commands — a build, a deploy script,
whatever is typed often enough to be worth a button. They live in a `meeseek.json` in the
repository's own root (`src/main/commands.ts`), under a `commands` key, not in meeseek's
`userData`: they describe the project, so they travel with it and can be committed like
anything else. That also means the file shows up as an untracked change in the git pane until
someone commits or ignores it.

A saved command is a command line and, where they are not the obvious ones, the folder it runs
in and the environment variables it runs with. In the file it is a plain string while neither
is needed and an object once one of them is (`{"command": "npm run build", "cwd": "web"}`), so
the common case stays one readable line. The key was `actions` until the whole feature was
renamed, and nothing reads that spelling any more: a `meeseek.json` written before the rename
looks like a project nobody has set up here, and the wand fills it again. The command
is then the one you would type standing in that folder — `npm run build`, not
`npm run build --prefix web`, which is a flag only some tools have and which reads like part of
the command when it is not.

`env` exists because there is no way to write a variable *into* a command that works anywhere:
the wand once produced `PROFILE=DEVELOPMENT java -jar target/app.jar`, which is POSIX syntax
PowerShell reads as a command name, and for `java -jar` there is no flag to express it with
either. So it is a field, set on the process instead (`SpawnOptions.envOverride`). Those
variables outrank the ones inherited from the machine — every other environment meeseek passes
a terminal is a *default* that the user's own wins over, and this is the one case where the
opposite is right: the user wrote it next to the command.

The `+` dialog asks for all three: the command, and optionally a folder and an environment. The
environment is one field, written the way it would be typed — `PROFILE=DEVELOPMENT PORT=8080` —
and read by `parseEnv`, which splits it with the very same `splitCommand` the command itself
goes through, so `NAME="a b"` means there what it means everywhere else. That is why the two
live in `src/shared/`: the renderer reads the field, the main process starts the process, and
two spellings of "what counts as one word" would drift apart. `prompt` carries them as `extras`,
a list of optional fields — only the first field of a dialog can hold its answer back.

**Running one opens a terminal tab for it.** The tab's *process is the command*, in its own
directory, ending when the command does. Nothing is buffered and nothing is
summarised — the output arrives while it works and is still there afterwards, which is what a
build actually needs.

This replaced running them in the background with a notice at the end, and that is not a
variant worth keeping alongside: the terminals are what meeseek is for, and a truncated
600-character summary of a failed build was the worst of both. The tab takes the command as
its label — a shell tab has no session to take a title from, so nothing overwrites it — and
closing it kills the process like any other terminal.

**There is no shell in between.** `splitCommand` reads the saved line as a program and its
arguments, and that program is started directly. This is what makes one entry in a repository
run the same on every machine, and it is the reason the field for environment variables exists:
with no shell there is nothing to interpret, so a pipe, a redirection, `&&`, `$(...)` and `$VAR`
are all simply not available — and none of them worked on both platforms anyway. Quotes group
one argument and are dropped; a backslash is literal, because a Windows path is full of them
and this file is read everywhere. Where the same command line goes on Windows is decided by
`resolveCommand` (`src/main/pty.ts`), which already knew how: a native `.exe` is started as
itself, a `.cmd` shim — `mvn`, `npm` — goes through `cmd.exe`, and an argument holding a space
survives both (measured, not assumed).

The way out is `"shell": true` on a command, which hands the line to `AgentDefinition.runArgs`
instead — the same shell the project's shell tabs use, `-NoProfile -Command` on win32 and a
plain `-c` elsewhere. That entry then only works where it was written, which is the trade it
makes. It is deliberately not in the wand's prompt: what an agent writes into a repository
should run everywhere.

An operator that survives the split as a word of its own (`&&`, `|`, `>`, ...) is refused with
a notice naming it, rather than passed to the program as an argument — `rm x && y` would ask
`rm` to delete two files called `&&` and `y`. Files written while these still went through a
shell are where such a line comes from, so it has to fail loudly rather than quietly do
something else.

Either way `createCommandTab` is `createTab` with a program, arguments, a directory and an
environment attached to the tab, so a saved command's terminal goes through the same lazy spawn,
the same output batching and the same close path as every other one.

Reading a `meeseek.json` that is missing, unparseable or shaped differently is simply no
commands. It is a file in the user's repository; half of it being someone else's is not a reason
to throw.

One `CommandList` serves every project, so anything it starts has to name the project it was
started for: the wand can run for minutes, and its answer belongs to the project it asked
about, not to whichever one is on screen when it comes back. The projects being looked up are
therefore kept as a set, and the result is only put on screen when that project is still the
one shown. Running a command needs none of that any more — it hands over to a tab and is done.

A tab opened from outside the terminals pane — a saved command's, or the shell a project's row asks
for — is brought to the front through `openedTabId`, which the pane applies once per tab id
and then remembers. Not on every render: the tab list changes for every status update, and a
selection that re-applied itself would drag the user back out of whatever they moved on to.

Because a saved command's process ends every time it is run, `TerminalSession` tells the two apart by
the exit code: `stopped` for a clean one (and for anything meeseek killed, whatever it said),
`error` only for a process that failed on its own. Before they had tabs this never came up —
a shell only ended when someone typed `exit`, and it was reported as an error. **Nothing draws
the difference yet:** the tab strip still marks `stopped` and `error` the same way (dimmed and
struck through, `.terminal-tab.inactive`). Showing a failed build at a glance is worth doing and
is deliberately still open — how it looks is undecided, so do not invent it.

A project with no `meeseek.json` **at all** has its commands looked up straight away, without
being asked — nobody has set it up here, and that is the one moment where guessing is worth the
wait. Which is why `readCommands` answers `null` for a missing file and `[]` for one that is
there but holds nothing: a list someone emptied on purpose stays empty. It runs at most once
per project per session, guarded by a ref.

The order of the array in `meeseek.json` is the order on screen — there is no field for it,
because two records of the same thing drift apart. Rows are reordered by dragging, the way the
project list is. What the wand adds is slotted in behind the last command that runs the same
tool (`mergeCommands`), so the maven ones end up together and the npm ones together without
disturbing anything already there; a drag outranks that, since it only decides where something
*new* lands.

The wand beside the `+` fills the list by asking an agent. It takes the first installed one
with an `askArgs` (claude, then opencode) and puts `SUGGEST_PROMPT` to it — deliberately
concrete about where commands hide, because a model told only "find the commands" answers with
what it would type in a generic project of that kind rather than with what this one declares.
It also asks for the *start* command, which is the one nobody writes down: a main method or a
binary target is a runnable program, and the project's own tooling knows how to run it even
though no script says so.
The reply is expected to be a JSON array and is read as the first bracketed run in it, since
"answer with nothing but" still tends to arrive in a fenced block. There is no cap on how many
come back, but the prompt does ask for a judgement: the commands a developer types, not the
lifecycle hooks and CI-only scripts a `package.json` is half full of. Which of the two the
prompt asks for has to stay unambiguous — it said "prefer what is run by hand" and "list all
of them" at once for a while, and a model handed both picks one. What comes back is added
without a review step: a wrong entry is one right-click away from being deleted, and a dialog
listing twelve checkboxes would cost more than it saves.

## Everything the user is told is a notice

`notify(severity, message)` from `src/renderer/components/Notices.tsx` is the only way to say
something to the user, and it takes no exceptions. No view keeps a message of its own, and
nothing is written into a pane where it happens. It is a plain function rather than a prop or a
hook — VS Code's `window.showErrorMessage` is the model — so anything that fails can report it
without a callback having been threaded down to it.

`error` and `warning` stay until they are clicked away; only `info` disappears on its own. An
identical message that is already standing is dropped rather than stacked. They are laid over
the window's bottom right corner rather than placed in the column with everything else — a
message arriving must not resize the panes underneath it — and only the messages themselves
take the pointer. The main process
reports through the same channel: `app:notice` carries a `Notice`, and the renderer hands it
straight to `notify`.

This replaced a single error string in `App`, where a second failure silently overwrote the
first, and it took the messages that used to live inside views with it — the repository error
in the branch bar and the diff error in the diff pane are both notices now. Those views show
their ordinary empty state instead, and say nothing themselves.

What is *not* a notice is a status: a tab colored for an agent that isn't installed, the
progress bar, the branch bar's own name. Those are conditions a view draws for as long as they
hold, not something that happened once.

Nor is a *question*. `src/renderer/components/Dialog.tsx` puts both kinds, and both are built
like `notify`: a plain function anything can call, and one `Dialogs` mounted next to `Notices`
that draws whatever is pending. `confirm` resolves to whether the user went through with it,
and to whether the one checkbox such a question may carry was ticked; discarding changes is
what asks today. `prompt` resolves to a name or to null — renaming a session goes through it,
and the focus lands in its field, selected, so the dialog opens ready to type in. One question
at a time, and the overlay takes the clicks that could start a second.

Naming something inline, in the row or the tab it belongs to, was tried first and is gone: it
looked right and read badly — a tab is too narrow for a name, and a field that commits on blur
loses what was typed to a stray click.

This was Electron's `dialog.showMessageBox` first, and moving it into the renderer was
deliberate: a native message box looks like the OS in the middle of an app that otherwise
looks like VS Code. The main process therefore asks nothing — `repo:delete-branch` and
`repo:discard` just do it, and the view that offers the action is where the question lives,
because that is what knows which remote holds the branch or how many files are selected.

Only ask before something that cannot be undone. A question the user answers the same way
every time is one not worth putting.

## One progress indicator

There is exactly one, the indeterminate bar under the tab strip (`.tab-progress` in
`TerminalsPane`), and everything slow in a project shares it: an agent still starting, a branch
being checked out, an open diff being read or coloured. Never add a second one anywhere —
the branch bar carried its own copy for checkouts and it is gone. A new slow operation is a new
condition in that one render, not a bar of its own.

The git pane and the diff dialog report through `App`, which hands the active project's bar
what they say — they sit outside the pane that draws it.

A button that turns while its *own* action runs is not a second one of these — it is a state of
that button, in the place the user pressed, the way VS Code spins its own refresh actions. The
sparkle in the commands list is the one so far: `SpinnerIcon` with the `spinning` class takes the
icon's place, and `.busy` keeps the disabled dimming off it. A wait that belongs to the project
rather than to one control still goes in the bar.

Since that bar reports it, no view writes "Loading..." of its own. The diff pane simply goes
empty while it reads one.

## Agent-specific vs shared code

Each agent gets a folder under `src/agents/` and is described by one `AgentDefinition`
(`src/agents/agent.ts`). The shared terminal layer never imports an agent's own code — it only
calls those callbacks, so a new agent is a new folder, one entry in `src/agents/index.ts`, and
one case in `AgentIcon` (`src/renderer/components/agent-icons.tsx`). That last one is the only
agent-specific thing living outside `src/agents/`, and it is there because that folder belongs
to the main process: a definition reaches `fs` and `child_process`, so hanging an icon off it
would pull JSX into that bundle and the agent's setup code into the renderer's.

- `executable`, `args`, `env`, `versionArgs` — how to start it and how to tell "not installed"
  from a spawn that failed for another reason
- `askArgs` — one question, answered on stdout, no terminal (`claude -p`, `opencode run`). An
  agent without it is no candidate for anything that asks; the shell has none, which is what
  keeps it out. A question asked in the background must not leave a session behind, or it
  comes back as a tab on the next start: Claude Code takes `--no-session-persistence`, and
  opencode — which has no such switch — titles the run and deletes it again in `cleanupAsk`
- `runArgs` — one command run *in* a terminal, which ends when it does; a project's saved
  commands are what use it, and only the shell has it, since a saved command is a shell command
- `sessions` — listing, resume args, rename, delete, and an optional `watch`
- `prepareSpawn` — async setup that must finish before the first spawn, and the only place an
  agent may write anything. It is handed `AgentPaths`; a rejection marks the agent unstartable,
  so only reject for something that really makes it unusable (opencode's server does, a failed
  notification script does not)
- `resolveUrlPrefix` — completes a url the agent's TUI wrapped across rows
- `createIsSessionReady` — the per-agent guess at "the CLI has drawn its first real frame",
  which drives the progress bar under the tab strip

## Never touch the user's agent configuration

Everything meeseek generates lives under its own `userData` directory and is pointed at from
outside:

- Claude Code: a generated settings file passed as `--settings`, which the CLI layers on top of
  its own configuration. `~/.claude/settings.json` is never read, written or replaced.
- opencode: `OPENCODE_CONFIG_DIR` on the **server** process (under `attach` the TUI is only a
  client, the server is what loads plugins). It is additive — it does not replace the user's
  own `plugins/`. The plugins directory is shared across repositories because opencode pays a
  minutes-long install the first time it sees an unfamiliar config dir, so each repository's
  generated plugin needs a unique filename *and* a runtime guard on `MEESEEK_PROJECT_ROOT`, or
  every open repository's context gets appended to every message. Only write the file when its
  content actually changed; a changed plugin triggers a recompile.

## Files other processes read

The context file and the shell transcript are written by meeseek and read by a separate
process — an agent's prompt hook, or the agent's own file reads. Write beside the target and
`rename` into place, never in place. Measured under continuous rewriting: writing in place
cost 41 EBUSY failures out of ~1100 Node reads and one IOException in ~380 PowerShell reads,
while temp+rename produced none. (MSYS2's `cat` is the one reader that dislikes the rename, and
it is never on that path: on win32 the hook goes through `powershell -File`, and on POSIX
`rename()` has no window at all.)

## Cross-platform requirement

Must work on Windows, Linux and macOS. Never add OS-specific behaviour without an equivalent
for the others.

- Build paths with `path.join`; route process spawning through `resolveCommand`
  (`src/main/pty.ts`).
- Generated `.ps1` files need a UTF-8 BOM — PowerShell 5.1 decodes BOM-less files as ANSI.
  Generated `sh` scripts must be LF, whatever the source file's line endings are.
- Anything written *into* a generated script has to be quoted the literal way: `@'...'@` and
  `'...'` in PowerShell, `'...'` in sh. A repository folder or a user name may hold a `$`, and
  in the interpolating forms (`@"..."@`, `"..."`) PowerShell reads `$name` as a variable and
  `$(...)` as a command to run — which is how a toast once printed half a repository's name
  and would have run whatever the other half said. `os-notify.ts` has the two helpers.
- Claude Code's hook shell on win32 varies (PowerShell, cmd.exe and Git Bash were all observed).
  Avoid shell builtins and nested quoting; invoke a plain exe, e.g.
  `powershell -NoProfile -ExecutionPolicy Bypass -File "<script>.ps1"`.

## The renderer

- Terminal output goes straight to xterm, never through React state. The instances live in
  `src/renderer/terminal-views.ts`, outside React, keyed by project *and* tab — tab ids are
  only unique within their project — so they survive tab and project switches untouched. It
  arrives batched: one message per 8ms flush carrying every terminal that produced something,
  rather than one per tab, so the message count stops growing with the number of open ones.
- A terminal that is merely hidden must keep its layout (`visibility`, not `display`) — xterm
  needs a laid-out element to measure itself. A whole pane may use `display: none`, but then it
  has to be refit when it comes back.
- A terminal sits 6px inside its pane on every side (`.terminal-stack`'s padding and
  `.terminal-host`'s matching inset — an absolutely positioned child is laid out against the
  padding box, so the padding alone does not move it). That gutter is terminal background like
  the rest, and it is what keeps the CLI from reading as if it were pressed against the window
  frame.
- **The element xterm mounts into is `.terminal-host`, never `.terminal`.** xterm gives its own
  element the class list `terminal xterm ...`, so a rule named for the plain word lands on both
  it and the container — the inset above was taken twice for months, which read as a doubled
  gutter on three sides and none on the fourth. Anything new in that subtree gets a name of its
  own for the same reason; xterm's own classes are `xterm`, `xterm-viewport`, `xterm-screen`
  and `terminal`.
- A file dragged over a terminal frames the **pane** (`.terminal-host.drag-over`), so it is clear
  which of the mounted terminals would take the drop. sbc-vsc-agents had the same thing, dashed
  and around the whole webview, because VS Code only let a drag through while Shift was held;
  here it is per pane and solid. It is a `::after` overlay whose inset negates `.terminal-host`'s,
  not a border: a border would shrink the box xterm measures, so every drag across a terminal
  would refit it and resize the pty. Only a drag carrying files raises it, which is also the
  only kind the drop handler acts on. A file dropped anywhere *else* is swallowed in
  `main.tsx`: unhandled, Electron navigates the window to it and the app is gone. Files only —
  text dragged into a field is a drop that field still has to receive.
- The terminal's background lives on `.terminal-host`, and `.xterm-viewport` is forced
  transparent over it: xterm.css hardcodes that viewport to black, which showed through as a
  black gutter and as a black strip under the last row while a pane was dragged taller. Ported
  from sbc-vsc-agents, which carries the same override for the same reason.
- **Nothing in the lane at the terminal's right edge may be left to an xterm default, and CSS
  is not what settles it.** Two things are drawn there, both xterm's own elements and both
  redrawn as the buffer grows, so what decides how they look is the **color they are given in
  `theme.ts`** — `#00000000` for each, spelled as hex because it passes through xterm's color
  parser. The scrollbar: a TUI repaints its whole viewport, so one beside it would only twitch,
  and the wheel is what scrolls. Since xterm 6 it is not a native scrollbar at all but a copy of
  VS Code's scrollable element with a `<div class="slider">`; the older rules in `styles.css`
  (`scrollbar-width`, `::-webkit-scrollbar`) never touched it. And the overview ruler, which the
  terminal asks for only to stop FitAddon reserving 14px for a scrollbar
  (`overviewRuler: { width: 1 }`) — xterm then outlines it on every frame whether or not a mark
  is in it, and unset that outline is light: a white line beside every terminal.
- Resizing is two steps, and they are debounced differently. `refitTerminal` follows the
  container immediately: it is local to xterm and only does anything on a whole row or column,
  so a dragged sash never leaves a strip of empty pane behind. `fitTerminal` also tells the
  pty, which makes the CLI repaint in full, and that one waits for the dragging to settle.
- `provideLinks` runs on **every render** while the pointer is over the terminal, and an agent
  TUI repaints constantly. Nothing expensive, and no logging, in that path.
- Measurements are shared, not invented per view. A bar along an edge is 35px, the tab strip's
  height — the title bar, both sidebar headers (`.sidebar-header`) and the diff dialog's bar
  all use it, and the next one uses it too. Same for the 22px action button, the 1px `--vscode-panel-border`
  between panes, and a pane sized in percent stating its floor in percent as well. When
  something looks like it needs a size of its own, check what the neighbouring view uses first.
- **The same goes for anything that marks or points at something.** Every line of that kind is
  1px in `--vscode-focusBorder`: the drop indicator between two rows of the project and command
  lists, the active tab's underline, the frame around a terminal a file is held over, and the
  sash while it is dragged (`--vscode-sash-hoverBorder`, VS Code's own name for the same blue).
  A new one copies an existing rule instead of picking a width and a color of its own — two of
  them that differ read as two different meanings, and that is the one thing they must not do.
  The active git toggle's 2px accent is the exception, and it is VS Code's own.
- Colors come from `--vscode-*` variables only (`src/renderer/vscode-theme.css`). Add a new
  variable rather than hardcoding, and use the name VS Code uses.
- The VS Code being copied is the **classic** one (Dark Modern's own palette, the pre-Modern
  layout), not the Modern UI with its pill-shaped tabs and translucent surfaces. When a
  detail is in question, that is the version to go and look at.
- Two hover colors, and they are not interchangeable. A *row* — a list item, a tree item, a
  tab, a section header — takes `--vscode-list-hoverBackground`. An *action button* takes the
  translucent `--vscode-toolbar-hoverBackground`, wherever it sits: on a row that is already
  hovered the list color would be invisible, and on a selected row it would be a grey patch on
  the blue. A selected row keeps its selection color while hovered; it does not change under
  the pointer. The one exception is the
  diff's syntax colors: Shiki assigns those per grammar scope, of which a theme has hundreds,
  and hands them back per token — so `src/renderer/diff-highlight.ts` writes them inline. Its
  `dark-plus` is the token half of the same theme the variables come from.
- The renderer is one bundle with no code splitting, so every Shiki grammar in that file's list
  ships whether it is used or not. It is a list of what a repository plausibly holds, not all
  two hundred; an unlisted language shows as plain text. They are imported lazily, so an
  unopened one costs bundle size but no startup time.
- `.pane-hidden` is last in `styles.css` on purpose: it has to override the `display` the panes
  it hides set on themselves, and they are all single-class selectors too.

## Commands

- `npm run compile` — bundle main, preload and renderer
- `npm run typecheck`
- `npm run lint`
- `npm start` — compile, then launch (see the warning at the top before running this)
