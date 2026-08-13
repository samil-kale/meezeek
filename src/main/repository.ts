import * as fs from "node:fs";
import * as path from "node:path";
import { shell } from "electron";
import type {
  CheckoutTarget,
  FileDiff,
  GitActionResult,
  NoticeSeverity,
  Project,
  RepositoryState
} from "../shared/types";
import { countActivity } from "./event-loop-monitor";
import {
  appendIgnoreRules,
  checkout,
  createBranch,
  deleteBranch,
  deleteRemoteBranch,
  discard,
  ignoreRuleForExtension,
  ignoreRuleForPath,
  isRepository,
  readDiff,
  readState,
  renameBranch,
  type DiscardTargets
} from "./git";

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
  private branchActionRunning = false;
  /** Checked once when the project opens; without it there is nothing to read or watch. */
  private isGit = false;

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
    this.isGit = await isRepository(this.project.path);
    if (!this.isGit) {
      const next = { ...LOADING_STATE, error: "Not a git repository" };
      this.reportError(next);
      this.state = next;
      this.onState(next);
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
      this.reportError(next);
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

  /**
   * Runs one branch command at a time and refreshes after it. Two of them in one repository
   * race for the index lock, and which branch you end up on comes down to timing. The UI does
   * not offer a second one while the first runs; anything that gets here anyway is refused
   * rather than gambled on.
   */
  private async runBranchAction(action: () => Promise<GitActionResult>): Promise<GitActionResult> {
    if (this.branchActionRunning) {
      return { ok: false, error: "A branch command is already running" };
    }
    this.branchActionRunning = true;
    try {
      const result = await action();
      await this.refresh();
      return result;
    } finally {
      this.branchActionRunning = false;
    }
  }

  checkout(target: CheckoutTarget): Promise<GitActionResult> {
    return this.runBranchAction(() => checkout(this.project.path, target, this.state.localBranches));
  }

  createBranch(name: string, startPoint?: string): Promise<GitActionResult> {
    return this.runBranchAction(() => createBranch(this.project.path, name, startPoint));
  }

  renameBranch(from: string, to: string): Promise<GitActionResult> {
    return this.runBranchAction(() => renameBranch(this.project.path, from, to));
  }

  /**
   * Deletes the branch locally and, when a remote is named, there as well. The local one goes
   * first: it always succeeds where the push may not, and a failed push then leaves a plain
   * "the remote said no" rather than a half-done state to explain.
   */
  deleteBranch(name: string, remote?: string): Promise<GitActionResult> {
    return this.runBranchAction(async () => {
      const local = await deleteBranch(this.project.path, name);
      if (!local.ok || remote === undefined) {
        return local;
      }
      return deleteRemoteBranch(this.project.path, remote, name);
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

    const result = await discard(this.project.path, targets);
    await this.refresh();
    return result;
  }

  /** Adds the file, or everything with its extension, to the repository's .gitignore. */
  async ignore(filePath: string, scope: "file" | "extension"): Promise<GitActionResult> {
    const rule = scope === "file" ? ignoreRuleForPath(filePath) : ignoreRuleForExtension(filePath);
    if (rule === undefined) {
      return { ok: false, error: `${filePath} has no extension to ignore` };
    }
    const result = await appendIgnoreRules(this.project.path, [rule]);
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
    clearTimeout(this.debounceTimer);
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
