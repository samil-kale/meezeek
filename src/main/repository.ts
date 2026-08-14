import * as fs from "node:fs";
import * as path from "node:path";
import { shell } from "electron";
import { EMPTY_REPOSITORY_STATE } from "../shared/types";
import type {
  CheckoutTarget,
  DiffOptions,
  FileDiff,
  GitActionResult,
  NoticeSeverity,
  Project,
  RepositoryState,
  StashCommand
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

/**
 * How long to wait before putting a failed watcher back, and the ceiling the delay doubles up
 * to. A watcher that dies takes every change with it and nothing says so, which is worth
 * retrying for — but a filesystem that cannot watch recursively at all (a network share, some
 * mounts) fails every single time, and retrying that once a second would be a busy loop for
 * as long as the window is open.
 */
const WATCH_RETRY_MS = 1000;
const WATCH_RETRY_MAX_MS = 60_000;

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
  private state: RepositoryState = EMPTY_REPOSITORY_STATE;
  private watcher: fs.FSWatcher | undefined;
  private watchRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private watchRetryDelay = WATCH_RETRY_MS;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshing = false;
  private refreshPending = false;
  private lastRefreshAt = 0;
  private actionRunning = false;
  private autoFetchTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * Each remote's url, read when the project opens and again after it is changed here. Not
   * part of a refresh: a url changes about never, and a refresh's cost is the git processes
   * it starts.
   */
  private remoteUrls: Record<string, string> = {};
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
      const next = { ...EMPTY_REPOSITORY_STATE, error: "Not a git repository" };
      this.reportError(next);
      this.state = next;
      this.onState(next);
      return;
    }
    await this.loadRemoteUrls();
    await this.refresh();
    this.startWatching();
    this.autoFetchTimer = setInterval(() => void this.autoFetch(), AUTO_FETCH_INTERVAL_MS);
  }

  private async loadRemoteUrls(): Promise<void> {
    this.remoteUrls = await git.readRemoteUrls(this.project.path).catch(() => ({}));
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
      const read = await git.readState(this.project.path).catch((error: Error) => ({
        ...EMPTY_REPOSITORY_STATE,
        error: error.message
      }));
      // The urls are this side's; the refresh does not spend a process on them.
      const next: RepositoryState = {
        ...read,
        remotes: read.remotes.map((remote) => ({ ...remote, url: this.remoteUrls[remote.name] }))
      };
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
   * The remote every command that names one uses: the first, which is "origin" in all but a
   * handful of repositories and is what GitHub Desktop picks too.
   */
  private get remote(): string | undefined {
    return this.state.remotes[0]?.name;
  }

  /** Rewrites what the remote has. Only offered after a rebase left the branch diverged. */
  forcePush(): Promise<GitActionResult> {
    return this.runAction(() => {
      if (!this.remote || this.state.detached) {
        return Promise.resolve({ ok: false, error: "There is no branch to push here" });
      }
      return git.forcePush(this.project.path, this.remote, this.state.head);
    });
  }

  pullRebase(): Promise<GitActionResult> {
    return this.runAction(() => git.pullRebase(this.project.path));
  }

  /** Points the remote somewhere else and re-reads the urls, since only this changes them. */
  setRemoteUrl(remote: string, url: string): Promise<GitActionResult> {
    return this.runAction(async () => {
      const result = await git.setRemoteUrl(this.project.path, remote, url);
      await this.loadRemoteUrls();
      return result;
    });
  }

  createBranch(name: string, startPoint: string): Promise<GitActionResult> {
    return this.runAction(() => git.createBranch(this.project.path, name, startPoint));
  }

  renameBranch(from: string, to: string): Promise<GitActionResult> {
    return this.runAction(() => git.renameBranch(this.project.path, from, to));
  }

  /**
   * Deletes the branch locally and, when asked, on the remote as well. The local one goes
   * first: it is the one that cannot fail for reasons outside the machine, and a remote that
   * refuses the deletion leaves a state the user can still see and act on.
   */
  deleteBranch(name: string, onRemote: boolean): Promise<GitActionResult> {
    return this.runAction(async () => {
      const local = await git.deleteBranch(this.project.path, name);
      if (!local.ok || !onRemote) {
        return local;
      }
      return this.remote
        ? git.deleteRemoteBranch(this.project.path, this.remote, name)
        : { ok: false, error: "This repository has no remote to delete the branch from" };
    });
  }

  merge(ref: string): Promise<GitActionResult> {
    return this.runAction(() => git.merge(this.project.path, ref));
  }

  rebase(ref: string): Promise<GitActionResult> {
    return this.runAction(() => git.rebase(this.project.path, ref));
  }

  /** Takes back the merge or rebase git is half-way through, whichever one that is. */
  abort(): Promise<GitActionResult> {
    return this.runAction(() => {
      const operation = this.state.operation;
      return operation
        ? git.abortOperation(this.project.path, operation)
        : Promise.resolve({ ok: false, error: "Nothing is in progress here" });
    });
  }

  createTag(name: string, target: string, message: string): Promise<GitActionResult> {
    return this.runAction(() => git.createTag(this.project.path, name, target, message));
  }

  pushTag(name: string): Promise<GitActionResult> {
    return this.runAction(() =>
      this.remote
        ? git.pushTag(this.project.path, this.remote, name)
        : Promise.resolve({ ok: false, error: "This repository has no remote to push the tag to" })
    );
  }

  deleteTag(name: string, onRemote: boolean): Promise<GitActionResult> {
    return this.runAction(async () => {
      const local = await git.deleteTag(this.project.path, name);
      if (!local.ok || !onRemote) {
        return local;
      }
      return this.remote
        ? git.deleteRemoteTag(this.project.path, this.remote, name)
        : { ok: false, error: "This repository has no remote to delete the tag from" };
    });
  }

  checkoutTag(name: string): Promise<GitActionResult> {
    return this.runAction(() => git.checkoutTag(this.project.path, name));
  }

  /** Puts the working tree away, untracked files and all, and leaves it clean. */
  stashPush(message: string): Promise<GitActionResult> {
    return this.runAction(() => git.stashPush(this.project.path, message));
  }

  /**
   * One of the three commands that take a stash. The ref is a *position* — dropping one
   * renumbers the rest — so it is only ever the one the last refresh reported, and the
   * refresh this runs afterwards is what the next click reads from.
   */
  stash(command: StashCommand, ref: string): Promise<GitActionResult> {
    const commands = { apply: git.stashApply, pop: git.stashPop, drop: git.stashDrop };
    return this.runAction(() => commands[command](this.project.path, ref));
  }

  /**
   * Throws away the local changes to these files. What HEAD does not hold goes to the trash
   * instead of being deleted, so "discard" stays recoverable the way GitHub Desktop's is.
   */
  discard(paths: string[]): Promise<GitActionResult> {
    // Through runAction like every other command: `git restore` takes the index lock, so a
    // discard started from the changes' context menu while a fetch or a checkout is still
    // running would fail on the lock — and the trash it moves untracked files to has already
    // happened by then.
    return this.runAction(async () => {
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

      return git.discard(this.project.path, targets);
    });
  }

  /** Adds the file, or everything with its extension, to the repository's .gitignore. */
  ignore(filePath: string, scope: "file" | "extension"): Promise<GitActionResult> {
    return this.runAction(() => git.ignorePath(this.project.path, filePath, scope));
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
        // Events are arriving, so whatever went wrong before is over — the next failure backs
        // off from the bottom again rather than from where the last one left the delay.
        this.watchRetryDelay = WATCH_RETRY_MS;
        this.scheduleRefresh();
      });
      this.watcher.on("error", (error) => {
        console.error(`[meezeek] watcher failed for ${this.project.path}:`, error);
        this.watcher?.close();
        this.watcher = undefined;
        this.retryWatching();
      });
    } catch (error) {
      // A filesystem that cannot watch recursively throws here rather than emitting an error.
      console.error(`[meezeek] could not watch ${this.project.path}:`, error);
      this.retryWatching();
    }
  }

  /**
   * Puts a failed watcher back, and refreshes once one is up again: whatever changed while
   * nothing was watching has to come in from somewhere. Without this a single error left the
   * repository frozen for the life of the window, with nothing on screen saying so.
   */
  private retryWatching(): void {
    clearTimeout(this.watchRetryTimer);
    const delay = this.watchRetryDelay;
    this.watchRetryDelay = Math.min(delay * 2, WATCH_RETRY_MAX_MS);
    this.watchRetryTimer = setTimeout(() => {
      if (this.disposed) {
        return;
      }
      this.startWatching();
      if (this.watcher) {
        void this.refresh();
      }
    }, delay);
  }

  dispose(): void {
    // Read by refresh, which may be half-way through a git call that outlives this: what comes
    // back then belongs to a project the window has already forgotten.
    this.disposed = true;
    clearTimeout(this.debounceTimer);
    clearTimeout(this.watchRetryTimer);
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
