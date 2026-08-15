# CLAUDE.md

## What this is

Meezeek is a git workspace for coding agents: Electron + React + xterm.js, several repositories
open at once, each with its own git pane and its own set of agent and shell terminals.

Git is there for navigation and control of the repository state. **The actual work happens in the
terminals**, so anything git can't do in two clicks belongs in an agent or a shell, not in a new
dialog.

## Do not restart the app yourself

Agents run *inside* meezeek, as terminal tabs. Killing the Electron process kills the session you
are running in, mid-turn. Build and typecheck freely, but ask the user to restart and report back.
The same goes for anything that tears down a project's terminals.

## Where it came from

**`sbc-vsc-agents`** (sibling directory, private) is the direct ancestor: two VS Code extensions
docking `claude` and `opencode` into the sidebar as real terminals. Most of the terminal half of
meezeek is a port of its `shared/`, and its `CLAUDE.md` records *why* these are the way they are —
read it before changing any of them:

- session listing, resume, rename and delete, and the reconcile loop that adopts a session id a
  CLI has only just persisted (`src/agents/*/sessions.ts`, `src/main/session-manager.ts`)
- how each agent is driven: Claude Code is a plain CLI reading `<uuid>.jsonl` transcripts off disk;
  opencode is client/server and **everything** goes through the one server meezeek runs
  (`src/agents/opencode/server.ts`) — never reach for its CLI or its SQLite file instead
- `extractTitle`'s precedence rules for Claude Code session titles — a regression there silently
  shows the wrong tab title with nothing to catch it
- the modifier-gated terminal link providers (`src/renderer/links/`)
- OS notifications and the `background_tasks` stop guard (`src/main/os-notify.ts`,
  `src/agents/claude/hooks.ts`)
- the `--vscode-*` theming layer

Not ported: the VS Code editor context (meezeek has no editor) and the diagnostic quick fix. What
survives of it is the shell transcript in `src/main/shell-context.ts` — a capped file the agent is
pointed at, not an excerpt inlined into every prompt.

**GitHub Desktop** is the reference for the git half: Electron + TypeScript too, so its repository
models, git invocation and clone/status/branch/checkout/diff paths translate almost directly. Crib
the shapes, not the scope. **VS Code** is the UI reference (tab semantics, close actions, theme
variable names, the sash) — the **classic** one, Dark Modern's palette and the pre-Modern layout,
not the Modern UI with its pill-shaped tabs. Not adopted yet: **Monaco** for a richer diff view,
**Octokit** and **GitBeaker** for the providers.

## The layout

- projects live in the left sidebar; the tab strip is one project's terminals only
- git is **not** a tab. The strip carries a button (`.git-toggle`) sliding out a pane between the
  navigation and the terminals: branches over changed files, nothing else. It stays out until
  pressed again (`usePaneToggle`, remembered like a pane size), so a terminal and the repository
  are on screen together
- one git pane for all projects — it holds nothing a project would lose by being switched away
  from, unlike the terminals, which stay mounted
- the diff is a **dialog** over the whole window, opened by double-clicking a changed file or
  ctrl-clicking a path in a terminal. `DiffDialog` and `SettingsDialog` are deliberately not part
  of `Dialog.tsx`: that file puts questions and is built around a form with two buttons
- git commands go in an ordinary terminal tab, not in a console of the pane's own
- the branch bar is the window's bottom strip
- the panes between all of that are draggable (`src/renderer/components/Sash.tsx`)

## Nothing starts without git and an agent

`src/main/requirements.ts` looks for both before anything opens: git through `git.isAvailable()`
and every agent that has `versionArgs` — the shell has none, which keeps it out. The renderer asks
(`startup:check`), and passing is what starts the app: `main.ts` does not open the stored projects
when the app is ready, `openWorkspace` does, from that handler. A machine missing something
therefore watches no repository and spawns no terminal — `Startup` puts `RequirementsDialog` up
instead of mounting `App` at all.

That dialog is a wall rather than a question, so no Escape takes it away, and **it installs
nothing**: no command works on all three platforms, most want an elevation prompt or a shell to
answer in, and a program installed while the dialog stands is still missing from the PATH this
process was started with — only a restart picks that up, and the dialog says so.

On a machine that has everything the dialog is unreachable, so `--simulate` names the commands to
report missing anyway: `npm start -- --simulate=git,claude`, npm's `--` handing the flag past the
script to electron.

## Git

Git is never reimplemented. `src/main/git.ts` wraps the local CLI: `git()` resolves for *any* exit
code — callers decide what a non-zero one means — and rejects only when git itself could not be
started. Never run git from the renderer.

All of `git.ts` runs in a `utilityProcess` of its own (`git-host.ts`), which the main process
reaches through `git-client.ts` — a proxy whose properties are the module's own functions, so
`git.readState(path)` reads like the import it replaced and a new function needs no registering.
Two rules in there: nothing may import electron (it is a plain node process), and everything
crossing the boundary has to survive a structured clone — hence an image as a data URL and an
error as its message.

The split adds a call that can *reject*: a failed command is in the return value, but a git process
that *died* takes every call in flight with it. `Repository` catches that at each entry point and
turns it into the shape the caller already handles — an error in the state, `ok: false`, an empty
list. The client restarts the process on the next call.

`Repository` (`src/main/repository.ts`) is the single source of truth both the git pane and the
terminals observe, so a branch an agent switches in a terminal shows up in the UI on its own. It
watches the working directory, debounces and throttles the burst, and only emits when the state
actually changed — the watcher fires for plenty of edits that leave it identical, and every emit
re-renders. Diffs are loaded when a file is selected, never up front.

