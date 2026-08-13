# CLAUDE.md

## What this is

Meeseek is a git workspace for coding agents: Electron + React + xterm.js, several
repositories open at once, each with its own git tab and its own set of agent and shell
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

`Repository` (`src/main/repository.ts`) is the single source of truth both the git tab and the
terminals observe, so a branch an agent switches in a terminal shows up in the UI on its own.
It watches the working directory, debounces and throttles the burst (see below), and only emits
when the state actually changed — the watcher fires for plenty of edits that leave it
identical, and every emit re-renders. Diffs are loaded when a file is selected, never up front.

Working today: local branches (create, rename, delete), remotes, checkout, status, per-file
diff (including a synthesised one for untracked files), discarding changes and adding a file
to `.gitignore`. Still missing, roughly in order: clone, then GitHub and GitLab behind one
`GitProvider` interface (authenticate, list repositories, resolve a clone URL) under
`src/providers/`. Providers stay separate from the local git layer — once a repository is
cloned, everything goes back through the CLI.

Everything that acts on a branch goes through `Repository.runBranchAction`, which runs one at
a time per repository and refreshes after it: two of them race for the same index lock, and
which branch you end up on comes down to timing. The renderer holds the matching half in
`App`'s `branchAction` — one project's tree stops offering them while one runs, and the branch
bar says what is happening instead of naming HEAD.

`branch --delete` is offered with GitHub Desktop's checkbox for deleting it on the remote too,
and that push is the one command in this layer that goes to the network. It is short and the
user waits for it either way, but it is also the first thing that makes the "everything here
is quick" argument below untrue — when clone, fetch or push land, this is one of the callers
that moves into the `utilityProcess` with them.

Discarding follows GitHub Desktop rather than `git checkout --`: a file HEAD does not know is
moved to the trash (`shell.trashItem`) instead of being deleted, so the action stays
recoverable. `git restore --source=HEAD --staged --worktree` covers everything else, index and
worktree in one command; a rename is two paths and only the old one is in HEAD.

Out of scope on purpose: commit UI, history, graph, interactive rebase, cherry-pick, stash,
tags, bisect, submodules, merge UI. Those go through an agent or a shell.

### git shares a process with everyone's keystrokes

The same main process reads git and writes to the ptys, so every git process a refresh starts
is time a keystroke on its way to a terminal waits for. This is not theoretical: it made typing
in an agent's terminal visibly lag, and the event loop lost 7–11 seconds *per minute*.

Two things were wrong, and both are worth not reintroducing. `Repository.refresh` re-ran
immediately when events had arrived while it was running, which bypassed the debounce and
turned a busy working tree into an unbroken chain of git processes; the pending path now goes
back through `scheduleRefresh`, which also keeps a minimum interval between two finished
refreshes. And `readState` spawned four git processes where two do: a folder does not stop
being a repository (checked once in `start()`), and `git status --branch` reports the current
branch along with the changes. Only a detached HEAD still needs a third call.

Starting git is what costs, not the work: on the machine this was measured on — process
creation instrumented by security software — `git rev-parse` in a 58-file repository took
350ms. So the thing to count in this layer is *invocations*, not what each one does. Anything
added to the refresh path should earn its process.

When the git half grows a long-running command — clone, fetch, push — that argument runs out,
and git moves into a `utilityProcess` of its own. VS Code has it in the extension host and its
terminals in a pty host, which is why the problem cannot arise there at all. Move git rather
than the terminals: git is the unpredictable half (seconds to minutes, output of unknown size),
while relaying pty output is small and constant per chunk and is the part that has to stay
responsive. The cut is cheap as long as it happens first — `git.ts` and `repository.ts` are the
only places that touch git, and everything they expose is already asynchronous.

`src/main/event-loop-monitor.ts` is what measured all of this and is still wired up: it samples
the loop and writes stalls to `event-loop.log` in the app's `userData`, with a tally of what
ran. It stays silent while nothing blocks.

## Everything the user is told is a notice

`notify(severity, message)` from `src/renderer/components/Notices.tsx` is the only way to say
something to the user, and it takes no exceptions. No view keeps a message of its own, and
nothing is written into a pane where it happens. It is a plain function rather than a prop or a
hook — VS Code's `window.showErrorMessage` is the model — so anything that fails can report it
without a callback having been threaded down to it.

`error` and `warning` stay until they are clicked away; only `info` disappears on its own. An
identical message that is already standing is dropped rather than stacked. The main process
reports through the same channel: `app:notice` carries a `Notice`, and the renderer hands it
straight to `notify`.

This replaced a single error string in `App`, where a second failure silently overwrote the
first, and it took the messages that used to live inside views with it — the repository error
in the branch bar and the diff error in the diff pane are both notices now. Those views show
their ordinary empty state instead, and say nothing themselves.

What is *not* a notice is a status: a tab colored for an agent that isn't installed, the
progress bar, the branch bar's own name. Those are conditions a view draws for as long as they
hold, not something that happened once.

Nor is a *question*. `confirm(options)` from `src/renderer/components/Dialog.tsx` is how one is
put, and it is built like `notify`: a plain function anything can call, and one `Dialogs`
mounted next to `Notices` that draws whatever is pending. It resolves to whether the user went
through with it and whether the one checkbox such a question may carry was ticked ("delete it
on the remote too"). One question at a time, and the overlay takes the clicks that could start
a second.

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
being checked out, the git tab reading or coloring a diff. Never add a second one anywhere —
the branch bar carried its own copy for checkouts and it is gone. A new slow operation is a new
condition in that one render, not a bar of its own.

Only the diff is gated on the git tab being on screen; one it loaded on the way out is nothing
the user is still waiting for. Everything else shows regardless of which tab is active, because
it keeps running either way.

## Agent-specific vs shared code

Each agent gets a folder under `src/agents/` and is described by one `AgentDefinition`
(`src/agents/agent.ts`). The shared terminal layer never imports an agent's own code — it only
calls those callbacks, so a new agent is a new folder plus one entry in `src/agents/index.ts`:

- `executable`, `args`, `env`, `versionArgs` — how to start it and how to tell "not installed"
  from a spawn that failed for another reason
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
- Claude Code's hook shell on win32 varies (PowerShell, cmd.exe and Git Bash were all observed).
  Avoid shell builtins and nested quoting; invoke a plain exe, e.g.
  `powershell -NoProfile -ExecutionPolicy Bypass -File "<script>.ps1"`.

## The renderer

- Terminal output goes straight to xterm, never through React state. The instances live in
  `src/renderer/terminal-views.ts`, outside React, keyed by project *and* tab — tab ids are
  only unique within their project — so they survive tab and project switches untouched.
- A terminal that is merely hidden must keep its layout (`visibility`, not `display`) — xterm
  needs a laid-out element to measure itself. A whole pane may use `display: none`, but then it
  has to be refit when it comes back.
- `provideLinks` runs on **every render** while the pointer is over the terminal, and an agent
  TUI repaints constantly. Nothing expensive, and no logging, in that path.
- Colors come from `--vscode-*` variables only (`src/renderer/vscode-theme.css`). Add a new
  variable rather than hardcoding, and use the name VS Code uses. The one exception is the
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
