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

/** Where an agent may write what it needs to set itself up for one repository. */
export interface AgentPaths {
  /**
   * This agent's own scratch directory for this repository, already created. Per repository
   * because meeseex has several open at once and what is generated in there (notification
   * texts, hook settings) names the repository it belongs to.
   */
  agentDir: string;
  /**
   * The repository's context file, kept current by meeseex — the agent's job is only to
   * arrange for it to reach the model. Blank whenever there is nothing to say.
   */
  contextFile: string;
  /**
   * The files the context file points at rather than inlining. They sit outside the
   * repository, so an agent that gates reads by path has to grant these explicitly.
   */
  contextReadPaths: string[];
  /** Meeseex's user-data root, for anything an agent has to install machine-wide. */
  storageRoot: string;
}

/**
 * Result of an agent's async spawn preparation — see AgentDefinition.prepareSpawn. `args`
 * and `env` are merged into every session the manager starts, `dispose` runs at shutdown.
 */
export interface SpawnPreparation {
  args: string[];
  env?: Record<string, string>;
  dispose(): void;
  /**
   * Whether this may be disposed again while the project has no session and no open tab of
   * this agent, and prepared afresh once it does. Set it when the preparation holds something
   * that costs while it sits idle — opencode's is a server process per repository, started
   * only so its sessions could be listed. A preparation that is just a generated file is
   * cheaper to keep than to redo, and leaves this unset.
   *
   * Whatever the agent's `watch` holds goes with it, since it may well be a subscription on
   * the very thing being disposed.
   */
  releaseWhenIdle?: boolean;
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
   * then attaches to and only then knows the URL, and Claude Code's hooks are generated
   * into a settings file it is pointed at.
   *
   * It is also where an agent arranges for the repository's context file to reach the model,
   * which each does its own way — see AgentPaths.
   */
  prepareSpawn?: (executable: string, cwd: string, paths: AgentPaths) => Promise<SpawnPreparation>;
  /**
   * Completes a url the agent's TUI wrapped across rows, from the agent's own record of
   * what it printed — the terminal buffer can't be told apart from a line that merely ends
   * in a url (opencode breaks a long token at the last "." that fits, so not even the
   * right edge marks it). Returns the full url that starts with `prefix`, or undefined
   * when nothing is known; the renderer then keeps the fragment as it is.
   *
   * Called only when the user holds the modifier over such a url, at most once per
   * fragment, so an implementation may go over HTTP — but must not throw.
   */
  resolveUrlPrefix?: (executable: string, cwd: string, sessionId: string, prefix: string) => Promise<string | undefined>;
  /**
   * A factory (not the predicate itself!) for the "is this session's CLI ready yet" check —
   * called once per session start, so each session gets its own fresh, isolated predicate
   * instead of carrying over one that already passed. The predicate sees each output chunk
   * (and the ms elapsed since that session started); once it returns true, the progress bar
   * under the tab strip hides. The CLI's real output keeps flowing to the terminal the whole
   * time regardless — some CLIs query the terminal for capabilities like its background
   * colour right at start and need a timely answer, which withholding output would break.
   *
   * There's no actual readiness signal to check instead (no port, no log line, no flag), so
   * this is necessarily a best-effort guess at the CLI's undocumented output behaviour —
   * which is why the tuning lives per agent and not in the shared terminal layer. Omitted
   * for agents that are up as soon as they are spawned (the shell).
   */
  createIsSessionReady?: () => (chunk: string, elapsedMs: number) => boolean;
}