**Everything the git pane can do fits in a context menu, an icon button or a question.** That
limits the *views*, not git: a command needing a list with checkboxes, a message field or a place
to resolve a conflict is one the pane does not offer. Of what fits, GitHub Desktop's set is what we
take — today the branch tree (branches, remotes, tags, stashes) with its per-ref menus, checkout,
status, per-file diff, discard, `.gitignore`, fetch/pull/push, and cloning from the add-repository
dialog. Cloning brought GitHub and GitLab with it, behind one `GitProvider` interface
(authenticate, list repositories, resolve a clone URL) under `src/providers/`. Providers stay out
of the local git layer — once cloned, everything goes back through the CLI.

Every action goes through `Repository.runAction`, which runs one at a time per repository and
refreshes after it: two of them race for the same index lock. Discarding and ignoring go through it
too — a discard is offered from a context menu that does not know a fetch is running, and `git
restore` wants the same lock. The renderer holds the matching half in `App`'s `branchAction`: one
project's tree stops offering them while one runs, and `BranchBar` says what is happening instead
of naming HEAD. `BranchActions.run` is the one way in — a view puts its own question first (it is
what knows the remote, the current branch, the file count), then hands over a label and the call.

Two things the tree needs cost no git process of their own. `readRefs` asks `for-each-ref` for
`%(symref)` alongside the name, empty for everything but `<remote>/HEAD` — that is `defaultBranch`,
and "Update from ..." merges the *remote-tracking* copy of it, since an auto-fetch keeps that one
current while a local `main` may be far behind; tags are one more argument to the same call. And
`state.operation` — the merge or rebase git stopped in the middle of, which "Abort" needs — is
three `stat` calls in the git directory.

A remote's url is read once when the project opens and again after this app changes one
(`Repository.loadRemoteUrls`), then merged into every state emitted: a url changes about never, and
the refresh path spends its processes on what does.

The project row in the sidebar carries the repository-wide entries (open in a terminal, show in the
file manager, copy the path, view on the host its remote names, change that url, close). Nothing
there touches the working tree; those actions live in the git pane, where what they act on is on
screen. "Open in terminal" is a *shell tab in this window*, created like any other tab and brought
to the front the way a saved command's is.

### Talking to a remote

Every command reaching a remote — fetch, pull, push, force push, deleting a branch or tag on the
remote, pushing a tag — runs with `NETWORK_ENV`, all of which exists to stop git asking a question:
`GIT_TERMINAL_PROMPT=0`, an empty `GIT_ASKPASS` (unset, git falls back to the very terminal the
first variable avoids), and `ssh -oBatchMode=yes`. There is no console to answer in, and a command
waiting for an answer that cannot come holds the repository's one action slot open indefinitely.
Credentials come from the user's own credential helper or a provider account's token, or not at all
— meezeek writes nothing into that helper, which is machine-wide and every other git client's too.

`LC_ALL=C` is in there for a different reason: git translates its own messages, and `runNetwork`
matches two of them (`could not read Username`, `Authentication failed`) to set `authRequired` —
there is no exit code for it, every fatal error of a clone is 128. Unpinned, a machine with
`LANG=de_DE` answers "Authentifizierung fehlgeschlagen" and matches nothing. A repository git could
not find stays out of that list on purpose: GitHub and GitLab answer 404 for a private repository
*and* for a typo, so credentials would be a guess.

`authRequired` is what the add-repository dialog's clone acts on, and all it does is ask: the clone
runs with nothing, and only when it comes back short does `CloneAuth` appear under the fields — the
accounts for *this host* on one side of a switch, a token on the other, never both. A typed token
is validated and stored as an account on the way through. An ssh url never gets there, since a
missing key fails with a message none of the patterns match — the truth, as no token would have
helped.

Ahead and behind are read from the `git status --branch` header a refresh already asks for
(`main...origin/main [ahead 1, behind 2]`), not from a `rev-list` of their own. `[gone]` counts as
no upstream at all.

Each repository also fetches by itself every ten minutes, GitHub Desktop's interval, and that one
is **silent** when it fails — a remote whose credentials nobody entered would otherwise put the
same notice up six times an hour for something the user never asked for. A fetch the user pressed
the button for reports like anything else.

The branch bar carries one button for all of this, and which one it is follows GitHub Desktop:
publish a branch the remote has never seen, then pull what came in, then push what went out, and
fetch when the two agree. Right-clicking it opens the rest — fetch, pull, pull with rebase, push,
force push. That last one is `--force-with-lease`, so a push that would drop commits the remote
picked up since the last fetch is refused rather than carried out, and it is the one entry there
that asks before it runs.

### The diff

A diff is read with `-w` and synthesised for an untracked file, which git has nothing to compare.
The diff view reads its own file for the lines it shows on demand. A hunk header whose gap to the
hunk above is not empty carries an unfold button, and opening it asks `repo:file-lines` for exactly
those lines — context lines are identical in both versions, so the working tree is the one place
they have to come from and git is not run again. The gaps are what the diff itself proves are
there; the end of a file is not one, because nothing in a diff says how far past the last hunk it
goes. Opening a gap rebuilds the `FileDiff` the view renders, so Shiki colors the new lines with
the rest.

An image is not "Binary file." — `readDiff` recognises it by extension and hands both versions to
the renderer as data URLs; the committed one goes through `git show HEAD:<path>` read as a
*buffer*, since utf8 would mangle every byte. SVG is deliberately not in that list: git diffs it as
the text it is.

### Where we follow GitHub Desktop rather than git's default

- Discarding is not `git checkout --`: a file HEAD does not know is moved to the trash
  (`shell.trashItem`) instead of deleted, so the action stays recoverable. `git restore
  --source=HEAD --staged --worktree` covers everything else, index and worktree in one command; a
  rename is two paths and only the old one is in HEAD.
- Deleting a branch is `git branch -D`. `-d` would refuse a feature branch whose work is not merged
  into HEAD, with a message about a state this pane does not show; what that risks is what the
  question says out loud instead.
