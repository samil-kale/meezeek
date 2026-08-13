import type { AgentId } from "../shared/types";

export interface AgentSessionInfo {
  /** Agent-native session id (Claude: transcript uuid; opencode: "ses_..."). */
  id: string;
  /** Human-readable label; "" allowed — the UI falls back to a placeholder. */
  title: string;
  /** Last activity, ms since epoch (Claude: transcript mtime; opencode: `updated`). */
  updatedAt: number;
  /** Creation time, ms since epoch — determines tab order, independent of `updatedAt`. */
  createdAt: number;
  /**
   * True while `title` is only standing in for a name the agent hasn't assigned yet
   * (Claude: the first prompt, shown until an agent-name/ai-title lands). Those arrive from
   * a background call that can finish after the CLI has gone quiet, so the manager keeps
   * polling a while longer for sessions flagged here — see reconcile.
   */
  provisionalTitle?: boolean;
}

/**
 * Agent-specific session enumeration/resume/deletion, living in the agent's own folder
 * since it speaks that agent's protocol (Claude: transcript files on disk; opencode: its
 * HTTP API).
 */
export interface SessionProvider {
  /** All sessions of this repository, in creation order (oldest first). Must resolve [] on any failure. */
  list(executable: string, cwd: string): Promise<AgentSessionInfo[]>;
  /** CLI args that open the given session. */
  resumeArgs(sessionId: string): string[];
  /** Permanently deletes the session. Rejects on failure (caller surfaces the error). */
  remove(executable: string, cwd: string, sessionId: string): Promise<void>;
  /** Renames the session's persisted title. Rejects on failure (caller surfaces the error). */
  rename(executable: string, cwd: string, sessionId: string, title: string): Promise<void>;
  /**
   * Optional: calls `onChange` whenever this repository's sessions change, so the manager
   * can re-list right away instead of waiting out its polling. Returns a stop function,
   * called on shutdown — an implementation that owns a process or connection tears it
   * down there.
   */
  watch?(executable: string, cwd: string, onChange: () => void): () => void;
}

/**
 * Result of an agent's async spawn preparation — see AgentDefinition.prepareSpawn. `args`
 * and `env` are merged into every session the manager starts, `dispose` runs at shutdown.
 */
export interface SpawnPreparation {
  args: string[];
  env?: Record<string, string>;
  dispose(): void;
}

/**
 * Everything the shared terminal layer needs to run one agent. Agent-specific behaviour
 * stays behind these callbacks so the shared layer never imports an agent's own code.
 */
export interface AgentDefinition {
  id: AgentId;
  displayName: string;
  /** Resolved at spawn time, since the shell's executable depends on the platform. */
  executable(): string;
  args?: string[];
  /** Defaults, not overrides — a variable the user already has set wins (see spawnAgentProcess). */
  env?: Record<string, string>;
  /**
   * Args that make the executable report its version, used to tell "not installed" from a
   * spawn that failed for another reason. Omitted for agents that always exist (the shell).
   */
  versionArgs?: string[];
  /** Session enumeration/resume/deletion; a missing provider means "this agent has no sessions". */
  sessions?: SessionProvider;
  /**
   * Async setup that has to finish before any session of this agent is spawned, for agents
   * whose spawn arguments aren't known up front — opencode brings up the server its TUI
   * then attaches to, and only then knows the URL.
   */
  prepareSpawn?: (executable: string, cwd: string) => Promise<SpawnPreparation>;
}
