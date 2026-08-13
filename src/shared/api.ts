import type {
  AgentId,
  AgentInfo,
  CheckoutTarget,
  FileDiff,
  GitActionResult,
  Notice,
  Project,
  RepositoryState,
  TerminalDescriptor,
  TerminalStatus
} from "./types";

/** Removes a listener registered through one of the `on*` methods. */
export type Unsubscribe = () => void;

export interface MeeseekApi {
  projects: {
    list(): Promise<Project[]>;
    /** Opens a folder picker; resolves null when the dialog was cancelled. */
    add(): Promise<Project | null>;
    remove(projectId: string): Promise<void>;
    /** Persists the order the user dragged them into, as the full list of ids. */
    reorder(projectIds: string[]): Promise<void>;
  };
  repository: {
    state(projectId: string): Promise<RepositoryState>;
    refresh(projectId: string): Promise<RepositoryState>;
    checkout(projectId: string, target: CheckoutTarget): Promise<GitActionResult>;
    /** Creates the branch and switches to it; `startPoint` defaults to HEAD. */
    createBranch(projectId: string, name: string, startPoint?: string): Promise<GitActionResult>;
    renameBranch(projectId: string, from: string, to: string): Promise<GitActionResult>;
    /** Deletes it locally, and on `remote` as well when one is named. Asks nothing — the
        renderer has already put the question. */
    deleteBranch(projectId: string, name: string, remote?: string): Promise<GitActionResult>;
    /** Throws the local changes to these files away; the caller confirms first. */
    discard(projectId: string, paths: string[]): Promise<GitActionResult>;
    /** Appends the file, or its whole extension, to the repository's .gitignore. */
    ignore(projectId: string, path: string, scope: "file" | "extension"): Promise<GitActionResult>;
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
    /**
     * The full url a fragment on screen was cut off from, asked of the agent that printed
     * it. Null when it has no answer — the caller must not ask again for that fragment.
     */
    resolveUrl(projectId: string, tabId: string, fragment: string): Promise<string | null>;
    /** Fires with the full tab list of a project whenever it changed. */
    onTabs(listener: (payload: { projectId: string; tabs: TerminalDescriptor[] }) => void): Unsubscribe;
    onOutput(listener: (payload: { projectId: string; tabId: string; data: string }) => void): Unsubscribe;
    onStatus(
      listener: (payload: { projectId: string; tabId: string; status: TerminalStatus }) => void
    ): Unsubscribe;
    /** Whether anything in the project is still starting up (a CLI booting, sessions listing). */
    onStartupProgress(listener: (payload: { projectId: string; show: boolean }) => void): Unsubscribe;
    /**
     * The current value of the above. A project restored at app start bootstraps before the
     * window exists, so that first "show" is never pushed to anyone — ask for it instead.
     */
    starting(projectId: string): Promise<boolean>;
  };
  agents: {
    list(): Promise<AgentInfo[]>;
  };
  files: {
    /**
     * The real path of a dropped file, or "" when the drag came from somewhere other than
     * the filesystem (an image dragged out of a browser) and only carries content.
     */
    pathOf(file: File): string;
    /** Saves content that has no path of its own and returns the temp file's path. */
    writeTemp(name: string, dataBase64: string): Promise<string>;
    /** The clipboard's image saved to a temp file; null when the clipboard holds no image. */
    clipboardImage(): Promise<string | null>;
  };
  shell: {
    openUrl(url: string): Promise<void>;
    /**
     * Opens a path the user activated in a terminal. Resolves to the repository-relative
     * path when the file has local changes — the caller then shows it in the git tab —
     * and to null when it was handed to the OS instead (or could not be opened).
     */
    openFile(projectId: string, path: string): Promise<string | null>;
    /** Shows a repository-relative path in the OS file manager, selected. */
    revealFile(projectId: string, path: string): Promise<void>;
  };
  /** Failures the user should see (a session that could not be renamed or deleted). */
  /** Anything transient the main process wants said — see Notice. */
  onNotice(listener: (payload: Notice) => void): Unsubscribe;
}