- A `stash@{n}` is a position, not an identity: dropping one in a terminal renumbers the rest, so
  nothing may hold a ref across a refresh. The rows act on what the last refresh reported, and all
  three stash commands refresh after themselves.

### What the git view deliberately does not do

These were all built at some point and taken back out again, so do not put them back without being
asked: a commit UI with staging per file or per line; history, graph, cherry-pick, revert, squash
and reorder; bisect and submodules; conflict resolution beyond aborting; a side-by-side diff;
discarding single lines. A git command needing a list, a message or a decision per line is exactly
what an agent should be asked to do, in a place where the answer, the conflict and the fix are all
visible.

PRs and CI status are still open. The provider accounts are not a login of the pane's either — they
live in the add-repository dialog, the one place that talks to a host rather than to a repository.

### Keep git off the main process, and count its invocations

Each of these was paid for once and measured; the numbers are in the comment at each site.

- Git stays in its own process. A git call added straight to the main process puts the typing lag
  back one command at a time — the main process writes to the ptys, and relaying pty output is the
  part that has to stay responsive.
- Starting git is what costs, not the work it does, so count *invocations*. `readState` gets by
  with two (`git status --branch` reports the branch along with the changes; only a detached HEAD
  needs a third), and anything added to the refresh path has to earn its process — `readStashes`
  is the third one a refresh spends.
- A refresh finding events waiting goes back through `scheduleRefresh` instead of re-running at
  once — the immediate path bypassed the debounce and turned a busy working tree into an unbroken
  chain of git processes.
- `readStatus` runs `git --no-optional-locks status`. Without it, writing the index back is itself
  a filesystem event, which schedules the refresh that writes it again. Do not solve that with
  another entry in `isIgnoredEvent`.
- `src/main/event-loop-monitor.ts` is wired up and off unless `NODE_DEBUG` names it:
  `NODE_DEBUG=meezeek-perf npm start` writes stalls to `event-loop.log` in `userData`.
  `countActivity` stays at its call sites either way.

## Saved commands

The sidebar's lower half is a project's saved shell commands. They live under a `commands` key in a
`meezeek.json` in the repository's own root (`src/main/commands.ts`), not in meezeek's `userData`:
they describe the project, so they travel with it and can be committed — which also means the file
shows up as an untracked change until someone commits or ignores it. The key was `actions` before
the feature was renamed and nothing reads that spelling any more, so such a file looks like a
project nobody has set up here and the wand fills it again.

A saved command is a command line plus, where they are not the obvious ones, a `name`, a `cwd` and
an `env`. In the file it is a plain string while none of those is needed and an object once one is
(`{"command": "npm run build", "cwd": "web"}`). `name` is a label and nothing more: the row shows
it *instead of* the command line, which stays a tooltip away. The command is the one you would type
standing in that folder — `npm run build`, not `npm run build --prefix web`.

`env` exists because there is no way to write a variable *into* a command that works anywhere:
`PROFILE=DEVELOPMENT java -jar target/app.jar` is POSIX syntax PowerShell reads as a command name,
and `java -jar` has no flag for it either. So it is a field, set on the process instead
(`SpawnOptions.envOverride`), and those variables outrank the ones inherited from the machine —
every other environment meezeek passes a terminal is a *default* the user's own wins over, and this
is the one case where the opposite is right: the user wrote it next to the command.

The `+` dialog asks for all of them, and "Edit..." in a row's context menu is the same dialog with
the row's values in it. What it does not ask about is `shell`, which is therefore carried over
rather than dropped — editing a command must not quietly change how it is started. The environment
is one field, written the way it would be typed (`PROFILE=DEVELOPMENT PORT=8080`), and `parseEnv` /
`formatEnv` read and write it with the very same `splitCommand` the command goes through, so
`NAME="a b"` means there what it means everywhere else. That is why both live in `src/shared/`: two
spellings of "what counts as one word" would drift apart. `prompt` carries the optional fields as
`extras` — only the answer's own field can hold a dialog back, which is why the name is one of them
even though `valueIndex` puts it above the command.

**Running one opens a terminal tab for it.** The tab's *process is the command*, in its own
directory, ending when the command does. Nothing is buffered and nothing is summarised — the output
arrives while it works and is still there afterwards, which is what a build needs. The tab takes
the command as its label, and closing it kills the process like any other terminal.

**There is no shell in between.** `splitCommand` reads the saved line as a program and its
arguments, and that program is started directly. This is what makes one entry run the same on every
machine, and why `env` is a field: with no shell there is nothing to interpret, so a pipe, a
redirection, `&&`, `$(...)` and `$VAR` are not available — and none of them worked on both
platforms anyway. Quotes group one argument and are dropped; a backslash is literal, because a
Windows path is full of them. Where the line goes on Windows is `resolveCommand`'s decision
(`src/main/pty.ts`): a native `.exe` is started as itself, a `.cmd` shim — `mvn`, `npm` — goes
through `cmd.exe`, and an argument holding a space survives both (measured, not assumed).

An operator that survives the split as a word of its own (`&&`, `|`, `>`, ...) is refused with a
notice naming it, rather than passed to the program as an argument — `rm x && y` would ask `rm` to
delete two files called `&&` and `y`. Files written while these still went through a shell are
where such a line comes from, so it has to fail loudly. The way out is `"shell": true`, which hands
the line to `AgentDefinition.runArgs` instead — the same shell the project's shell tabs use,
`-NoProfile -Command` on win32 and a plain `-c` elsewhere. That entry then only works where it was
written,
which is why it is deliberately not in the wand's prompt: what an agent writes into a repository
should run everywhere.

Either way `createCommandTab` is `createTab` with a program, arguments, a directory and an
environment attached, so a saved command's terminal goes through the same lazy spawn, output
batching and close path as every other one.

