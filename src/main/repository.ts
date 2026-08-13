import * as fs from "node:fs";
import * as path from "node:path";
import { shell } from "electron";
import type {
  CheckoutTarget,
  DiffOptions,
  FileDiff,
  GitActionResult,
  NoticeSeverity,
  Project,
  RepositoryState
} from "../shared/types";
import { countActivity } from "./event-loop-monitor";
import { git } from "./git-client";
import type { DiscardTargets } from "./git";

/** Filesystem events arrive in bursts (a build, a checkout, an agent editing files). */
const REFRESH_DEBOUNCE_MS = 250;
/**
 * Least time between two finished refreshes. A working tree under continuous change would
 * otherwise keep one running back to back, and every git process a refresh starts is
 * main-process time that a keystroke on its way to a terminal waits for. Measured on a
 * machine with instrumented process creation: ~350ms per git start, two per refresh.
 */
const REFRESH_MIN_INTERVAL_MS = 2000;
/**
 * How often a repository fetches on its own, GitHub Desktop's interval. Frequent enough that
 * the ahead/behind counts are worth reading, rare enough not to hammer a remote all day.
 */
const AUTO_FETCH_INTERVAL_MS = 10 * 60_000;

const LOADING_STATE: RepositoryState = {
  head: "",
  detached: false,
  ahead: 0,
  behind: 0,
  localBranches: [],
  remotes: [],
  tags: [],
  stashes: [],
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
  private actionRunning = false;
  private autoFetchTimer: ReturnType<typeof setInterval> | undefined;
  /** Checked once when the project opens; without it there is nothing to read or watch. */
  private isGit = false;
  /** The project was closed; anything still in flight stops short of reporting. */
  private disposed = false;

  constructor(
    readonly project: Project,
    private readonly onState: (state: RepositoryState) => void,
    private readonly onNotice: (severity: NoticeSeverity, message: string) => void
  ) {}

  /**
   * Reports a repository that could not be read. Named by project, since several are open and
   * "Not a git repository" alone would not say which. Only on a change, so a folder that stays
   * unreadable is not announced again on every refresh.
   */
  private reportError(next: RepositoryState): void {
    if (next.error && next.error !== this.state.error) {
      this.onNotice("error", `${this.project.name}: ${next.error}`);
    }
  }

  getState(): RepositoryState {
    return this.state;
  }

  async start(): Promise<void> {
    this.isGit = await git.isRepository(this.project.path).catch(() => false);
    if (!this.isGit) {
      const next = { ...LOADING_STATE, error: "Not a git repository" };
      this.reportError(next);
      this.state = next;
      this.onState(next);
      return;
    }
    await this.refresh();
    this.startWatching();
    this.autoFetchTimer = setInterval(() => void this.autoFetch(), AUTO_FETCH_INTERVAL_MS);
  }

  /**
   * The periodic fetch. It says nothing when it fails: a repository whose remote needs
   * credentials nobody entered, or a machine that is offline, would otherwise put the same
   * notice up every ten minutes for something the user never asked for. A fetch they *did*
   * ask for reports as loudly as anything else.
   */
  private async autoFetch(): Promise<void> {
    if (this.actionRunning || this.state.remotes.length === 0) {
      return;
    }
    this.actionRunning = true;
    try {
      await git.fetch(this.project.path).catch(() => undefined);
      await this.refresh();
    } finally {
      this.actionRunning = false;
    }
  }

  async refresh(): Promise<RepositoryState> {
    if (!this.isGit || this.disposed) {
      return this.state;
    }
    if (this.refreshing) {
      this.refreshPending = true;
      return this.state;
    }
    this.refreshing = true;
    countActivity("git");
    try {
      // readState answers with an error rather than throwing; what can still reject is the
      // git process having gone away underneath it, and that is worth saying out loud.
      const next = await git.readState(this.project.path).catch((error: Error) => ({
        ...LOADING_STATE,
        error: error.message
      }));
      this.reportError(next);
      // Only emit on an actual change: the watcher fires for plenty of edits that leave
      // the repository state identical, and every emit re-renders the views. And not at all
      // once the project is closed — this call was already in flight when it went.
      if (!this.disposed && JSON.stringify(next) !== JSON.stringify(this.state)) {
        this.state = next;
        this.onState(next);
      }
      return next;
    } finally {
      this.refreshing = false;
      this.lastRefreshAt = Date.now();
      if (this.refreshPending && !this.disposed) {
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

  /**
   * Runs one command at a time and refreshes after it. Two of them in one repository race for
   * the index lock, and which branch you end up on comes down to timing; a fetch on top of a
   * checkout is no better. The UI does not offer a second one while the first runs; anything
   * that gets here anyway is refused rather than gambled on.
   */
  private async runAction(action: () => Promise<GitActionResult>): Promise<GitActionResult> {
    if (this.actionRunning) {
      return { ok: false, error: "A git command is already running for this repository" };
    }
    this.actionRunning = true;
    try {
      // A git command reports failure in its result; a rejection here is the git process
      // itself having stopped, which the caller shows the same way.
      const result = await action().catch((error: Error) => ({ ok: false, error: error.message }));
      await this.refresh();
      return result;
    } finally {
      this.actionRunning = false;
    }
  }

  checkout(target: CheckoutTarget): Promise<GitActionResult> {
    return this.runAction(() => git.checkout(this.project.path, target, this.state.localBranches));
  }

  fetch(): Promise<GitActionResult> {
    return this.runAction(() => git.fetch(this.project.path));
  }

  pull(): Promise<GitActionResult> {
    return this.runAction(() => git.pull(this.project.path));
  }

  /**
   * Pushes the current branch, publishing it when it has no upstream yet. Which remote to
   * publish to is only a question where there are several; the first one is what GitHub
   * Desktop uses too, and it is "origin" in all but a handful of repositories.
   */
  push(): Promise<GitActionResult> {
    return this.runAction(() => {
      const remote = this.state.remotes[0]?.name;
      if (!remote) {
        return Promise.resolve({ ok: false, error: "This repository has no remote to push to" });
      }
      if (this.state.detached) {
        return Promise.resolve({ ok: false, error: "HEAD is detached — check out a branch to push it" });
      }
      return git.push(this.project.path, remote, this.state.head, this.state.upstream === undefined);
    });
  }

  /**
   * Throws away the local changes to these files. What HEAD does not hold goes to the trash
   * instead of being deleted, so "discard" stays recoverable the way GitHub Desktop's is.
   */
  async discard(paths: string[]): Promise<GitActionResult> {
    const targets: DiscardTargets = { restore: [], drop: [] };
    for (const filePath of paths) {
      const change = this.state.changes.find((candidate) => candidate.path === filePath);
      if (!change) {
        continue;
      }
      if (change.status === "untracked" || change.status === "added") {
        targets.drop.push(filePath);
        // Staged and then deleted again on disk still reads as "added" — there is nothing
        // left to move, and asking the trash to take it would only fail.
        const absolute = path.join(this.project.path, filePath);
        if (fs.existsSync(absolute)) {
          try {
            await shell.trashItem(absolute);
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        }
        continue;
      }
      targets.restore.push(filePath);
      // A rename is one entry over two paths, and only the old one is in HEAD.
      if (change.origPath) {
        targets.restore.push(change.origPath);
      }
    }

    const result = await git.discard(this.project.path, targets);
    await this.refresh();
    return result;
  }

  /** Adds the file, or everything with its extension, to the repository's .gitignore. */
  async ignore(filePath: string, scope: "file" | "extension"): Promise<GitActionResult> {
    const result = await git.ignorePath(this.project.path, filePath, scope);
    await this.refresh();
    return result;
  }

  async diff(filePath: string, options: DiffOptions): Promise<FileDiff> {
    const change = this.state.changes.find((candidate) => candidate.path === filePath);
    return git
      .readDiff(this.project.path, filePath, {
        ...options,
        untracked: change?.status === "untracked",
        origPath: change?.origPath
      })
      .catch((error: Error) => ({ path: filePath, lines: [], binary: false, truncated: false, error: error.message }));
  }

  /** The file's own lines, for a gap the diff view was asked to open. */
  fileLines(filePath: string, from: number, to: number): Promise<string[]> {
    // Same as when the file cannot be read: no lines, so the gap simply stays closed.
    return git.readFileLines(this.project.path, filePath, from, to).catch(() => []);
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
        console.error(`[meeseek] watcher failed for ${this.project.path}:`, error);
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch (error) {
      // Without a watcher the repository still works, it just only updates on refresh.
      console.error(`[meeseek] could not watch ${this.project.path}:`, error);
    }
  }

  dispose(): void {
    // Read by refresh, which may be half-way through a git call that outlives this: what comes
    // back then belongs to a project the window has already forgotten.
    this.disposed = true;
    clearTimeout(this.debounceTimer);
    clearInterval(this.autoFetchTimer);
    this.watcher?.close();
    this.watcher = undefined;
  }
}

export class RepositoryManager {
  private readonly repositories = new Map<string, Repository>();

  constructor(
    private readonly onState: (projectId: string, state: RepositoryState) => void,
    private readonly onNotice: (severity: NoticeSeverity, message: string) => void
  ) {}

  open(project: Project): Repository {
    const existing = this.repositories.get(project.id);
    if (existing) {
      return existing;
    }
    const repository = new Repository(project, (state) => this.onState(project.id, state), this.onNotice);
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
