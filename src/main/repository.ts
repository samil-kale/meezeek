import * as fs from "node:fs";
import type {
  CheckoutResult,
  CheckoutTarget,
  FileDiff,
  Project,
  RepositoryState
} from "../shared/types";
import { checkout, readDiff, readState } from "./git";

/** Filesystem events arrive in bursts (a build, a checkout, an agent editing files). */
const REFRESH_DEBOUNCE_MS = 250;

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

  constructor(
    readonly project: Project,
    private readonly onState: (state: RepositoryState) => void
  ) {}

  getState(): RepositoryState {
    return this.state;
  }

  async start(): Promise<void> {
    await this.refresh();
    this.startWatching();
  }

  async refresh(): Promise<RepositoryState> {
    if (this.refreshing) {
      this.refreshPending = true;
      return this.state;
    }
    this.refreshing = true;
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
      if (this.refreshPending) {
        this.refreshPending = false;
        void this.refresh();
      }
    }
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
        clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => void this.refresh(), REFRESH_DEBOUNCE_MS);
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