A tab opened from outside the terminals pane — a saved command's, or the shell a project's row asks
for — is brought to the front through `openedTabId`, which the pane applies once per tab id and
then remembers. Not on every render: the tab list changes for every status update, and a selection
re-applying itself would drag the user back out of whatever they moved on to.

Because a saved command's process ends every time it runs, `TerminalSession` tells the two apart by
exit code: `stopped` for a clean one (and for anything meezeek killed, whatever it said), `error`
only for a process that failed on its own. **Nothing draws the difference yet:** the tab strip marks
both the same way (`.terminal-tab.inactive`). Showing a failed build at a glance is worth doing and
is deliberately still open — how it looks is undecided, so do not invent it.

Reading a `meezeek.json` that is missing, unparseable or shaped differently is simply no commands:
it is a file in the user's repository, and half of it being someone else's is not a reason to
throw. A project with no `meezeek.json` **at all** has its commands looked up straight away,
without being asked — nobody has set it up here. Which is why `readCommands` answers `null` for a
missing file and `[]` for one that is there but holds nothing: a list someone emptied on purpose
stays empty. It runs at most once per project per session, guarded by a ref.

The order of the array is the order on screen — there is no field for it, because two records of
the same thing drift apart. Rows are reordered by dragging, the way the project list is, both
through `useDragReorder` (`src/renderer/components/drag-reorder.ts`), which is also where the
reasons behind the drag details live (own MIME type per list, the insertion index read off the
event, the strip below the last row). What the wand adds is slotted in behind the last command
running the same tool (`mergeCommands`); a drag outranks that, since it only decides where
something *new* lands.

The wand beside the `+` fills the list by asking an agent: the first installed one with an
`askArgs` (claude, then opencode), put `SUGGEST_PROMPT`. That prompt is deliberately concrete about
where commands hide, because a model told only "find the commands" answers with what it would type
in a generic project of that kind rather than with what this one declares. It also asks for the
*start* command, the one nobody writes down. The reply is expected to be a JSON array and read as
the first bracketed run in it, since "answer with nothing but" still tends to arrive in a fenced
block. There is no cap on how many come back, but the prompt asks for a judgement — the commands a
developer types, not the lifecycle hooks and CI-only scripts a `package.json` is half full of — and
that has to stay unambiguous: it said "prefer what is run by hand" and "list all of them" at once
for a while, and a model handed both picks one. What comes back is added without a
review step — a wrong entry is one right-click away from being deleted.

One `CommandList` serves every project, so anything it starts has to name the project it was
started for: the wand can run for minutes, and its answer belongs to the project it asked about,
not to whichever one is on screen when it comes back. The projects being looked up are kept as a
set, and the result is only shown when that project is still the one on screen.

## Settings

One dialog for everything meezeek keeps about *itself* rather than about a repository, and the one
button in the window that belongs to neither a project nor a pane. It sits at the end of the title
bar and is meant to read as one of the platform's own window controls: **not** an `.icon-button`
but a 46px box the full height of the bar, without the 3px radius the buttons elsewhere have — VS
Code's own measurement, and what the overlay reserves per control. Where it stops is `.titlebar`'s
`padding-right`, read off the Window Controls Overlay environment variables
(`env(titlebar-area-width)`), so it stands directly against minimize on Windows and Linux; macOS
publishes no such variables and puts its controls on the left, so the fallback leaves it at the
right edge.

It asks nothing — a switch applies the moment it is flipped, as VS Code's own settings do — so the
one button closes it. It is tabbed (Notifications, then Info) with the add-repository dialog's own
strip (`.dialog-tabs`), which is why neither dialog carries a `.dialog-title`: the selected tab
names what is under it. The height is fixed to the fuller tab so switching does not resize it under
the pointer. Info reads nothing but `app:info`, asked once when the dialog opens.

The values live in a `settings.json` in meezeek's `userData` (`src/main/settings.ts`), written whole
from memory like the projects beside them and read back defensively: a key of the wrong type falls
back to its default rather than reaching an agent as `undefined`.

**A setting reaches an agent through `AgentPaths`**, handed over rather than imported, so the
persisted copy stays the only one. It is read in `pathsFor`, i.e. at `prepareSpawn`, which is the
honest limit of what a switch can do: Claude Code reads the generated `--settings` file at startup
and opencode's notifier is built around the event stream when its server comes up, so an agent is
handed its notification setup once and cannot be reached afterwards. A change applies to what is
started after it, and the dialog says so.

Deliberately not in there: the mark on a tab that finished out of sight. It is not a notification
the user turns off but how such a session is found again (see that section).

## Everything the user is told is a notice

`notify(severity, message)` from `src/renderer/components/Notices.tsx` is the only way to say
something to the user, and it takes no exceptions. No view keeps a message of its own, and nothing
is written into the pane where it happens. It is a plain function rather than a prop or a hook — VS
Code's `window.showErrorMessage` is the model — so anything that fails can report it without a
callback threaded down to it. The main process uses the same channel: `app:notice` carries a
`Notice`, and the renderer hands it straight to `notify`.

`error` and `warning` stay until they are clicked away; only `info` disappears on its own. An
identical message already standing is dropped rather than stacked. They are laid over the window's
bottom right corner rather than placed in the column with everything else — a message arriving must
not resize the panes underneath it — and only the messages themselves take the pointer.

What is *not* a notice is a status — a tab colored for an agent that isn't installed, the progress
bar, the branch bar's own name. Those are conditions a view draws for as long as they hold.

Nor is a *question*. `src/renderer/components/Dialog.tsx` puts both kinds, built like `notify`: a
plain function anything can call, and one `Dialogs` mounted next to `Notices` drawing whatever is
pending. `confirm` resolves to whether the user went through with it, and to whether the one
checkbox such a question may carry was ticked. `prompt` resolves to a name or to null — renaming a
session goes through it, and the focus lands in its field, selected. One question at a time, and
the overlay takes the clicks that could start a second. Naming something inline, in the row or the
tab it belongs to, was tried and is gone: a tab is too narrow for a name, and a field that commits
on blur loses what was typed to a stray click.

