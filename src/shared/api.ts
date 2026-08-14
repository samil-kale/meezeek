import type {
  AddAccountResult,
  AddRepositoryResult,
  AgentId,
  AgentInfo,
  AppInfo,
  AppSettings,
  CheckoutTarget,
  DiffOptions,
  FileDiff,
  GitActionResult,
  ListRepositoriesResult,
  Notice,
  Project,
  ProjectCommand,
  ProviderAccount,
  ProviderId,
  RepositoryState,
  Requirements,
  StashCommand,
  TerminalDescriptor,
  TerminalOutput,
  TerminalStatus
} from "./types";

/** Removes a listener registered through one of the `on*` methods. */
export type Unsubscribe = () => void;

export interface MeezeekApi {
  /** The programs meezeek cannot run without; the window shows the app only once they are there. */
  startup: {
    /** Runs the check and, when it passes, brings the stored projects up. */
    check(): Promise<Requirements>;
    /** Leaves, for the user who would rather install first. */
    quit(): void;
  };
  /** What meezeek is rather than what it is set to; the settings dialog's Info tab shows it. */
  app: {
    info(): Promise<AppInfo>;
  };
  /** What the settings dialog reads and writes; there is one set of them for the whole app. */
  settings: {
    get(): Promise<AppSettings>;
    /** Writes all of it. Each switch applies to the agents set up after it — see the dialog. */
    save(settings: AppSettings): Promise<void>;
  };
  projects: {
    list(): Promise<Project[]>;
    /**
     * Opens a native folder picker; resolves null when it was cancelled. `defaultPath` is the
     * folder it opens in — a folder that is no longer there is ignored by the platform.
     */
    pickDirectory(title: string, defaultPath?: string): Promise<string | null>;
    /** Opens the folder — or the repository it is a subdirectory of — as a project. */
    open(directory: string): Promise<Project>;
    /**
     * `git clone` into a new folder `name` inside `directory`, which becomes a project. With
     * an account, its token authenticates the clone — the remote tab's rows pass one.
     */
    clone(url: string, directory: string, name: string, accountId?: string): Promise<AddRepositoryResult>;
    remove(projectId: string): Promise<void>;
    /** Persists the order the user dragged them into, as the full list of ids. */
    reorder(projectIds: string[]): Promise<void>;
  };
  /** The configured repository-host accounts and what the remote tab asks them. */
  providers: {
    accounts(): Promise<ProviderAccount[]>;
    /** Validates the token against the host and stores the account; the token stays main-side. */
    addAccount(provider: ProviderId, host: string, token: string): Promise<AddAccountResult>;
    removeAccount(accountId: string): Promise<void>;
    /** Keeps the group the remote tab was narrowed to; "" is all of them, and is a choice too. */
    setNamespace(accountId: string, namespace: string): Promise<void>;
    /** Every repository the account can reach, most recently active first. */
    repos(accountId: string): Promise<ListRepositoriesResult>;
  };
  repository: {
    state(projectId: string): Promise<RepositoryState>;
    refresh(projectId: string): Promise<RepositoryState>;
    checkout(projectId: string, target: CheckoutTarget): Promise<GitActionResult>;
    /** `git fetch --prune`. Also runs on its own every ten minutes, quietly. */
    fetch(projectId: string): Promise<GitActionResult>;
    pull(projectId: string): Promise<GitActionResult>;
    /** Pushes the current branch, setting its upstream when it has none ("publish"). */
    push(projectId: string): Promise<GitActionResult>;
    /** `git push --force-with-lease`, for a branch a rebase left diverged from its upstream. */
    forcePush(projectId: string): Promise<GitActionResult>;
    pullRebase(projectId: string): Promise<GitActionResult>;
    /** Points a remote somewhere else; the new url is in the next state. */
    setRemoteUrl(projectId: string, remote: string, url: string): Promise<GitActionResult>;
    /** Creates the branch off `startPoint` and switches to it. */
    createBranch(projectId: string, name: string, startPoint: string): Promise<GitActionResult>;
    renameBranch(projectId: string, from: string, to: string): Promise<GitActionResult>;
    /** Deletes it locally and, when asked, on the remote too; the caller confirms first. */
    deleteBranch(projectId: string, name: string, onRemote: boolean): Promise<GitActionResult>;
    /** Merges the ref into the current branch. A conflict is reported and left in the tree. */
    merge(projectId: string, ref: string): Promise<GitActionResult>;
    rebase(projectId: string, ref: string): Promise<GitActionResult>;
    /** Takes back the merge or rebase in `RepositoryState.operation`. */
    abort(projectId: string): Promise<GitActionResult>;
    /** Annotated when there is a message, lightweight when there is not. */
    createTag(projectId: string, name: string, target: string, message: string): Promise<GitActionResult>;
    pushTag(projectId: string, name: string): Promise<GitActionResult>;
    deleteTag(projectId: string, name: string, onRemote: boolean): Promise<GitActionResult>;
    /** A tag names a commit, so this leaves HEAD detached. */
    checkoutTag(projectId: string, name: string): Promise<GitActionResult>;
    /** Stashes everything the changes list shows, untracked files included. */
    stashPush(projectId: string, message: string): Promise<GitActionResult>;
    /** Applies, pops or drops one. The ref is a position — only ever a freshly read one. */
    stash(projectId: string, command: StashCommand, ref: string): Promise<GitActionResult>;
    /** Throws the local changes to these files away; the caller confirms first. */
    discard(projectId: string, paths: string[]): Promise<GitActionResult>;
    /** Appends the file, or its whole extension, to the repository's .gitignore. */
    ignore(projectId: string, path: string, scope: "file" | "extension"): Promise<GitActionResult>;
    diff(projectId: string, path: string, options: DiffOptions): Promise<FileDiff>;
    /** Lines `from` to `to` of the file as it is now, for a gap the diff view opens. */
    fileLines(projectId: string, path: string, from: number, to: number): Promise<string[]>;
    /** Fires whenever a repository's state changed (git command, file watcher or refresh). */
    onState(listener: (payload: { projectId: string; state: RepositoryState }) => void): Unsubscribe;
  };
  /**
   * A project's saved shell commands, kept in a meezeek.json in its own root. They belong to
   * the repository, not to meezeek's storage, so they follow it around.
   */
  commands: {
    /** Null when the project has no meezeek.json yet — as opposed to one with an empty list. */
    list(projectId: string): Promise<ProjectCommand[] | null>;
    /** Writes the whole list; adding, removing and reordering all go through here. */
    save(projectId: string, commands: ProjectCommand[]): Promise<void>;
    /**
     * Opens a terminal tab whose process is that command, in its own directory. Resolves to
     * the tab, so the caller can bring it to the front; null when there is nothing to run it
     * with.
     */
    run(projectId: string, command: ProjectCommand): Promise<TerminalDescriptor | null>;
    /**
     * Has an installed agent read the project and name the commands it can run, adds what is
     * new to the list, and resolves to the whole list. Reports what happened as a notice.
     */
    suggest(projectId: string): Promise<ProjectCommand[]>;
  };
  terminals: {
    list(projectId: string): Promise<TerminalDescriptor[]>;
    /** Opens a tab for a new session of that agent; the session itself starts on first resize. */
    create(projectId: string, agentId: AgentId): Promise<TerminalDescriptor>;
    /** Closes tabs and deletes the sessions behind them. */
    close(projectId: string, tabIds: string[]): Promise<void>;
    rename(projectId: string, tabId: string, title: string): Promise<void>;
    /**
     * The tab is on screen, which clears the `finishedAt` a finished turn left on it. Called
     * for the active tab of the project on screen — the main process cannot tell which that
     * is, so this is the renderer's half of the mark.
     */
    seen(projectId: string, tabId: string): void;
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
    /** One message per flush, carrying every terminal that produced something in it. */
    onOutput(listener: (batch: TerminalOutput[]) => void): Unsubscribe;
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
    /**
     * Hands a repository-relative path to whatever the OS opens that type with — the nearest
     * thing meezeek has to GitHub Desktop's external editor, which it has no setting for.
     */
    openFileExternally(projectId: string, path: string): Promise<void>;
    /** Opens the project's own folder in the OS file manager. */
    openProject(projectId: string): Promise<void>;
  };
  /** Failures the user should see (a session that could not be renamed or deleted). */
  /** Anything transient the main process wants said — see Notice. */
  onNotice(listener: (payload: Notice) => void): Unsubscribe;
}
