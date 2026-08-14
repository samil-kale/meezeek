/** Every agent there is, as values — so what comes off disk can be checked against them. */
export const AGENT_IDS = ["claude", "opencode", "shell"] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && (AGENT_IDS as readonly string[]).includes(value);
}

export interface AgentInfo {
  id: AgentId;
  displayName: string;
  /** Whether this agent persists sessions; the shell does not, so its tabs are just terminals. */
  hasSessions: boolean;
}

export interface Project {
  id: string;
  /** Absolute path of the repository working directory. */
  path: string;
  /** Display name; the directory's base name. */
  name: string;
}

/**
 * One saved shell command of a project. `cwd` is where it runs, relative to the project root —
 * a monorepo's frontend scripts belong to the folder that declares them, and writing
 * `npm run build` next to the folder it runs in reads better than the flag that would move it
 * ("--prefix", "-C", "--project"), which not every tool even has.
 */
export interface ProjectAction {
  command: string;
  /** Relative to the project root; absent means the root itself. */
  cwd?: string;
  /**
   * Environment variables the command runs with. Its own field because there is no way to
   * write one *into* a command that works everywhere: `PROFILE=x java -jar ...` is POSIX
   * syntax that PowerShell reads as a command name. These win over the ones inherited from
   * the machine — the action says what it needs.
   */
  env?: Record<string, string>;
  /**
   * Hands the command to a shell instead of starting the program itself — for the one that
   * really needs a pipe or a redirection, and which then only works on the platform it was
   * written for. Off by default: with no shell in the way there is no syntax to differ
   * between machines.
   */
  shell?: boolean;
}

export interface RemoteInfo {
  name: string;
  /** Branch names without the remote prefix, e.g. "development". */
  branches: string[];
  /**
   * What it was configured with, e.g. "git@github.com:owner/repo.git". Read when the project
   * opens rather than on every refresh: a remote's url changes about never, and the refresh
   * path spends its git processes on what does.
   */
  url?: string;
}

/** What can be done with a stash from its row: put it back, put it back and drop it, or drop it. */
export type StashCommand = "apply" | "pop" | "drop";

export interface StashEntry {
  /** What the stash commands take, e.g. "stash@{0}". Not stable: dropping one renumbers the rest. */
  ref: string;
  /** git's own line for it, e.g. "WIP on main: 1a2b3c the last commit's subject". */
  message: string;
}

/** A merge or a rebase git stopped half-way through, so the UI can offer to abort it. */
export type GitOperation = "merge" | "rebase";

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface FileChange {
  /** Repository-relative path, forward slashes. */
  path: string;
  status: ChangeStatus;
  /** Previous path, set for renames. */
  origPath?: string;
}

export interface RepositoryState {
  /** Branch name, or the short commit id while HEAD is detached. */
  head: string;
  detached: boolean;
  /** The branch HEAD tracks, e.g. "origin/main"; absent when it tracks none or none exists. */
  upstream?: string;
  /** Commits HEAD has that its upstream does not, and the other way round. Both 0 without one. */
  ahead: number;
  behind: number;
  localBranches: string[];
  remotes: RemoteInfo[];
  /**
   * The branch the first remote's HEAD points at, e.g. "main" — what "Update from main"
   * merges in. Absent where the remote never published one.
   */
  defaultBranch?: string;
  /** Tag names, as `for-each-ref` orders them. */
  tags: string[];
  stashes: StashEntry[];
  changes: FileChange[];
  /** A merge or rebase git is half-way through; the branch menu offers to abort it. */
  operation?: GitOperation;
  /** Set when git could not be run or the folder is not a repository; the rest is then empty. */
  error?: string;
}

/**
 * How loudly a notice asks to be read. Only "info" goes away on its own; the other two wait
 * to be dismissed, because nobody should have to catch a failure as it passes by.
 */
export type NoticeSeverity = "error" | "warning" | "info";

/**
 * Anything the user is told, without exception — see the CLAUDE.md section. A view never keeps
 * a message of its own; what a view may still draw for itself is a *status* (a tab colored for
 * a missing agent, a progress bar), which is a condition that holds rather than something that
 * happened.
 */
export interface Notice {
  severity: NoticeSeverity;
  message: string;
}

export type DiffLineType = "context" | "add" | "del" | "hunk";

export interface DiffLine {
  type: DiffLineType;
  /** Line number in the old file; absent for added lines. On a hunk header, where it starts. */
  oldLine?: number;
  /** Line number in the new file; absent for deleted lines. On a hunk header, where it starts. */
  newLine?: number;
  text: string;
}

/** Both versions of an image as data URLs; either is absent when the file was added or deleted. */
export interface ImageDiff {
  before?: string;
  after?: string;
}

export interface FileDiff {
  path: string;
  lines: DiffLine[];
  binary: boolean;
  /** True when `lines` was cut off because the diff is very large. */
  truncated: boolean;
  /** Set instead of `lines` when the file is an image git could only call binary. */
  image?: ImageDiff;
  error?: string;
}

/** How a diff is read; the view's own switches, not anything about the file. */
export interface DiffOptions {
  /** `git diff -w`: lines that differ only in spacing stop counting as changes. */
  ignoreWhitespace?: boolean;
}

/** What any git action the UI starts reports back: it worked, or what git said when it didn't. */
export interface GitActionResult {
  ok: boolean;
  error?: string;
}

/** A branch to check out: a local branch, or a remote-tracking one like "origin/development". */
export interface CheckoutTarget {
  name: string;
  remote?: string;
}

/**
 * One terminal's output since the last flush. They cross to the renderer in batches: with
 * several agents redrawing their TUIs at once, one message per tab per flush is a message
 * count that grows with the number of open terminals for no gain.
 */
export interface TerminalOutput {
  projectId: string;
  tabId: string;
  data: string;
}

export type TerminalStatus = "missing" | "ready" | "running" | "stopped" | "error";

export interface TerminalDescriptor {
  /** Unique within its project; equals the agent's session id for a restored tab. */
  tabId: string;
  projectId: string;
  agentId: AgentId;
  /** Session title; "" makes the UI show a placeholder. */
  title: string;
  status: TerminalStatus;
  /** Whether the agent has persisted a session for this tab yet — nothing to rename if not. */
  hasSession: boolean;
  /** Last activity, ms since epoch; absent for tabs without a session. */
  updatedAt?: number;
  /** Creation time, ms since epoch; absent for tabs without a session. */
  createdAt?: number;
}