The main process asks nothing — `repo:delete-branch` and `repo:discard` just do it, and the
question lives in the view offering the action, because that is what knows which remote holds the
branch or how many files are selected. Electron's native `dialog.showMessageBox` is not used: it
looks like the OS in the middle of an app that otherwise looks like VS Code.

Only ask before something that cannot be undone. A question the user answers the same way every
time is one not worth putting.

## One progress indicator

There is exactly one, the indeterminate bar under the tab strip (`.tab-progress` in
`TerminalsPane`), and everything slow in a project shares it: an agent still starting, a branch
being checked out, an open diff being read or coloured. Never add a second one anywhere — a new
slow operation is a new condition in that one render. The git pane and the diff dialog sit outside
the pane that draws it and report through `App`, which hands the active project's bar what they
say. And since that bar reports it, no view writes "Loading..." of its own; the diff pane simply
goes empty while it reads one.

**A spinner in place of an icon is not a second one of these.** The bar is about the project; this
is about the one thing the icon already stands for, drawn where the user is looking for it.
`SpinnerIcon` with the `spinning` class takes that icon's place — never a slot of its own beside it
— and there are two: the wand in the commands list while it is asking an agent (`.busy` keeps the
disabled dimming off it, since it is disabled for being underway rather than for having nothing to
do), and a tab's agent icon while that session is working on a turn (`TerminalDescriptor.busy`).
The project row is the one place a spinner stands on its own, because that row has no icon to
replace.

## Both ends of a turn

A session says whether it is *working* and whether it *finished out of sight*, and the two are one
mechanism read at either end of the same turn. Both are drawn in both places — on the tab and on
its project's row — so a project that is not on screen still says what its sessions are doing:

- **working**: a spinner, for as long as the turn runs.
- **finished out of sight**: a speech bubble. One shape for one thing — a bell in the sidebar was
  tried and taken back out, since two glyphs for the same condition read as two conditions. It goes
  away the moment the tab is in front of the user, and it is deliberately not a notice: a notice is
  something that happened once, this is a condition that holds until it is answered.

In the project row both are buttons that step through their sessions one press at a time. They do
it differently, and the difference is the mechanism: the bubble works through its list by *emptying*
it, since a session seen stops being marked, while a session watched carries on working — so the
spinner keeps a cursor per project (`App.busyCursor`, a ref: it changes what the next press does,
not what is on screen) and wraps around.

**On a tab both take the agent icon's place** rather than a slot of their own — a tab is as wide as
its label, and the icon is already what stands for "which session is this". Working outranks
finished where both hold, since a turn that started after the last one ended is the newer truth and
the mark is still underneath when it stops. In the sidebar there is no icon to replace, so the two
stand next to each other, left of the close button. Both are `--vscode-focusBorder` under one
`.session-mark` rule: two states of one thing must not read as two kinds of thing.

**Nothing here is read off the terminal.** Each agent already knows when a turn starts and ends,
and `AgentPaths.onSessionBusy` / `onSessionFinished` are how it says so:

- opencode says `session.status` with a `busy` status, then `session.idle`, on the event stream
  meezeek is already subscribed to. `subscribe` carries `properties.sessionID` and
  `properties.status.type` alongside the event's `type`, all three verified against the binary's
  own `mo.define({type:"session.idle",schema:{sessionID}})`, its `SessionStatus` union, and the
  `{type, properties}` envelope it publishes with.
- Claude Code's hooks are processes of their own that cannot call back into meezeek, so each end
  `touch`es an empty file named after the session id — `UserPromptSubmit` into `<agentDir>/busy/`,
  `Stop` into `<agentDir>/finished/` — and `watchMarkers` picks them up. Both halves live in
  `hooks.ts`, either side of `markerDir`. The busy hook shares `UserPromptSubmit` with the command
  that prints the context file, so it must stay **silent**: everything such a hook writes is
  appended to the prompt itself. It must also exit 0 whatever happens, since a failing
  UserPromptSubmit hook can hold the prompt back.

`watchMarkers` sweeps its directory on a timer **as well as** watching it, and that net is not
optional: on win32 `fs.watch` can fire before the new name is in the directory listing, and nothing
ever fires again for that file — a single lost event then strands that turn forever, the spinner
never stops and the mark never lands. Observed with a marker sitting in `finished/` seven minutes
after it was written, the watcher process healthy the whole time. A `readdir` on an almost always
empty directory is a syscall rather than a process, so the net is free in the terms the git section
counts in.

**Claude Code runs no Stop hook for a turn the user cut short**, so that end never reaches
`finished/` at all — an escaped prompt or a rejected tool call left the spinner running until the
next turn ended. Confirmed in the transcript: the completed turn has a `stop_hook_summary` naming
`stop-guard.ps1`, the interrupted one has none, and no hook event covers an interrupt. The net is
the transcript itself, which records a `system` / `turn_duration` entry at *every* turn end: the
session listing reports it as `AgentSessionInfo.turnEndedAt`, out of the same tail scan
`custom-title` already needed, and `reconcile` is the one place it is read. It only ever *ends* a
turn, only one still believed to be running, and only when that end is newer than the busy which
started it — an older one belongs to the turn before. It leaves no mark: an end that reaches us
this way is one the user cut short in that very tab.

Reusing the Stop hook is the point of it: it already carries the `background_tasks` guard, so a
turn that only launched a subagent and returned is not "finished". Any guess made from the TUI's
output would lose exactly that. The hooks are therefore registered whatever the notification
settings say — only the toast inside Stop is optional. Whatever sits in either directory at startup
is deleted *without* being reported: those turns ended before this window existed.

