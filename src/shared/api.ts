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
    create(projectId: string, agentId: AgentId): Promise<TerminalDescriptor>;
    close(terminalId: string): Promise<void>;
    input(terminalId: string, data: string): void;
    /** The first resize of a terminal is what starts its process (lazy spawn). */
    resize(terminalId: string, cols: number, rows: number): void;
    onOutput(listener: (payload: { id: string; data: string }) => void): Unsubscribe;
    onStatus(listener: (payload: { id: string; status: TerminalStatus }) => void): Unsubscribe;
  };
  agents: {
    list(): Promise<AgentInfo[]>;
  };
}
