export type AgentId = "claude" | "opencode" | "shell";

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

export type ViewId = "terminals" | "changes";

export interface RemoteInfo {
  name: string;
  /** Branch names without the remote prefix, e.g. "development". */
  branches: string[];
}

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
  localBranches: string[];
  remotes: RemoteInfo[];
  changes: FileChange[];
  /** Set when git could not be run or the folder is not a repository; the rest is then empty. */
  error?: string;
}

export type DiffLineType = "context" | "add" | "del" | "hunk";

export interface DiffLine {
  type: DiffLineType;
  /** Line number in the old file; absent for added lines and hunk headers. */
  oldLine?: number;
  /** Line number in the new file; absent for deleted lines and hunk headers. */
  newLine?: number;
  text: string;
}

export interface FileDiff {
  path: string;
  lines: DiffLine[];
  binary: boolean;
  /** True when `lines` was cut off because the diff is very large. */
  truncated: boolean;
  error?: string;
}

export interface CheckoutResult {
  ok: boolean;
  error?: string;
}

/** A branch to check out: a local branch, or a remote-tracking one like "origin/development". */
export interface CheckoutTarget {
  name: string;
  remote?: string;
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