The state is `TerminalDescriptor.busy` and `finishedAt`, held per tab in the main process the way
`hasSession` is, so a closed tab takes it with it. `finishedAt` is a time rather than a flag,
because the project row's mark opens the oldest one first, and `setTurn` writes both at once —
ending a turn is exactly "stop spinning and leave the mark". Two halves keep it honest, and neither
can do the other's job:

- the **main process** sets it, and never asks whether it should — it cannot know what is on
  screen. A turn reported before any tab has claimed its session id is held in `pendingTurns` and
  applied by a later reconcile. It is held on a **timer** (`PENDING_TURN_TTL_MS`), not until it is
  missing from the session listing: `UserPromptSubmit` fires before Claude Code has written the
  transcript that listing reads, so dropping an id for being absent from it lost the spinner for
  the first turn of a brand new tab — which is why one session would spin and the next would not. A
  tab whose process stops or errors is cleared of `busy` there and then: a CLI killed mid-turn
  never reports its end, and the spinner would otherwise turn on a dead tab for the rest of the
  session.
- the **renderer** decides what is *shown* and clears what was seen (`terminals.seen`). The rule
  lives once, in `App.markedTabs`, and both views are handed its answer — two views applying it
  themselves would be two chances to disagree. Only the mark goes through that rule: `busy` is
  drawn wherever the tab is, on screen or not, because "this one is working" is worth seeing
  precisely while you are looking somewhere else.

That is why `App` holds every project's tabs, next to the repository states and for the same
reason: the project list needs all of them at once, while a `TerminalsPane` only ever knew its own.
A pane still owns its own selection and reports it up through `onActiveTab`.

Left deliberately unmarked: the tabs of saved commands (see the end of "Saved commands").

## Agent-specific vs shared code

Each agent gets a folder under `src/agents/` and is described by one `AgentDefinition`
(`src/agents/agent.ts`). The shared terminal layer never imports an agent's own code — it only
calls those callbacks, so a new agent is a new folder, one entry in `src/agents/index.ts` and one
case in `AgentIcon` (`src/renderer/components/agent-icons.tsx`). That last one is the only
agent-specific thing outside `src/agents/`, because that folder belongs to the main process: a
definition reaches `fs` and `child_process`, so hanging an icon off it would pull JSX into that
bundle and the agent's setup code into the renderer's.

- `executable`, `args`, `env`, `versionArgs` — how to start it, and how to tell "not installed"
  from a spawn that failed for another reason
- `askArgs` — one question, answered on stdout, no terminal (`claude -p`, `opencode run`). An agent
  without it is no candidate for anything that asks. A question asked in the background must not
  leave a session behind, or it comes back as a tab on the next start: Claude Code takes
  `--no-session-persistence`, and opencode — which has no such switch — titles the run and deletes
  it again in `cleanupAsk`
- `runArgs` — one command run *in* a terminal, ending when it does; saved commands are what use it,
  and only the shell has it
- `sessions` — listing, resume args, rename, delete, and an optional `watch`
- `prepareApp` — the one hook about no repository at all, run once before any project opens; what a
  run that was killed left behind is what it is for (see below)
- `prepareSpawn` — async setup that must finish before the first spawn, and the only place an agent
  may write anything. It is handed `AgentPaths`; a rejection marks the agent unstartable, so only
  reject for something that really makes it unusable (opencode's server does, a failed notification
  script does not). `AgentPaths.onSessionBusy` and `onSessionFinished` are the one thing an agent
  reports back out of band rather than through a return value — see "Both ends of a turn"
- `resolveUrlPrefix` — completes a url the agent's TUI wrapped across rows
- `createIsSessionReady` — the per-agent guess at "the CLI has drawn its first real frame", which
  drives the progress bar under the tab strip

### The one database under opencode's servers

Meezeek runs one `opencode serve` per repository, but a server opens the SQLite database of the
whole machine — every instance shares one `opencode.db` in the user's own data directory. Two
things follow, both paid for:

- **They come up one at a time** (`OpencodeServer.queue` in `server.ts`). Four repositories
  restored at startup booted four servers inside the same 40ms, and the one that lost that race
  exited with code 1 and `database is locked`, which reached the user as a spawn preparation that
  failed. Waiting for the previous server to report its url is enough — by then it is past the
  setup holding the write lock.
- **What a killed run left running is taken down before the first of them starts**
  (`server-registry.ts`). Every path that ends the app ends its servers too, but none of ours runs
  when the process is killed, and a server outliving its meezeek keeps writing to that same file.
  So each one is written into an `opencode-servers.json` in `userData`, and the next run kills what
  is in there — but **never by pid alone**: a pid is not an identity, the number is reused, and by
  the time it is read the process behind it may be anything. It is killed only once it has answered
  on its recorded url with its recorded password, which nothing but our own server can. One killed
  between being spawned and reporting its url is never recorded and stays behind; there is nothing
  left to recognise it by.

The cleanup is what `prepareApp` is for: `main.ts` calls `prepareAgents(userData)` before any
project opens, because opening one asks the agent for its session listing, and that alone starts a
server. Nothing waits on it out there — `OpencodeServer.start` holds the promise itself, since only
it knows which of its calls must not overtake it.

## Never touch the user's agent configuration

Everything meezeek generates lives under its own `userData` directory and is pointed at from
outside:

- Claude Code: a generated settings file passed as `--settings`, which the CLI layers on top of its
  own configuration. `~/.claude/settings.json` is never read, written or replaced.
- opencode: `OPENCODE_CONFIG_DIR` on the **server** process (under `attach` the TUI is only a
  client, the server is what loads plugins). It is additive — it does not replace the user's own
  `plugins/`. That directory is shared across repositories because opencode pays a minutes-long
  install the first time it sees an unfamiliar config dir, so each repository's generated plugin
  needs a unique filename *and* a runtime guard on `MEEZEEK_PROJECT_ROOT`, or every open
  repository's context gets appended to every message. Only write the file when its content
  actually changed; a changed plugin triggers a recompile.
