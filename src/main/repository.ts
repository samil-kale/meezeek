import * as fs from "node:fs";
import type {
  CheckoutResult,
  CheckoutTarget,
  FileDiff,
  Project,
  RepositoryState
} from "../shared/types";
import { countActivity } from "./event-loop-monitor";
import { checkout, isRepository, readDiff, readState } from "./git";

/** Filesystem events arrive in bursts (a build, a checkout, an agent editing files). */
const REFRESH_DEBOUNCE_MS = 250;
/**
 * Least time between two finished refreshes. A working tree under continuous change would
 * otherwise keep one running back to back, and every git process a refresh starts is
 * main-process time that a keystroke on its way to a terminal waits for. Measured on a
 * machine with instrumented process creation: ~350ms per git start, two per refresh.
 */
const REFRESH_MIN_INTERVAL_MS = 2000;

const LOADING_STATE: RepositoryState = {
  head: "",
  detached: false,
  localBranches: [],
  remotes: [],
  changes: []
};

/**
 * Paths whose changes never affect what the UI shows, but which change constantly —
 * watching them would mean running `git status` for every object git writes.
 */
function isIgnoredEvent(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return (
    normalized.endsWith(".lock") ||
    normalized.startsWith(".git/objects/") ||
    normalized.startsWith(".git/logs/") ||
    // Bookkeeping git rewrites on nearly every command without any of it showing up in the
    // status or the branch list. `.git/index` is deliberately not here: staging a file
    // changes nothing else, and the status letters would otherwise go stale.
    /^\.git\/(COMMIT_EDITMSG|ORIG_HEAD|FETCH_HEAD|MERGE_MSG|rebase-)/.test(normalized) ||
    normalized.includes("node_modules/")
  );
}

/**
 * One repository's shared state: the single source of truth both the git views and the
 * terminals observe. Refreshed from the git CLI after filesystem changes, so a branch an
 * agent switches in a terminal shows up in the UI on its own.
 */
export class Repository {
  private state: RepositoryState = LOADING_STATE;
  private watcher: fs.FSWatcher | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshing = false;
  private refreshPending = false;
  private lastRefreshAt = 0;
  /** Checked once when the project opens; without it there is nothing to read or watch. */
  private isGit = false;

  constructor(
    readonly project: Project,
    private readonly onState: (state: RepositoryState) => void
  ) {}

  getState(): RepositoryState {
    return this.state;
  }

  async start(): Promise<void> {
    this.isGit = await isRepository(this.project.path);
    if (!this.isGit) {
      this.state = { ...LOADING_STATE, error: "Not a git repository" };
      this.onState(this.state);
      return;
    }
    await this.refresh();
    this.startWatching();
  }

  async refresh(): Promise<RepositoryState> {
    if (!this.isGit) {
      return this.state;
    }
    if (this.refreshing) {
      this.refreshPending = true;
      return this.state;
    }
    this.refreshing = true;
    countActivity("git");
    try {
      const next = await readState(this.project.path);
      // Only emit on an actual change: the watcher fires for plenty of edits that leave
      // the repository state identical, and every emit re-renders the views.
      if (JSON.stringify(next) !== JSON.stringify(this.state)) {
        this.state = next;
        this.onState(next);
      }
      return next;
    } finally {
      this.refreshing = false;
      this.lastRefreshAt = Date.now();
      if (this.refreshPending) {
        this.refreshPending = false;
        // Back through the schedule rather than straight into another run: under continuous
        // change this was an unbroken chain of git processes, with the debounce bypassed.
        this.scheduleRefresh();
      }
    }
  }

  /**
   * Refreshes once the events have settled, and never sooner than REFRESH_MIN_INTERVAL_MS
   * after the last one finished. Only the watcher goes through here — a refresh the user
   * asked for runs at once.
   */
  private scheduleRefresh(): void {
    clearTimeout(this.debounceTimer);
    const delay = Math.max(REFRESH_DEBOUNCE_MS, this.lastRefreshAt + REFRESH_MIN_INTERVAL_MS - Date.now());
    this.debounceTimer = setTimeout(() => void this.refresh(), delay);
  }

  async checkout(target: CheckoutTarget): Promise<CheckoutResult> {
    const result = await checkout(this.project.path, target, this.state.localBranches);
    await this.refresh();
    return result;
  }

  async diff(filePath: string): Promise<FileDiff> {
    const change = this.state.changes.find((candidate) => candidate.path === filePath);
    return readDiff(this.project.path, filePath, {
      untracked: change?.status === "untracked",
      origPath: change?.origPath
    });
  }

  private startWatching(): void {
    try {
      this.watcher = fs.watch(this.project.path, { recursive: true }, (_event, filename) => {
        if (filename && isIgnoredEvent(filename.toString())) {
          return;
        }
        this.scheduleRefresh();
      });
      this.watcher.on("error", (error) => {
        console.error(`[meeseex] watcher failed for ${this.project.path}:`, error);
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch (error) {
      // Without a watcher the repository still works, it just only updates on refresh.
      console.error(`[meeseex] could not watch ${this.project.path}:`, error);
    }
  }

  dispose(): void {
    clearTimeout(this.debounceTimer);
    this.watcher?.close();
    this.watcher = undefined;
  }
}

export class RepositoryManager {
  private readonly repositories = new Map<string, Repository>();

  constructor(private readonly onState: (projectId: string, state: RepositoryState) => void) {}

  open(project: Project): Repository {
    const existing = this.repositories.get(project.id);
    if (existing) {
      return existing;
    }
    const repository = new Repository(project, (state) => this.onState(project.id, state));
    this.repositories.set(project.id, repository);
    void repository.start();
    return repository;
  }

  get(projectId: string): Repository | undefined {
    return this.repositories.get(projectId);
  }

  close(projectId: string): void {
    this.repositories.get(projectId)?.dispose();
    this.repositories.delete(projectId);
  }

  disposeAll(): void {
    for (const repository of this.repositories.values()) {
      repository.dispose();
    }
    this.repositories.clear();
  }
}
