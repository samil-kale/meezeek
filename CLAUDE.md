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
meezeek ports its `shared/`; its `CLAUDE.md` records *why* — read it before changing any of them:

- session listing, resume, rename, delete, and the reconcile loop adopting a session id a CLI has
  only just persisted (`src/agents/*/sessions.ts`, `src/main/session-manager.ts`)
- how each agent is driven: Claude Code is a plain CLI reading `<uuid>.jsonl` transcripts off disk;
  opencode is client/server and **everything** goes through the one server meezeek runs
  (`src/agents/opencode/server.ts`) — never its CLI or its SQLite file
- `extractTitle`'s precedence rules for Claude Code session titles — a regression there silently
  shows the wrong tab title with nothing to catch it
- the modifier-gated terminal link providers (`src/renderer/links/`)
- OS notifications and the `background_tasks` stop guard (`src/main/os-notify.ts`,
  `src/agents/claude/hooks.ts`)
- the `--vscode-*` theming layer

Not ported: the VS Code editor context (meezeek has no editor) and the diagnostic quick fix. What
survives is the shell transcript in `src/main/shell-context.ts` — a capped file the agent is pointed
at, not an excerpt inlined into every prompt.

**GitHub Desktop** is the reference for the git half — Electron + TypeScript, so its repository
models and git paths translate directly; crib the shapes, not the scope. **VS Code** is the UI
reference (tab semantics, close actions, theme names, the sash) — the **classic** layout and Dark
Modern's palette, not the pill-shaped Modern UI. Not adopted yet: **Monaco** for a richer diff,
**Octokit**/**GitBeaker** for the providers.

## The layout

- projects live in the left sidebar; the tab strip is one project's terminals only
- git is **not** a tab. The strip's `.git-toggle` slides out a pane between navigation and
  terminals — branches over changed files, nothing else — and stays out until pressed again
  (`usePaneToggle`, remembered like a pane size), so a terminal and the repository stay on screen
  together
- one git pane for all projects; unlike terminals, it holds nothing a project loses by switching
  away
- the diff is a **dialog** over the whole window, opened by double-clicking a changed file or
  ctrl-clicking a path in a terminal. `DiffDialog` and `SettingsDialog` are deliberately not part
  of `Dialog.tsx`: that file is for questions, built around a form with two buttons
- git commands go in an ordinary terminal tab, not a console of the pane's own
- the branch bar is the window's bottom strip
- panes between all of that are draggable (`src/renderer/components/Sash.tsx`)

## Nothing starts without git and an agent

`src/main/requirements.ts` checks both before anything opens: git via `git.isAvailable()`, and
every agent with `versionArgs` — the shell has none, keeping it out. The renderer asks
(`startup:check`), and passing is what starts the app: `main.ts` doesn't open stored projects when
ready, `openWorkspace` does, from that handler. A machine missing something watches no repository
and spawns no terminal — `Startup` shows `RequirementsDialog` instead of mounting `App`.

The `--version` result is remembered (`isAgentInstalled`): install status is a machine fact, so
each project's runtime doesn't re-spawn every agent's check on open — on win32 through `cmd.exe`,
two processes each. Only the dialog's own re-check always spawns.

The dialog is a wall, not a question — no Escape — and **it installs nothing**: no command works on
all three platforms, most need elevation or a shell, and a program installed while the dialog
stands is still missing from this process's PATH — only a restart picks that up, and the dialog
says so.

On a machine with everything installed the dialog is unreachable, so `--simulate` names commands to
report missing anyway: `npm start -- --simulate=git,claude`.

## Git

Git is never reimplemented. `src/main/git.ts` wraps the local CLI: `git()` resolves for *any* exit
code — callers decide what it means — and rejects only if git itself couldn't start. Never run git
from the renderer.

All of `git.ts` runs in its own `utilityProcess` (`git-host.ts`), reached from the main process
through `git-client.ts` — a proxy whose properties are the module's own functions, so
`git.readState(path)` reads like the import it replaced. Two rules: nothing may import electron (a
plain node process), and everything crossing the boundary must survive a structured clone — hence
an image as a data URL and an error as its message.

The split adds a call that can *reject*: a failed command is in the return value, but a git process
that *dies* takes every in-flight call with it. `Repository` catches that at each entry point and
turns it into the shape callers already handle — an error in the state, `ok: false`, an empty list.
The client restarts the process on the next call.

`Repository` (`src/main/repository.ts`) is the single source of truth for both the git pane and the
terminals, so a branch switched in a terminal shows up in the UI on its own. It watches the working
directory, debounces and throttles bursts, and only emits when state actually changed — the watcher
fires for plenty of no-op edits. Diffs load on file selection, never up front.

**Everything the git pane can do fits in a context menu, an icon button or a question.** That
limits the *views*, not git: a command needing a checkbox list, a message field, or conflict
resolution is one the pane doesn't offer. Of what fits, we take GitHub Desktop's set — today the
branch tree (branches, remotes, tags, stashes) with per-ref menus, checkout, status, per-file diff,
discard, `.gitignore`, fetch/pull/push, and cloning from the add-repository dialog. Cloning brought
GitHub and GitLab with it, behind one `GitProvider` interface (authenticate, list repositories,
resolve a clone URL) under `src/providers/`. Providers stay out of the local git layer — once
cloned, everything goes back through the CLI.

Every action goes through `Repository.runAction`, one at a time per repository, refreshing after —
two actions would race for the same index lock. Discarding and ignoring go through it too, since a
discard context menu doesn't know a fetch is running and `git restore` wants the same lock. The
renderer mirrors this in `App`'s `branchAction`: one project's tree stops offering actions while one
runs, and `BranchBar` says what's happening instead of naming HEAD. `BranchActions.run` is the one
way in — a view asks its own question first (it knows the remote, the branch, the file count), then
hands over a label and the call.

Two things the tree needs cost no extra git process. `readRefs` asks `for-each-ref` for `%(symref)`
alongside the name, empty except for `<remote>/HEAD` — that's `defaultBranch`, and "Update from..."
merges its *remote-tracking* copy, since auto-fetch keeps that current while local `main` may lag;
tags are one more argument to the same call. `state.operation` — the merge/rebase git stopped
mid-way, which "Abort" needs — is three `stat` calls in the git directory.

A remote's url is read once on project open and again after this app changes one
(`Repository.loadRemoteUrls`), then merged into every emitted state: it changes about never, so the
refresh path spends its processes elsewhere.

The project row carries repository-wide entries (open in terminal, show in file manager, copy path,
view on host, change remote url, close) — nothing touches the working tree there; those actions
live in the git pane, where their target is on screen. "Open in terminal" is a shell tab in this
window, created and brought to front like any other.

### Talking to a remote

Every command reaching a remote — fetch, pull, push, force push, deleting a branch/tag remotely,
pushing a tag — runs with `NETWORK_ENV`, all aimed at stopping git from asking a question:
`GIT_TERMINAL_PROMPT=0`, an empty `GIT_ASKPASS` (unset, git falls back to the terminal the other var
avoids), and `ssh -oBatchMode=yes`. There's no console to answer in, and a command waiting for an
answer that can't come holds the repository's one action slot open indefinitely. Credentials come
from the user's credential helper or a provider token, or not at all — meezeek writes nothing into
that machine-wide helper.

`LC_ALL=C` pins git's own messages so `runNetwork` can match two of them (`could not read Username`,
`Authentication failed`) into `authRequired` — there's no exit code for it, every fatal clone error
is 128, and an unpinned `LANG=de_DE` machine would answer in German and match nothing. A repository
git can't find stays out of that list on purpose: GitHub/GitLab answer 404 for both a private repo
and a typo, so credentials would be a guess.

`authRequired` is what the add-repository dialog's clone acts on: the clone runs with no
credentials, and only when it comes back short does `CloneAuth` appear — accounts for *this host* on
one side of a switch, a token on the other, never both. A typed token is validated and stored as an
account on the way through. An ssh url never gets there, since a missing key fails with a message
none of the patterns match — the truth, as no token would have helped.

Ahead/behind are read from the `git status --branch` header a refresh already asks for
(`main...origin/main [ahead 1, behind 2]`), not a separate `rev-list`. `[gone]` counts as no
upstream.

Each repository also fetches by itself every ten minutes (GitHub Desktop's interval), **silently**
on failure — a remote with no credentials entered would otherwise notice six times an hour for
something nobody asked. A fetch the user pressed a button for reports like anything else.

The branch bar's one button follows GitHub Desktop: publish a branch the remote's never seen, then
pull what came in, then push what went out, then fetch when the two agree. Right-clicking opens the
rest — fetch, pull, pull with rebase, push, force push. Force push is `--force-with-lease`, refusing
rather than dropping commits the remote picked up since the last fetch — the one entry that asks
before it runs.

### The diff

A diff is read with `-w`, synthesised for an untracked file (git has nothing to compare). The view
reads its own file for shown lines on demand. A hunk header with a non-empty gap above it gets an
unfold button; opening it asks `repo:file-lines` for exactly those lines — context lines are
identical in both versions, so the working tree is the only source and git isn't run again. The end
of a file is never a gap, since nothing in a diff says how far past the last hunk it goes. Opening a
gap rebuilds the `FileDiff` the view renders, so Shiki colors the new lines with the rest.

An image is not "Binary file." — `readDiff` recognises it by extension and hands both versions to
the renderer as data URLs; the committed one goes through `git show HEAD:<path>` read as a *buffer*,
since utf8 would mangle every byte. SVG stays out of that list: git diffs it as the text it is.

### Where we follow GitHub Desktop rather than git's default

- Discarding is not `git checkout --`: a file HEAD doesn't know is moved to the trash
  (`shell.trashItem`), not deleted, so it stays recoverable. `git restore --source=HEAD --staged
  --worktree` covers everything else, index and worktree in one command; a rename needs both paths
  since only the old one is in HEAD.
- Deleting a branch is `git branch -D`. `-d` would refuse an unmerged feature branch with a message
  this pane doesn't show; the risk is what the question says out loud instead.
- A `stash@{n}` is a position, not an identity: dropping one renumbers the rest, so nothing holds a
  ref across a refresh. Rows act on the last refresh's report, and all three stash commands refresh
  after themselves.

### What the git view deliberately does not do

Built at some point and taken back out, so don't re-add without being asked: a commit UI with
per-file/per-line staging; history, graph, cherry-pick, revert, squash, reorder; bisect, submodules;
conflict resolution beyond aborting; side-by-side diff; discarding single lines. A git command
needing a list, a message or a per-line decision is exactly what an agent should be asked to do,
where the answer, the conflict and the fix are all visible.

PRs and CI status are still open. Provider accounts aren't a login of the pane's either — they live
in the add-repository dialog, the one place talking to a host rather than a repository.

### Keep git off the main process, and count its invocations

Each of these was paid for once and measured; the numbers are in the comment at each site.

- Git stays in its own process — added to the main process it puts typing lag back one command at a
  time, since that process also relays pty output and has to stay responsive.
- Starting git is what costs, so count *invocations*. `readState` gets by with two (`git status
  --branch` reports branch and changes; only detached HEAD needs a third); anything added to the
  refresh path has to earn its process — `readStashes` is the third one a refresh spends.
- A refresh finding events waiting goes back through `scheduleRefresh` rather than re-running at
  once — the immediate path bypassed the debounce and turned a busy working tree into an unbroken
  chain of git processes.
- `readStatus` runs `git --no-optional-locks status`: without it, writing the index back is itself a
  filesystem event that schedules the refresh that writes it again. Don't fix that with another
  entry in `isIgnoredEvent`.
- `src/main/event-loop-monitor.ts` runs every session, writing stalls to `event-loop.log` in
  `userData` only — the app is usually started from a shortcut, where a console line goes nowhere.
  Not behind a switch on purpose, so a stall is noticed while working rather than while looking for
  it. The file is rewritten at every start.

## Saved commands

The sidebar's lower half is a project's saved shell commands, living under a `commands` key in a
`meezeek.json` in the repository's own root (`src/main/commands.ts`), not meezeek's `userData` —
they describe the project, so they travel and can be committed, which also means the file shows up
as untracked until someone commits or ignores it. The key was `actions` before a rename; nothing
reads that spelling now, so such a file looks unconfigured and the wand fills it again.

A saved command is a command line plus, where not obvious, a `name`, a `cwd` and an `env` — a plain
string when none of those is needed, an object once one is (`{"command": "npm run build", "cwd":
"web"}`). `name` is a label only: the row shows it *instead of* the command line, a tooltip away.
The command is what you'd type standing in that folder — `npm run build`, not `npm run build
--prefix web`.

`env` exists because no syntax writes a variable *into* a command that works everywhere:
`PROFILE=DEVELOPMENT java -jar target/app.jar` is POSIX PowerShell reads as a command name, and
`java -jar` has no flag for it either. So it's a field set on the process (`SpawnOptions
.envOverride`), and it outranks the machine's inherited environment — the one case where the user's
own default loses, because they wrote it next to the command.

The `+` dialog asks for all of them; "Edit..." is the same dialog pre-filled. It doesn't ask about
`shell`, which is carried over rather than dropped — editing must not quietly change how a command
starts. The environment field is written the way you'd type it (`PROFILE=DEVELOPMENT PORT=8080`),
and `parseEnv`/`formatEnv` read/write it with the same `splitCommand` the command goes through, so
`NAME="a b"` means the same everywhere — why both live in `src/shared/`. `prompt` carries the
optional fields as `extras`; `name` is one of them even though `valueIndex` places it above the
command, since only the answer's own field can hold the dialog back.

**Running one opens a terminal tab for it.** The tab's *process is the command*, in its own
directory, ending when the command does — nothing buffered or summarised, which is what a build
needs. The tab is labelled with the command, and closing it kills the process like any other
terminal.

**There is no shell in between.** `splitCommand` reads the saved line as a program plus arguments,
started directly — the same on every machine, and why `env` is a field: with no shell to interpret
anything, a pipe, redirection, `&&`, `$(...)` and `$VAR` don't work, on either platform. Quotes
group one argument and are dropped; a backslash is literal, since a Windows path is full of them.
Where the line goes on Windows is `resolveCommand`'s call (`src/main/pty.ts`): a native `.exe`
starts as itself, a `.cmd` shim (`mvn`, `npm`) goes through `cmd.exe`, and a spaced argument survives
both (measured, not assumed).

An operator surviving the split as its own word (`&&`, `|`, `>`, ...) is refused with a notice
naming it, rather than passed to the program — `rm x && y` would ask `rm` to delete two files called
`&&` and `y`. Such a line comes from a file written for a shell, so it must fail loudly. The way out
is `"shell": true`, handing the line to `AgentDefinition.runArgs` — the same shell project shell tabs
use, `-NoProfile -Command` on win32, `-c` elsewhere. That entry then only works where it was
written, which is why the wand's prompt deliberately omits it: what an agent writes into a
repository should run everywhere.

Either way `createCommandTab` is `createTab` with a program, arguments, a directory and an
environment, so a saved command's terminal shares the lazy spawn, output batching and close path of
every other tab.

A tab opened from outside the terminals pane — a saved command's, or a project row's shell — is
brought to front through `openedTabId`, applied once per tab id and then remembered. Not on every
render: the tab list changes on every status update, and re-applying a selection would drag the
user back out of whatever they moved to.

Because a saved command's process ends every run, `TerminalSession` tells the two apart by exit
code: `stopped` for a clean one (or anything meezeek killed), `error` only for a process that failed
on its own. **Nothing draws the difference yet** — the tab strip marks both `.terminal-tab.inactive`.
Worth doing, deliberately still open — don't invent the look.

Reading a `meezeek.json` that's missing, unparseable or oddly shaped is simply no commands — it's
the user's file, and half of it being someone else's isn't a reason to throw. A project with no
`meezeek.json` **at all** gets its commands looked up straight away, unasked — nobody's set it up
here. So `readCommands` returns `null` for a missing file and `[]` for one that's empty on purpose —
a list someone emptied stays empty. Runs at most once per project per session, guarded by a ref.

The array's order is the screen order — no separate field, since two records of the same thing
drift apart. Rows reorder by dragging, like the project list, through `useDragReorder`
(`src/renderer/components/drag-reorder.ts`), which also holds the drag details (own MIME type per
list, insertion index off the event, the strip below the last row). The wand slots new entries in
behind the last command running the same tool (`mergeCommands`); a drag outranks that, since it only
decides where something *new* lands.

The wand beside `+` asks an agent to fill the list — the first installed one with `askArgs` (claude,
then opencode), given `SUGGEST_PROMPT`. That prompt is deliberately concrete about where commands
hide, since a model told only "find the commands" answers with what it'd type in a generic project
of that kind. It also asks for the *start* command, the one nobody writes down. The reply is
expected as a JSON array, read as the first bracketed run in it, since "answer with nothing but"
still tends to arrive fenced. No cap on how many come back, but the prompt asks for judgement — the
commands a developer types, not the lifecycle hooks and CI scripts a `package.json` is half full of
— and that has to stay unambiguous: saying "prefer what's run by hand" and "list all of them" at
once let a model pick either. What comes back is added without review — a wrong entry is one
right-click from deletion.

One `CommandList` serves every project, so anything it starts must name the project it asked about
— the wand can run for minutes, and its answer belongs to that project, not whichever is on screen
when it returns. Projects being looked up are kept as a set; the result only shows if that project
is still the one on screen.

## Settings

One dialog for everything meezeek keeps about *itself* rather than a repository — the one button in
the window belonging to neither a project nor a pane. It sits at the title bar's end, reading as a
platform window control: **not** an `.icon-button` but a 46px box the bar's full height, without the
3px radius buttons elsewhere have — VS Code's own measurement, what the overlay reserves per
control. It stops at `.titlebar`'s `padding-right`, read off the Window Controls Overlay env vars
(`env(titlebar-area-width)`), standing against minimize on Windows/Linux; macOS publishes no such
vars and puts its controls left, so the fallback keeps it at the right edge.

It asks nothing — a switch applies the moment it's flipped, like VS Code's own settings — so one
button closes it. Tabbed (Notifications, then Info) with the add-repository dialog's own strip
(`.dialog-tabs`), which is why neither dialog has a `.dialog-title`: the selected tab names what's
under it. Height is fixed to the fuller tab so switching doesn't resize under the pointer. Info
reads `app:info` once, on open.

Values live in a `settings.json` in meezeek's `userData` (`src/main/settings.ts`), written whole
from memory and read back defensively — a wrong-typed key falls back to its default rather than
reaching an agent as `undefined`.

**A setting reaches an agent through `AgentPaths`**, handed over rather than imported, so the
persisted copy stays the only one. Read in `pathsFor`, i.e. at `prepareSpawn` — the honest limit of
a switch: Claude Code reads its generated `--settings` file at startup, opencode's notifier is built
around the event stream when its server comes up, so an agent gets its notification setup once and
can't be reached afterwards. A change applies to what starts after it, and the dialog says so.

Deliberately not in there: marks on a tab that finished out of sight or is waiting on an answer.
Neither is a notification to turn off, but how such a session is found again (see that section).

## Everything the user is told is a notice

`notify(severity, message)` from `src/renderer/components/Notices.tsx` is the only way to say
something to the user — no exceptions, no view keeps a message of its own, nothing written into the
pane where it happens. A plain function, not a prop or hook — modelled on VS Code's
`window.showErrorMessage` — so anything that fails reports without a threaded callback. The main
process uses the same channel: `app:notice` carries a `Notice`, handed straight to `notify`.

`error` and `warning` stay until clicked away; only `info` disappears on its own. An identical
message already standing is dropped, not stacked. They sit over the window's bottom right corner
rather than the column with everything else — arriving must not resize panes underneath — and only
the messages themselves take the pointer.

Not a notice: a status — a tab colored for an uninstalled agent, the progress bar, the branch bar's
name. Those are conditions a view draws for as long as they hold.

Nor a *question*. `src/renderer/components/Dialog.tsx` puts both kinds, built like `notify`: a plain
function anything can call, with one `Dialogs` next to `Notices` drawing whatever's pending.
`confirm` resolves to whether the user went through, and whether the one optional checkbox was
ticked. `prompt` resolves to a name or null — renaming a session goes through it, focus landing
selected in its field. One question at a time; the overlay blocks a second. Naming something inline
was tried and reverted: a tab's too narrow for a name, and a field committing on blur loses what was
typed to a stray click.

The main process asks nothing — `repo:delete-branch` and `repo:discard` just do it; the question
lives in the view offering the action, which knows the remote or the file count. Electron's native
`dialog.showMessageBox` isn't used: it looks like the OS in an app that otherwise looks like VS
Code.

Only ask before something irreversible. A question always answered the same way isn't worth asking.

## One progress indicator

Exactly one: the indeterminate bar under the tab strip (`.tab-progress` in `TerminalsPane`), shared
by everything slow in a project — an agent still starting, a branch checking out, a diff being read
or coloured. Never add a second — a new slow operation is a new condition in that one render. The
git pane and diff dialog sit outside it and report through `App`, which hands the active project's
bar what they say. Since the bar reports it, no view writes its own "Loading..." — the diff pane
just goes empty while reading one.

**A spinner in place of an icon is not a second one of these.** The bar is about the project; a
spinner is about the one thing the icon already stands for. `SpinnerIcon` with the `spinning` class
takes that icon's place, never a slot beside it — two cases: the wand while asking an agent (`.busy`
keeps disabled-dimming off it, since it's disabled for being underway, not idle), and a tab's agent
icon while its session works a turn (`TerminalDescriptor.busy`). The project row is the one place a
spinner stands alone, having no icon to replace.

## Both ends of a turn

A session says whether it's *working*, *stopped for an answer*, or *finished out of sight* — one
mechanism read at three points of the same turn, drawn both on the tab and its project's row, so a
project off-screen still shows what its sessions are doing:

- **working**: a spinner, for as long as the turn runs.
- **waiting on you**: a question mark. The turn's open but nothing's moving — a permission prompt,
  an elicitation, or an `AskUserQuestion`. Clears the moment the tab's in front of the user, and —
  like the bubble — is a condition, not a notice.
- **finished out of sight**: a speech bubble. One shape for one thing — a sidebar bell was tried and
  reverted, since two glyphs for the same condition read as two conditions. Goes away when the tab's
  in front of the user; deliberately not a notice, since a notice is one-off and this holds until
  answered.

In the project row all three are buttons stepping through their sessions one press at a time. Two of
them empty their list as they go, since a seen session stops being marked; a watched session keeps
working, so the spinner instead keeps a cursor per project (`App.busyCursor`, a ref — changes what
the next press does, not what's shown) and wraps around.

**On a tab all three take the agent icon's place** rather than a slot of their own — the tab is only
as wide as its label. One slot means a ranking: **waiting > working > finished** — a session stopped
on a question is precisely *not* working, the more useful of the two truths, and working outranks
finished because a newer turn's mark still shows once it stops. In the sidebar, with no icon to
replace, all three sit next to each other left of the close button. All are `--vscode-focusBorder`
under one `.session-mark` rule — three states of one thing must not read as three kinds of thing.

**Whether a question is *shown* is decided in `App`**, beside the bubble's rule (`waitingTabs` next
to `markedTabs`) and for the same reason — the main process holds the state but not which tab is on
screen, and two views applying the rule themselves would be two chances to disagree.

**Nothing here is read off the terminal.** Each agent knows when its own turn starts, stalls and
ends, and `AgentPaths.onSessionBusy` / `onSessionWaiting` / `onSessionFinished` say so:

- opencode reports `session.status` (`busy`, then `session.idle`) on the event stream meezeek's
  already subscribed to; `subscribe` carries `properties.sessionID` and `properties.status.type`
  alongside the event's `type`, verified against the binary's own `session.idle` schema, its
  `SessionStatus` union, and its `{type, properties}` envelope. A question is `permission.asked` /
  `question.asked` on the same stream; `session.error` shares their toast but not the mark, since an
  error happened rather than a question standing open. Those plus `session.*` (for the listing's
  watch) are the only types read — a frame naming none of them is dropped on a string test before
  parsing (`CONSUMED_EVENT_TYPE`), since most of the stream is a streaming answer's
  `message.part.updated`, and parsing every one was main-process CPU spent while the ptys wait.
- Claude Code's hooks are separate processes that can't call back into meezeek, so each point
  `touch`es an empty file named after the session id: `UserPromptSubmit` into `<agentDir>/busy/`,
  `Stop` into `<agentDir>/finished/`, and `Notification` (`permission_prompt|elicitation_dialog`)
  plus `PreToolUse` (`AskUserQuestion`) into `<agentDir>/waiting/` — `watchMarkers` picks them up
  (both halves in `hooks.ts`, either side of `markerDir`). The busy hook shares `UserPromptSubmit`
  with the command printing the context file, so it must stay **silent** — anything it writes gets
  appended to the prompt — and must exit 0 regardless, since a failing hook there can hold the
  prompt back. `AskUserQuestion` needs its own hook since it's a *tool*, not a Notification event;
  `idle_prompt` is deliberately not matched, since it fires after a turn ends, which the bubble
  already covers.

**There is no "answered" signal from either agent** — buying one would cost a hook process per tool
call — so a question clears on exactly two things: the tab being looked at (`markSeen`, alongside
the bubble), or either end of a turn (`setTurn`, since a question can only stand open *within* a
turn). A permission granted mid-turn leaves the mark until the tab is in front of the user — the
same contract the bubble has, cleared in one place for the same reason.

`watchMarkers` sweeps its directory on a timer **as well as** watching it: on win32 `fs.watch` can
silently miss a new file, stranding that turn's spinner forever (observed: a marker sat in
`finished/` long after being written, watcher healthy the whole time). The sweep costs nothing in
the git section's terms — a `readdir` on an empty directory is a syscall, not a process.

**Claude Code runs no Stop hook for a turn the user cut short**, so that end never reaches
`finished/` — an escaped prompt or rejected tool call left the spinner running until the next turn
ended. Confirmed in the transcript: a completed turn has a `stop_hook_summary` naming
`stop-guard.ps1`, an interrupted one has none, and no hook event covers an interrupt. The net is the
transcript itself, which records a `system`/`turn_duration` entry at *every* turn end — the session
listing reports it as `AgentSessionInfo.turnEndedAt`, from the same tail scan `custom-title` already
needs, and `reconcile` is the one place it's read. It only ever *ends* a turn still believed
running, and only when newer than the busy that started it. It leaves no mark: reaching us this way
means the user cut it short in that tab.

Reusing the Stop hook is the point: it already carries the `background_tasks` guard, so a turn that
only launched a subagent and returned isn't "finished" — a guess from the TUI's output would lose
exactly that. The hooks register regardless of notification settings; only their toast is optional,
same for the two marking a question. Anything sitting in the directories at startup is deleted
*without* being reported — those turns ended before this window existed.

State lives as `TerminalDescriptor.busy`, `waitingAt` and `finishedAt`, per tab in the main process
like `hasSession`, so a closed tab takes it along. `finishedAt` is a time, not a flag, since the
project row's mark opens the oldest one first, and `setTurn` writes both at once — ending a turn is
exactly "stop spinning, leave the mark." Two halves keep it honest:

- the **main process** sets it, never asking whether it should, since it can't know what's on
  screen. A turn reported before any tab has claimed its session id is held in `pendingTurns` and
  applied on a later reconcile — on a **timer** (`PENDING_TURN_TTL_MS`), not until missing from the
  session listing, since `UserPromptSubmit` fires before Claude Code writes the transcript that
  listing reads; dropping on absence lost the spinner for a new tab's first turn. A tab whose
  process stops or errors is cleared of `busy` immediately, since a killed CLI never reports its own
  end.
- the **renderer** decides what's *shown* and clears what was seen (`terminals.seen`), the rule
  living once in `App.markedTabs` so two views can't disagree. Only the mark follows that rule —
  `busy` draws wherever the tab is, on screen or not, since "this one is working" matters precisely
  while you're looking elsewhere.

`App` holds every project's tabs for the same reason it holds repository states: the project list
needs all of them at once, while a `TerminalsPane` only knows its own. A pane still owns its
selection, reported up through `onActiveTab`.

Left deliberately unmarked: saved-command tabs (see "Saved commands").

## Agent-specific vs shared code

Each agent gets a folder under `src/agents/`, described by one `AgentDefinition`
(`src/agents/agent.ts`). The shared terminal layer never imports an agent's own code, only calls its
callbacks — a new agent is a new folder, one entry in `src/agents/index.ts`, one case in `AgentIcon`
(`src/renderer/components/agent-icons.tsx`). That last is the only agent-specific thing outside
`src/agents/`, since that folder belongs to the main process — a definition reaches `fs` and
`child_process`, and an icon there would pull JSX into that bundle and setup code into the
renderer's.

- `executable`, `args`, `env`, `versionArgs` — how to start it, and how to tell "not installed" from
  a spawn that failed for another reason
- `askArgs` — one question, answered on stdout, no terminal (`claude -p`, `opencode run`); an agent
  without it is no candidate for anything that asks. A background question mustn't leave a session
  behind, or it returns as a tab next start: Claude Code takes `--no-session-persistence`, opencode
  titles the run and deletes it in `cleanupAsk`
- `runArgs` — one command run *in* a terminal, ending when it does; saved commands use it, only the
  shell has it
- `sessions` — listing, resume args, rename, delete, optional `watch`
- `prepareApp` — the one hook about no repository at all, run once before any project opens; for
  what a killed run left behind (see below)
- `prepareSpawn` — async setup finishing before the first spawn, the only place an agent may write
  anything. Handed `AgentPaths`; a rejection marks the agent unstartable, so only reject for what
  truly makes it unusable (opencode's server, not a failed notification script).
  `AgentPaths.onSessionBusy`/`onSessionFinished` are the one thing reported back out of band — see
  "Both ends of a turn"
- `resolveUrlPrefix` — completes a url the agent's TUI wrapped across rows
- `createIsSessionReady` — the per-agent guess at "the CLI drew its first real frame," driving the
  progress bar

### The one database under opencode's servers

Meezeek runs one `opencode serve` per repository, but a server opens the SQLite database of the
whole machine — every instance shares one `opencode.db`. Two consequences, both paid for:

- **They come up one at a time** (`OpencodeServer.queue` in `server.ts`): four repositories restored
  at startup once booted four servers in parallel, and the one that lost the race for the write lock
  died with `database is locked`. Waiting for the previous server's url is enough — by then it's past
  the setup that holds the lock.
- **What a killed run left running is taken down before the first of them starts**
  (`server-registry.ts`). Every path ending the app ends its servers too, but a killed process
  doesn't, and a server outliving its meezeek keeps writing to that same file. So each server is
  recorded in an `opencode-servers.json` in `userData`, and the next run kills what's there — but
  **never by pid alone**: pids are reused and by read time may be anything. Killed only once it
  answers on its recorded url with its recorded password, which only our own server can. One killed
  between spawn and reporting its url is never recorded and stays behind — nothing left to
  recognise it by.

The cleanup is what `prepareApp` is for: `main.ts` calls `prepareAgents(userData)` before any
project opens, since opening one asks the agent for its session listing, which alone starts a
server. Nothing out there waits on it — `OpencodeServer.start` holds the promise itself, since only
it knows which calls mustn't overtake it.

## Never touch the user's agent configuration

Everything meezeek generates lives under its own `userData` and is pointed at from outside:

- Claude Code: a generated settings file passed as `--settings`, layered by the CLI on top of its
  own config. `~/.claude/settings.json` is never read, written or replaced.
- opencode: `OPENCODE_CONFIG_DIR` on the **server** process (under `attach` the TUI is only a
  client). Additive — doesn't replace the user's own `plugins/`. Shared across repositories, since
  opencode pays a minutes-long install on an unfamiliar config dir; each repository's generated
  plugin needs a unique filename *and* a runtime guard on `MEEZEEK_PROJECT_ROOT`, or every open
  repository's context gets appended to every message. Only written when content changes, since a
  changed plugin triggers a recompile.
- opencode again: `OPENCODE_TUI_CONFIG` on the **terminal** process, generated with nothing but
  `"theme": "system"` (`tui-config.ts`) — opencode otherwise draws its own palette and looks nothing
  like the window; `system` takes the terminal's colours, the `--vscode-*` ones xterm was handed.
  Layered on top of the tui config opencode already loaded, so a user with that variable set keeps
  their own file.

## Files other processes read

The context file and shell transcript are written by meezeek and read by a separate process — an
agent's prompt hook, or the agent's own file reads. Write beside the target and `rename` into place,
never in place — measured against writing in place and lost; on Windows a read landing mid-write
fails outright rather than returning partial data.

The one file crossing the other way — Claude Code's Stop hook writing into `finished/` — sits
outside that rule, since it carries nothing: the *filename* is the whole message, nothing a reader
could catch half-written.

## Cross-platform requirement

Must work on Windows, Linux and macOS. Never add OS-specific behaviour without an equivalent for the
others.

- Build paths with `path.join`; route process spawning through `resolveCommand` (`src/main/pty.ts`).
- Generated `.ps1` files need a UTF-8 BOM — PowerShell 5.1 decodes BOM-less files as ANSI. Generated
  `sh` scripts must be LF, whatever the source's line endings.
- Anything written *into* a generated script needs literal quoting: `@'...'@` and `'...'` in
  PowerShell, `'...'` in sh. A repo folder or user name may hold a `$`, and the interpolating forms
  (`@"..."@`, `"..."`) read `$name` as a variable and `$(...)` as a command — which once printed
  half a repository's name in a toast and would have run whatever the other half said.
  `os-notify.ts` has the two helpers.
- Claude Code's hook shell on win32 varies (PowerShell, cmd.exe, Git Bash all observed). Avoid shell
  builtins and nested quoting; invoke a plain exe, e.g. `powershell -NoProfile -ExecutionPolicy
  Bypass -File "<script>.ps1"`.

## The keyboard belongs to the terminal

A terminal tab holds a foreign program owning every key while focused, and meezeek's handler runs
*before* xterm encodes anything (`attachCustomKeyEventHandler` in `terminal-views.ts`) — the window
can take any combination, so whether it can is never the question. **It takes nothing an agent could
have received**, decided by reading xterm's own `Keyboard.ts` rather than assuming:
`evaluateKeyboardEvent`'s ctrl branch requires `!shiftKey`, so `Ctrl+<letter>` is the agent's control
byte (`Ctrl+G` is `\x07`) but `Ctrl+Shift+<letter>` falls through every branch and sends nothing —
the opposite of what "xterm drops the shift" would suggest, why this got read rather than guessed
twice. `Alt+1…9` is out (`ESC 1`, readline's digit argument), so is `Ctrl+Tab`/`Ctrl+Shift+Tab`:
keyCode 9's case never looks at `ctrlKey`, so both are byte-identical to plain Tab/Shift+Tab — the
latter is Claude Code's own mode toggle. `Ctrl+,` and `Ctrl+Shift+.`/`Ctrl+Shift+,` are open: none of
those keycodes appear in any branch, modified or not. Shift+Enter and Ctrl+V are handled *for* the
terminal, not taken from it. None of the six window shortcuts close a tab — behind that key is a
live agent session that doesn't come back. They live in `src/renderer/shortcuts.ts`, the one list
both the capture-phase listener in `App.tsx` and the settings dialog's Shortcuts tab read from, so
binding and label can't drift apart.

## The renderer

- Terminal output goes straight to xterm, never through React state. Instances live in
  `src/renderer/terminal-views.ts`, outside React, keyed by project *and* tab — tab ids are only
  unique within their project — so they survive tab/project switches untouched. Arrives batched, one
  periodic flush carrying every terminal that produced something, so message count doesn't grow with
  the number of open tabs.
- An xterm is built the first time its tab is in front of the user (`TerminalHost` attaches on
  `active && visible`), not on mount — every tab of every project mounts at startup, and a theme
  read plus DOM and character measurement for each was most of the window's start. Nothing's lost by
  waiting, since a tab's process only starts on its first fit; once attached a view stays attached.
- **The views under `App` are memoized, and `App` hands them stable props.** `App` re-renders on
  every tab and repository push from any project; without `React.memo` on `TerminalsPane`,
  `ProjectList`, `CommandList`, `GitPane`, `BranchTree`, `BranchBar` and `DiffDialog`, each — branch
  tree with all its refs, a 5000-line diff — re-renders for a spinner starting elsewhere. Only holds
  while props stay stable: a callback is a `useCallback`, an object a `useMemo`, an empty list a
  shared constant (`NO_TABS`, `NO_IDS`), per-project mark lists keep identity while their ids match
  (`marks`). An inline arrow on one of these silently switches its memo off — as `usePaneSize`'s
  setter did before becoming a `useCallback`.
- A merely hidden terminal keeps its layout (`visibility`, not `display`) — xterm needs a laid-out
  element to measure itself. A whole pane may use `display: none` but needs refitting on return.
- **The element xterm mounts into is `.terminal-host`, never `.terminal`.** xterm gives its own
  element the class list `terminal xterm ...`, so a rule named for the plain word lands on both it
  and the container — the inset below was taken twice for months, a doubled gutter on three sides
  and none on the fourth. New elements in that subtree get their own name; xterm's own classes are
  `xterm`, `xterm-viewport`, `xterm-screen` and `terminal`.
- A terminal sits 6px inside its pane on every side (`.terminal-stack`'s padding plus
  `.terminal-host`'s matching inset — an absolutely positioned child ignores padding alone). That
  gutter is terminal background, living on `.terminal-host` with `.xterm-viewport` forced
  transparent over it: xterm.css hardcodes that viewport to black, which showed through as a black
  gutter and a black strip under the last row while a pane was dragged taller.
- A file dragged over a terminal frames the **pane** (`.terminal-host.drag-over`), so it's clear
  which mounted terminal would take the drop. A `::after` overlay, not a border — a border would
  shrink the box xterm measures, so every drag would refit and resize the pty. Only a drag carrying
  files raises it, the only kind the drop handler acts on. A file dropped anywhere *else* is
  swallowed in `main.tsx`: unhandled, Electron navigates the window to it and the app is gone. Files
  only — text dragged into a field still needs to reach that field.
- **Nothing in the lane at the terminal's right edge may be left to an xterm default, and CSS isn't
  what settles it** — both elements there are xterm's own and redrawn as the buffer grows, so the
  **color given in `theme.ts`** decides — `#00000000` for each, as hex so it passes xterm's color
  parser. The scrollbar: since xterm 6 it's a copy of VS Code's scrollable element with a
  `<div class="slider">`, not native, so `styles.css`'s older rules (`scrollbar-width`,
  `::-webkit-scrollbar`) never touch it — a TUI repaints its whole viewport, so a mismatched one
  would only twitch, and the wheel is what scrolls. And the overview ruler, asked for only to stop
  FitAddon reserving 14px for a scrollbar (`overviewRuler: { width: 1 }`) — xterm outlines it every
  frame regardless of marks, and an unset outline is a light line beside every terminal.
- Resizing is two steps, debounced differently. `refitTerminal` follows the container immediately —
  local to xterm, only acting on a whole row/column, so a dragged sash never leaves an empty pane
  strip behind. `fitTerminal` also tells the pty, repainting the CLI in full, and waits for dragging
  to settle. The sash reports one size per animation frame, not per pointer event — a mouse sends
  hundreds a second — and stores it a moment after the last one.
- `provideLinks` runs on **every render** while the pointer's over the terminal, and an agent TUI
  repaints constantly. Nothing expensive, no logging, in that path.
- A terminal's xterm theme is built **per terminal**, not once for the window, for one deliberate
  lie: opencode's TUI swaps blue and magenta from VS Code's terminal palette, so `buildXtermTheme`
  swaps them back for that agent alone. Observed, not derived — if opencode's colours ever look
  wrong the other way, take this back out. Only matters because of `"theme": "system"` in
  `tui-config.ts`.
- Measurements are shared, not invented per view: a bar along an edge is 35px, the tab strip's
  height — title bar, both sidebar headers (`.sidebar-header`) and the diff dialog's bar all use it.
  Same for the 22px action button and the 1px `--vscode-panel-border` between panes. Check the
  neighbouring view's size before inventing a new one.
- **An icon is one size everywhere, and it takes two numbers.** The box is `--icon-size`, 13px
  everywhere — the one knob resizing every icon. The other number is how much of its grid a *path*
  covers, from 59% (chevron) to 100% (Claude's mark): every icon declares the `extent` it was
  **measured** at, and `Svg` crops the viewBox so all cover `TARGET_EXTENT`, scaling `strokeWidth`
  the same factor. Extents are tuned to each icon's *geometric mean*, not its longer side —
  normalising the long side alone left a 12×9 shape looking small beside a 12×12 one, reported in
  turn for the branch icon, sync arrows, sparkle and Claude's mark. Verified at a mean of 11.9–12.0px
  wherever shape allows; a chevron and a row of dots are capped, not stretched. Neither number is
  optional: unequal extents in a shared box is what the app looked like for months.
- Adding or redrawing an icon means re-measuring, not estimating: render it, read `getBBox()` on
  each child grown by half its stroke, write down that extent and centre. The title bar's gear is
  the one exception, declaring no extent and keeping its own proportions among the platform's
  caption glyphs.
- **State an icon's size in CSS; never rely on the `width`/`height` the shared `<Svg>` writes as
  attributes** — a fallback a flex container is free to shrink. `.icon-button` is a `<button>`;
  `styles.css`'s reset clears border and background but not padding, and Chrome's default `1px 6px`
  with `border-box` left 12px of content inside a 24px box, so every icon in every such button
  rendered 12 by 18 for as long as the class existed. `.icon-button` now sets `padding: 0`; a
  squashed icon still looks like an icon, which is why it went unnoticed.
- **When two things that should look identical don't, measure them — don't read the code harder.**
  This cost several rounds of correct-but-wrong reasoning; what found it in one step: rebuild a page
  with the *built* stylesheet and real markup, serve over http (`file://` blocks the browser tools),
  read `getComputedStyle` per element. Use layout size, not `getBoundingClientRect`, on anything
  carrying `.spinning` — a rotated square reports a larger hull box than its own edge.
- The box *around* an icon counts as part of its size — the same glyph reads smaller inside a 24px
  `.icon-button` than bare in a row, which is why the project row's spinner is an `.icon-button`
  itself.
- **Anything that marks or points at something is 1px in `--vscode-focusBorder`**: the drop
  indicator between rows, the active tab's underline, the frame around a terminal a file's held
  over, the sash while dragged (`--vscode-sash-hoverBorder`, VS Code's name for the same blue). A new
  one copies an existing rule rather than picking its own width and color — two that differ read as
  two meanings. The active git toggle's 2px accent is the exception, VS Code's own. Same for a mark
  that's a *shape*: every session mark sits under one `.session-mark` rule, drawn to the square its
  neighbours occupy rather than the full 2–14 box.
- **Icons and marks are monochrome**; the only colour any takes is that blue. The changes list's
  status letters are the one exception, colored by `gitDecoration-*`, the theme's own answer for that
  list — the test for the next one: a colour is allowed where Dark Modern already names one for that
  meaning, nowhere else.
- Colors come from `--vscode-*` variables only (`src/renderer/vscode-theme.css`). Add a new variable
  rather than hardcoding, using VS Code's own name. Exception: the diff's syntax colors — Shiki
  assigns those per grammar scope, hundreds per theme, handed back per token, so
  `src/renderer/diff-highlight.ts` writes them inline; its `dark-plus` is the token half of the same
  theme the variables come from.
- Two hover colors, not interchangeable. A *row* (list item, tree item, tab, section header) takes
  `--vscode-list-hoverBackground`. An *action button* takes the translucent
  `--vscode-toolbar-hoverBackground` wherever it sits — the list color would be invisible on an
  already-hovered row, or a grey patch on a selected one's blue. A selected row keeps its selection
  color while hovered.
- The renderer is one bundle with no code splitting, so every Shiki grammar in that file's list ships
  regardless of use — a list of what a repository plausibly holds, not all two hundred; an unlisted
  language shows plain text. Imported lazily, so an unopened one costs bundle size but no startup
  time.
- `.pane-hidden` is last in `styles.css` on purpose: it has to override the `display` the panes it
  hides set on themselves, and they're all single-class selectors too.

## npm scripts

- `npm run compile` — bundle main, preload and renderer
- `npm run typecheck`
- `npm run lint`
- `npm start` — typecheck, compile, then launch (see "Do not restart the app yourself" first). The
  typecheck is there because esbuild only bundles: an unimported identifier is a global to it, so it
  drops the unused export and the app dies on load with a `ReferenceError` a `tsc` run would have
  named at the import.

## Releasing

When asked for a release, run it — no need to re-derive these steps first:

```
npm version patch   # or minor / major
git push && git push --tags
```

`npm version` bumps `package.json` and tags in one step, so the two can't drift apart. The tag
push triggers `.github/workflows/build.yml`, which builds all three platforms and publishes to a
GitHub Release with its own `GITHUB_TOKEN` — the repo is public so `electron-updater`
(`src/main/auto-update.ts`) can read releases without a token of its own.

Windows and Linux run from the AppImage auto-install on the next quit — never forced, since a
terminal tab is a live agent session (see "Do not restart the app yourself"). macOS and the
`.deb` build can't self-replace, so they only get a notice linking to the release page.