- opencode again: `OPENCODE_TUI_CONFIG` on the **terminal** process, a generated file holding
  nothing but `"theme": "system"` (`tui-config.ts`). opencode otherwise draws in a palette of its
  own and the terminal ends up looking nothing like the window; `system` is its way of saying "take
  the terminal's colours", which are the `--vscode-*` ones xterm was handed. It is layered on top
  of the tui config opencode already loaded — the user's `tui.json` is untouched — and passed as a
  default, so a user who sets that variable themselves keeps their file.

## Files other processes read

The context file and the shell transcript are written by meezeek and read by a separate process —
an agent's prompt hook, or the agent's own file reads. Write beside the target and `rename` into
place, never in place: writing in place was measured against it and lost, and on Windows a read
that lands mid-write fails outright rather than returning partial data.

The one file that crosses the other way — Claude Code's Stop hook writing into `finished/` — sits
outside that rule, because it carries nothing: the *filename* is the whole message, so there is no
content a reader could catch half-written.

## Cross-platform requirement

Must work on Windows, Linux and macOS. Never add OS-specific behaviour without an equivalent for
the others.

- Build paths with `path.join`; route process spawning through `resolveCommand`
  (`src/main/pty.ts`).
- Generated `.ps1` files need a UTF-8 BOM — PowerShell 5.1 decodes BOM-less files as ANSI.
  Generated `sh` scripts must be LF, whatever the source file's line endings are.
- Anything written *into* a generated script has to be quoted the literal way: `@'...'@` and
  `'...'` in PowerShell, `'...'` in sh. A repository folder or a user name may hold a `$`, and in
  the interpolating forms (`@"..."@`, `"..."`) PowerShell reads `$name` as a variable and `$(...)`
  as a command to run — which is how a toast once printed half a repository's name and would have
  run whatever the other half said. `os-notify.ts` has the two helpers.
- Claude Code's hook shell on win32 varies (PowerShell, cmd.exe and Git Bash were all observed).
  Avoid shell builtins and nested quoting; invoke a plain exe, e.g.
  `powershell -NoProfile -ExecutionPolicy Bypass -File "<script>.ps1"`.

## The renderer

- Terminal output goes straight to xterm, never through React state. The instances live in
  `src/renderer/terminal-views.ts`, outside React, keyed by project *and* tab — tab ids are only
  unique within their project — so they survive tab and project switches untouched. It arrives
  batched: one message per 8ms flush carrying every terminal that produced something, rather than
  one per tab, so the message count stops growing with the number of open ones.
- A terminal that is merely hidden must keep its layout (`visibility`, not `display`) — xterm needs
  a laid-out element to measure itself. A whole pane may use `display: none`, but has to be refit
  when it comes back.
- **The element xterm mounts into is `.terminal-host`, never `.terminal`.** xterm gives its own
  element the class list `terminal xterm ...`, so a rule named for the plain word lands on both it
  and the container — the inset below was taken twice for months, which read as a doubled gutter on
  three sides and none on the fourth. Anything new in that subtree gets a name of its own; xterm's
  own classes are `xterm`, `xterm-viewport`, `xterm-screen` and `terminal`.
- A terminal sits 6px inside its pane on every side (`.terminal-stack`'s padding and
  `.terminal-host`'s matching inset — an absolutely positioned child is laid out against the
  padding box, so the padding alone does not move it). That gutter is terminal background like the
  rest, and the background lives on `.terminal-host` with `.xterm-viewport` forced transparent over
  it: xterm.css hardcodes that viewport to black, which showed through as a black gutter and as a
  black strip under the last row while a pane was dragged taller.
- A file dragged over a terminal frames the **pane** (`.terminal-host.drag-over`), so it is clear
  which of the mounted terminals would take the drop. It is a `::after` overlay whose inset negates
  `.terminal-host`'s, not a border: a border would shrink the box xterm measures, so every drag
  across a terminal would refit it and resize the pty. Only a drag carrying files raises it, which
  is also the only kind the drop handler acts on. A file dropped anywhere *else* is swallowed in
  `main.tsx`: unhandled, Electron navigates the window to it and the app is gone. Files only — text
  dragged into a field is a drop that field still has to receive.
- **Nothing in the lane at the terminal's right edge may be left to an xterm default, and CSS is
  not what settles it.** Two things are drawn there, both xterm's own elements and both redrawn as
  the buffer grows, so what decides how they look is the **color they are given in `theme.ts`** —
  `#00000000` for each, spelled as hex because it passes through xterm's color parser. The
  scrollbar: since xterm 6 it is not a native scrollbar at all but a copy of VS Code's scrollable
  element with a `<div class="slider">`, so the older rules in `styles.css` (`scrollbar-width`,
  `::-webkit-scrollbar`) never touched it; a TUI repaints its whole viewport, so one beside it
  would only twitch and the wheel is what scrolls. And the overview ruler, which the terminal asks
  for only to stop FitAddon reserving 14px for a scrollbar (`overviewRuler: { width: 1 }`) — xterm
  outlines it on every frame whether or not a mark is in it, and unset that outline is light: a
  white line beside every terminal.
- Resizing is two steps, debounced differently. `refitTerminal` follows the container immediately:
  it is local to xterm and only does anything on a whole row or column, so a dragged sash never
  leaves a strip of empty pane behind. `fitTerminal` also tells the pty, which makes the CLI
  repaint in full, and that one waits for the dragging to settle.
- `provideLinks` runs on **every render** while the pointer is over the terminal, and an agent TUI
  repaints constantly. Nothing expensive, and no logging, in that path.
