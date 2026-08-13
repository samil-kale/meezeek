import type {
  AgentId,
  AgentInfo,
  CheckoutResult,
  CheckoutTarget,
  FileDiff,
  Project,
  RepositoryState,
  TerminalDescriptor,
  TerminalStatus
} from "./types";

/** Removes a listener registered through one of the `on*` methods. */
export type Unsubscribe = () => void;

export interface MeeseexApi {
  projects: {
    list(): Promise<Project[]>;
    /** Opens a folder picker; resolves null when the dialog was cancelled. */
    add(): Promise<Project | null>;
    remove(projectId: string): Promise<void>;
  };
  repository: {
    state(projectId: string): Promise<RepositoryState>;
    refresh(projectId: string): Promise<RepositoryState>;
    checkout(projectId: string, target: CheckoutTarget): Promise<CheckoutResult>;
    diff(projectId: string, path: string): Promise<FileDiff>;
    /** Fires whenever a repository's state changed (git command, file watcher or refresh). */
    onState(listener: (payload: { projectId: string; state: RepositoryState }) => void): Unsubscribe;
  };
  terminals: {
    list(projectId: string): Promise<TerminalDescriptor[]>;
    /** Opens a tab for a new session of that agent; the session itself starts on first resize. */
    create(projectId: string, agentId: AgentId): Promise<TerminalDescriptor>;
    /** Closes tabs and deletes the sessions behind them. */
    close(projectId: string, tabIds: string[]): Promise<void>;
    rename(projectId: string, tabId: string, title: string): Promise<void>;
    input(projectId: string, tabId: string, data: string): void;
    /** The first resize of a tab is what starts its process (lazy spawn). */
    resize(projectId: string, tabId: string, cols: number, rows: number): void;
    /** Fires with the full tab list of a project whenever it changed. */
    onTabs(listener: (payload: { projectId: string; tabs: TerminalDescriptor[] }) => void): Unsubscribe;
    onOutput(listener: (payload: { projectId: string; tabId: string; data: string }) => void): Unsubscribe;
    onStatus(
      listener: (payload: { projectId: string; tabId: string; status: TerminalStatus }) => void
    ): Unsubscribe;
  };
  agents: {
    list(): Promise<AgentInfo[]>;
  };
  /** Failures the user should see (a session that could not be renamed or deleted). */
  onNotice(listener: (payload: { message: string }) => void): Unsubscribe;
}