- A terminal's xterm theme is built **per terminal**, not once for the window, because of one
  deliberate lie in it: opencode's TUI assigns blue and magenta the other way round from VS Code's
  terminal palette, so `buildXtermTheme` swaps the two for that agent alone. Observed rather than
  derived — so if opencode's colours ever look wrong the other way, this is what to take back out.
  It only does anything because of the `"theme": "system"` in `tui-config.ts`.
- Measurements are shared, not invented per view. A bar along an edge is 35px, the tab strip's
  height — the title bar, both sidebar headers (`.sidebar-header`) and the diff dialog's bar all
  use it. Same for the 22px action button, the 1px `--vscode-panel-border` between panes, and a
  pane sized in percent stating its floor in percent as well. When something looks like it needs a
  size of its own, check what the neighbouring view uses first.
- **An icon is one size everywhere, and it takes two numbers.** The box is `--icon-size`, 15px,
  everywhere — the one knob that resizes every icon in the window. The other number is how much of
  its grid a *path* covers, which ranged from 59% (the chevron) to 100% (Claude's mark): every icon
  declares the `extent` it was **measured** at, and `Svg` crops the viewBox so all of them cover
  `TARGET_EXTENT`, scaling `strokeWidth` by the same factor so one weight survives it. The extents
  are tuned to each icon's *geometric mean* rather than its longer side — normalising the long side
  alone leaves a 12×9 shape looking small beside a 12×12 one, which is what the branch icon, the
  sync arrows, the sparkle and Claude's mark were each reported for in turn. Verified at a mean of
  11.9–12.0px for every icon whose shape allows it; a chevron and a row of dots are capped rather
  than stretched. Neither number is optional: a shared box with unequal extents is what the app
  looked like for months, equal extents in three different boxes is what it looked like an hour
  later.
- Adding or redrawing an icon therefore means re-measuring it, not estimating: render it, read
  `getBBox()` on each child grown by half its stroke, and write that extent and centre down. The
  gear in the title bar is the one icon left out — it declares no extent and keeps its own
  proportions among the platform's caption glyphs.
- **State an icon's size in CSS; never rely on the `width`/`height` the shared `<Svg>` writes as
  attributes.** Those are a fallback a flex container is free to shrink: `.icon-button` is a
  `<button>`, the reset at the top of `styles.css` clears its border and background but not its
  padding, and Chrome's default `1px 6px` with `border-box` left 12px of content inside a 24px box
  — so *every* icon in *every* one of those buttons rendered at 12 by 18 for as long as the class
  had existed. `.icon-button` sets `padding: 0` now. It went unnoticed because a squashed icon
  still looks like an icon.
- **When two things that should look identical do not, measure them — do not read the code
  harder.** The above cost several rounds of reasoning about rules that were all correct. What
  found it in one step: rebuild a page with the *built* stylesheet and the real markup, serve it
  over http (`file://` is blocked for the browser tools), and read `getComputedStyle` for each
  element. Use the layout size, not `getBoundingClientRect`, on anything carrying `.spinning` — a
  rotated square reports a larger hull box than its own edge.
- The box *around* an icon counts as part of its size: the same glyph reads smaller inside a 24px
  `.icon-button` than standing bare in a row. An icon standing among buttons therefore takes that
  box as well, which is why the project row's spinner is an `.icon-button` itself.
- **Anything that marks or points at something is 1px in `--vscode-focusBorder`**: the drop
  indicator between two rows of the project and command lists, the active tab's underline, the
  frame around a terminal a file is held over, and the sash while it is dragged
  (`--vscode-sash-hoverBorder`, VS Code's own name for the same blue). A new one copies an existing
  rule instead of picking a width and a color of its own — two of them that differ read as two
  different meanings. The active git toggle's 2px accent is the exception, and it is VS Code's own.
  The same holds for a mark that is a *shape*: all four session marks sit under one `.session-mark`
  rule, and an icon that marks something is drawn to the square its neighbours occupy rather than
  to the full 2–14 box.
- **Icons and marks are monochrome**; the only colour any of them takes is that blue. The changes
  list's status letters are the one exception, and they are the theme's own answer:
  `gitDecoration-*` is what VS Code colours that exact list with. Which is the test for the next one
  — a colour is allowed where Dark Modern already names one for that meaning, and nowhere else.
- Colors come from `--vscode-*` variables only (`src/renderer/vscode-theme.css`). Add a new
  variable rather than hardcoding, and use the name VS Code uses. The one exception is the diff's
  syntax colors: Shiki assigns those per grammar scope, of which a theme has hundreds, and hands
  them back per token — so `src/renderer/diff-highlight.ts` writes them inline. Its `dark-plus` is
  the token half of the same theme the variables come from.
- Two hover colors, and they are not interchangeable. A *row* — a list item, a tree item, a tab, a
  section header — takes `--vscode-list-hoverBackground`. An *action button* takes the translucent
  `--vscode-toolbar-hoverBackground`, wherever it sits: on a row that is already hovered the list
  color would be invisible, and on a selected row it would be a grey patch on the blue. A selected
  row keeps its selection color while hovered.
- The renderer is one bundle with no code splitting, so every Shiki grammar in that file's list
  ships whether it is used or not. It is a list of what a repository plausibly holds, not all two
  hundred; an unlisted language shows as plain text. They are imported lazily, so an unopened one
  costs bundle size but no startup time.
- `.pane-hidden` is last in `styles.css` on purpose: it has to override the `display` the panes it
  hides set on themselves, and they are all single-class selectors too.

## npm scripts

- `npm run compile` — bundle main, preload and renderer
- `npm run typecheck`
- `npm run lint`
- `npm start` — typecheck, compile, then launch (see "Do not restart the app yourself" before
  running this). The typecheck is in there because esbuild only bundles: an identifier nobody
  imported is a global to it, so it drops the unused export and the app dies on load with a
  `ReferenceError` a `tsc` run would have named at the import.
