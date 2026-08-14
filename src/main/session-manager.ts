import * as fs from "node:fs";
import * as path from "node:path";
import { AGENTS, getAgent } from "../agents";

import type { AgentDefinition, AgentPaths, SpawnPreparation } from "../agents/agent";
import { splitCommand } from "../shared/command";
import type {
  AgentId,
  NoticeSeverity,
  Project,
  ProjectCommand,
  TerminalDescriptor,
  TerminalStatus
} from "../shared/types";
import { countActivity } from "./event-loop-monitor";
import type { SettingsStore } from "./settings";
import { ShellContext } from "./shell-context";
import { checkAgentInstalled, TerminalSession } from "./terminal-session";

const RECONCILE_DEBOUNCE_MS = 5000;
// A tab's CLI can persist a title (a generated summary) well after its output went idle, so
// one reconcile after the debounce is not always enough — retry a few times before giving up.
const RECONCILE_RETRY_MS = 5000;
const RECONCILE_MAX_RETRIES = 3;
// A busy CLI redraws continuously, so the debounce above would be pushed out for the whole
// turn and a tab whose session or title is not known yet would keep its placeholder long
// after the CLI persisted one. Caps how far output can push it.
const RECONCILE_MAX_WAIT_MS = 10000;
// A watcher event is the change itself, not a guess that one may have happened, so it only
// needs enough of a debounce to collapse the handful of events a single write produces.
const WATCH_DEBOUNCE_MS = 300;
// A killed CLI gets a moment to die before its transcript is removed, so a final in-flight
// write can't resurrect the file we just deleted.
const SESSION_REMOVE_DELAY_MS = 500;
// Readiness fires on the CLI's first full frame, which is a moment before the terminal
// actually looks settled — hiding the indicator right then reads as a flicker.
const INDICATOR_LINGER_MS = 700;
/**
 * A token that only means anything to a shell. A saved command is started without one, so it
 * would silently become an argument; such a command is refused with a message instead. Whole
 * tokens only — `2>&1` and `>>` are matched, an argument that merely holds a `>` is not.
 */
const SHELL_OPERATOR = /^(?:&&|\|\||[|;&]|\d*>>?|\d*>&\d*|<)$/;

/**
 * `hasSession` is left out here: `sessionId` below is the source of truth for it, and it is
 * derived whenever a tab is posted to the renderer.
 */
interface TabState extends Omit<TerminalDescriptor, "hasSession"> {
  /** Agent-native session id; undefined while a fresh tab's CLI hasn't persisted one yet. */
  sessionId?: string;
  /** When this tab's pty was spawned — used to claim newly persisted sessions. */
  spawnedAt?: number;
  /** Mirrors AgentSessionInfo.provisionalTitle for this tab's session. */
  provisionalTitle?: boolean;
  /** The program a saved command runs, when that is not this agent's own executable. */
  executable?: string;
  /** A saved command's arguments — its own program's, or a shell's when it asked for one. */
  runArgs?: string[];
  /** Where its process runs, when that is not the project root — a command's own folder. */
  cwd?: string;
  /** A saved command's own environment variables, which outrank the machine's. */
  env?: Record<string, string>;
}

/** Per-agent state within one project: its executable, its setup, its reconcile loop. */
interface AgentRuntime {
  agent: AgentDefinition;
  executable: string;
  installed: boolean;
  /** Resolves once the agent's version check, spawn preparation and initial listing are done. */
  ready: Promise<void>;
  preparation?: SpawnPreparation;
  prepareFailed: boolean;
  /** One setup at a time: two tabs opened at once must not bring up two opencode servers. */
  preparing?: Promise<boolean>;
  /** Its setup and watcher are let go because nothing in this project is using them. */
  released: boolean;
  stopWatching?: () => void;
  reconciling?: Promise<void>;
  reconcileTimer?: ReturnType<typeof setTimeout>;
  reconcileRetriesLeft: number;
  /** Latest point in time the debounced reconcile may be pushed to; unset once it fires. */
  reconcileDeadline?: number;
  /** Sessions reported finished before any tab had claimed their id — see markFinished. */
  readonly pendingFinished: Set<string>;
}

export interface SessionManagerCallbacks {
  onTabs: (projectId: string, tabs: TerminalDescriptor[]) => void;
  onOutput: (projectId: string, tabId: string, data: string) => void;
  onStatus: (projectId: string, tabId: string, status: TerminalStatus) => void;
  /** Whether anything in this project is still starting up — drives the tab strip's bar. */
  onStartupProgress: (projectId: string, show: boolean) => void;
  /** Surfaces a failure the user should see (a session that could not be renamed or deleted). */
  onNotice: (severity: NoticeSeverity, message: string) => void;
}

/** Nothing about this tab's label is settled yet: no session claimed, no title, or only a
 * stand-in the agent may still replace with a name of its own. */
function titleUnsettled(tab: TabState): boolean {
  return !tab.sessionId || !tab.title || tab.provisionalTitle === true;
}

function toDescriptor(tab: TabState): TerminalDescriptor {
  const { tabId, projectId, agentId, title, updatedAt, createdAt, status, sessionId, finishedAt } = tab;
  return {
    tabId,
    projectId,
    agentId,
    title,
    updatedAt,
    createdAt,
    status,
    finishedAt,
    hasSession: sessionId !== undefined
  };
}

/**
 * One project's terminal tabs. Tabs mirror the agents' persisted sessions: every session
 * found when the project opens becomes a tab, and closing a tab deletes its session.
 */
export class ProjectSessionManager {
  private tabs: TabState[] = [];
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly runtimes = new Map<AgentId, AgentRuntime>();
  /** Tabs whose session is being constructed; a second resize must not start a second one. */
  private readonly starting = new Map<string, { cols: number; rows: number }>();
  /** Session ids whose removal is still in flight — reconcile must not re-claim them. */
  private readonly deletingSessionIds = new Set<string>();
  /** Tabs already removed from the UI that still need their persisted session claimed for deletion. */
  private readonly detachedTabs: TabState[] = [];
  private newTabCounter = 0;
  /** The project was closed; nothing that was still in flight may start anything back up. */
  private disposed = false;
  /**
   * How many things in this project are still starting — the progress bar is shared across
   * the project's tabs, so it stays up as long as at least one of them hasn't settled.
   */
  private indicators = 0;

  private readonly shellContext: ShellContext;

  constructor(
    private readonly project: Project,
    private readonly storageRoot: string,
    private readonly settings: SettingsStore,
    private readonly callbacks: SessionManagerCallbacks
  ) {
    this.shellContext = new ShellContext(path.join(storageRoot, "projects", project.id), project.name);
  }

  /** Where one agent may set itself up for this repository — see AgentDefinition.prepareSpawn. */
  private pathsFor(runtime: AgentRuntime): AgentPaths {
    const agentDir = path.join(this.storageRoot, "agents", runtime.agent.id, this.project.id);
    fs.mkdirSync(agentDir, { recursive: true });
    return {
      agentDir,
      contextFile: this.shellContext.contextFile,
      contextReadPaths: [this.shellContext.logFile],
      storageRoot: this.storageRoot,
      // Read here rather than held: an agent prepares once per project, so this is the moment
      // the current settings apply, and a change reaches the ones set up after it.
      notifications: this.settings.get().notifications,
      onSessionFinished: (sessionId) => this.markFinished(runtime, sessionId)
    };
  }

  snapshot(): TerminalDescriptor[] {
    return this.tabs.map(toDescriptor);
  }

  private postTabs(): void {
    this.callbacks.onTabs(this.project.id, this.snapshot());
  }

  /**
   * The current value of what onStartupProgress reports. The bootstrap of a project restored
   * at app start runs before the window exists, so its "show" never reaches a renderer — the
   * pane asks for the state once instead of waiting for a push.
   */
  isStarting(): boolean {
    return this.indicators > 0;
  }

  private acquireIndicator(): void {
    this.indicators += 1;
    if (this.indicators === 1) {
      this.callbacks.onStartupProgress(this.project.id, true);
    }
  }

  private releaseIndicator(): void {
    this.indicators -= 1;
    if (this.indicators === 0) {
      this.callbacks.onStartupProgress(this.project.id, false);
    }
  }

  /** Restores one tab per persisted session of every installed agent. */
  async bootstrap(): Promise<void> {
    // Covers the version checks and session listings too, not just the first tab's CLI
    // startup: opencode's server start and listing take seconds that would otherwise show
    // nothing at all.
    this.acquireIndicator();
    try {
      await Promise.all(AGENTS.map((agent) => this.runtimeFor(agent.id).ready));
      this.openFirstAgentTab();
    } finally {
      this.releaseIndicator();
    }
  }

  /**
   * A project that restored no session at all — just cloned, or every session deleted — opens
   * with one agent tab rather than an empty pane. Which agent is registration order, so Claude
   * Code where it is installed and opencode otherwise; the shell is skipped by having no
   * sessions, the same rule that decides whether a tab takes its title from one.
   *
   * Nothing is spawned by this: the tab only goes in the list, and the pane's first resize is
   * what starts the CLI — so a project the user never switches to costs nothing, and a fresh
   * tab persists no session, which is why this runs again on the next start.
   */
  private openFirstAgentTab(): void {
    if (this.disposed || this.tabs.length > 0) {
      return;
    }
    const agent = AGENTS.find((candidate) => candidate.sessions && this.canStart(this.runtimeFor(candidate.id)));
    if (agent) {
      this.createTab(agent.id);
    }
  }

  private runtimeFor(agentId: AgentId): AgentRuntime {
    const existing = this.runtimes.get(agentId);
    if (existing) {
      return existing;
    }
    const agent = getAgent(agentId);
    const runtime: AgentRuntime = {
      agent,
      executable: agent.executable(),
      // An agent without a version check (the shell) is always there.
      installed: agent.versionArgs === undefined,
      ready: Promise.resolve(),
      prepareFailed: false,
      released: false,
      reconcileRetriesLeft: 0,
      pendingFinished: new Set()
    };
    this.runtimes.set(agentId, runtime);
    runtime.ready = this.prepareRuntime(runtime);
    return runtime;
  }

  /** Both conditions for running the agent at all: it exists, and its setup succeeded. */
  private canStart(runtime: AgentRuntime): boolean {
    return runtime.installed && !runtime.prepareFailed;
  }

  private async prepareRuntime(runtime: AgentRuntime): Promise<void> {
    const { agent, executable } = runtime;
    const cwd = this.project.path;

    if (agent.versionArgs) {
      runtime.installed = await checkAgentInstalled(executable, agent.versionArgs, cwd);
    }
    if (!runtime.installed || !agent.sessions) {
      return;
    }

    // Before anything that could lead to a spawn: opencode's listing already needs the
    // server this brings up, and the terminal's own arguments come out of it too.
    if (!(await this.prepare(runtime))) {
      return;
    }

    const infos = await agent.sessions.list(executable, cwd);
    for (const info of infos) {
      this.tabs.push({
        tabId: info.id,
        projectId: this.project.id,
        agentId: agent.id,
        sessionId: info.id,
        title: info.title,
        updatedAt: info.updatedAt,
        createdAt: info.createdAt,
        provisionalTitle: info.provisionalTitle,
        status: "ready"
      });
    }
    if (infos.length > 0) {
      this.postTabs();
    }
    // Started after the initial listing so its first event can't race the bootstrap.
    this.startWatching(runtime);
    // Nothing was found and nothing has been opened while we were listing, so whatever the
    // setup is holding is serving no one.
    if (infos.length === 0) {
      this.releaseIdleRuntime(runtime);
    }
  }

  /**
   * Runs the agent's setup, at most one at a time. False means it failed and the agent must
   * not be started at all — one that asks for preparation cannot run without it in any
   * meaningful way (opencode would start a second instance sharing only the database: no
   * events, renames invisible to it). Better to start nothing than a terminal that quietly
   * misbehaves.
   */
  private prepare(runtime: AgentRuntime): Promise<boolean> {
    runtime.preparing ??= this.doPrepare(runtime).finally(() => {
      runtime.preparing = undefined;
    });
    return runtime.preparing;
  }

  private async doPrepare(runtime: AgentRuntime): Promise<boolean> {
    const { agent, executable } = runtime;
    if (!agent.prepareSpawn || runtime.preparation) {
      return !runtime.prepareFailed;
    }
    try {
      runtime.preparation = await agent.prepareSpawn(executable, this.project.path, this.pathsFor(runtime));
      // A setup that worked clears the earlier failure: `canStart` reads this flag and nothing
      // else puts it back, so one failed preparation (opencode's port taken, say) would leave
      // the agent unstartable for the rest of the session.
      runtime.prepareFailed = false;
      return true;
    } catch (error) {
      console.error("[meezeek] spawn preparation failed:", error);
      this.callbacks.onNotice("error", `${agent.displayName} could not be started: ${String(error)}`);
      runtime.prepareFailed = true;
      return false;
    }
  }

  private startWatching(runtime: AgentRuntime): void {
    if (runtime.stopWatching) {
      return;
    }
    runtime.stopWatching = runtime.agent.sessions?.watch?.(runtime.executable, this.project.path, () =>
      this.scheduleReconcile(runtime, WATCH_DEBOUNCE_MS)
    );
  }

  /**
   * Lets go of what this agent keeps running for a project that has no session and no tab of
   * it — but only if its own preparation says that is allowed (see releaseWhenIdle). The
   * watcher goes too: for opencode it is a subscription on the very server being stopped and
   * would bring it straight back up. ensurePrepared restores both.
   */
  private releaseIdleRuntime(runtime: AgentRuntime): void {
    if (!runtime.preparation?.releaseWhenIdle || this.tabsOf(runtime).length > 0) {
      return;
    }
    runtime.stopWatching?.();
    runtime.stopWatching = undefined;
    runtime.preparation.dispose();
    runtime.preparation = undefined;
    runtime.released = true;
  }

  /**
   * The agent's setup, brought back if it was released. Everything that spawns waits on this:
   * without the preparation the CLI would be started with the wrong arguments entirely.
   */
  private async ensurePrepared(runtime: AgentRuntime): Promise<void> {
    await runtime.ready;
    if (!runtime.released) {
      return;
    }
    if (await this.prepare(runtime)) {
      runtime.released = false;
      this.startWatching(runtime);
    }
  }

  createTab(agentId: AgentId): TerminalDescriptor {
    return this.addTab(agentId, {});
  }

  /**
   * A tab that runs one of the project's saved commands and ends with it. Its process *is* the
   * command, and the command is its label, since a shell tab has no session to take a title
   * from.
   *
   * The program is started directly, without a shell; `resolveCommand` is where the platform
   * difference is settled (a `.cmd` shim on win32 goes through cmd.exe). Only a command that
   * asked for a shell gets one, and then it is the same one the project's shell tabs use.
   */
  createCommandTab(command: ProjectCommand): TerminalDescriptor | undefined {
    const shared = {
      title: command.command,
      // `resolve` rather than `join`, so a folder that is already absolute is left alone.
      cwd: command.cwd ? path.resolve(this.project.path, command.cwd) : undefined,
      env: command.env
    };
    if (command.shell) {
      const runArgs = getAgent("shell").runArgs?.(command.command);
      return runArgs ? this.addTab("shell", { ...shared, runArgs }) : undefined;
    }
    const [executable, ...runArgs] = splitCommand(command.command);
    if (!executable) {
      return undefined;
    }
    // Shell syntax would reach the program as an ordinary argument — `rm x && y` would ask rm
    // to delete "&&" and "y". Said out loud rather than run: a file written when saved
    // commands still went through a shell is where such a line comes from.
    const operator = [executable, ...runArgs].find((token) => SHELL_OPERATOR.test(token));
    if (operator) {
      this.callbacks.onNotice(
        "error",
        `"${command.command}" cannot run: ${operator} is shell syntax, and a saved command is ` +
          `started without one. Split it into two commands, or add "shell": true to it in meezeek.json.`
      );
      return undefined;
    }
    return this.addTab("shell", { ...shared, executable, runArgs });
  }

  private addTab(agentId: AgentId, extra: Partial<TabState>): TerminalDescriptor {
    const runtime = this.runtimeFor(agentId);
    this.newTabCounter += 1;
    const tab: TabState = {
      tabId: `new-${this.newTabCounter}`,
      projectId: this.project.id,
      agentId,
      title: "",
      status: this.canStart(runtime) ? "ready" : "missing",
      ...extra
    };
    this.tabs.push(tab);
    this.postTabs();
    return toDescriptor(tab);
  }

  handleResize(tabId: string, cols: number, rows: number): void {
    const existing = this.sessions.get(tabId);
    if (existing) {
      existing.ensureStarted(cols, rows);
      return;
    }
    const tab = this.tabs.find((candidate) => candidate.tabId === tabId);
    if (!tab) {
      return;
    }
    // The agent's setup may still be running (version check, opencode's server). Remember
    // the size and start once it settles — the first resize is what spawns the process.
    const pending = this.starting.get(tabId);
    this.starting.set(tabId, { cols, rows });
    if (pending) {
      return;
    }
    // Bringing a released setup back can mean starting opencode's server, which takes
    // seconds — the bar under the tab strip is what says so.
    this.acquireIndicator();
    void this.ensurePrepared(this.runtimeFor(tab.agentId))
      .finally(() => this.releaseIndicator())
      .then(() => {
        const dims = this.starting.get(tabId);
        this.starting.delete(tabId);
        if (!dims || !this.tabs.includes(tab) || this.sessions.has(tabId)) {
          return;
        }
        this.startSession(tab).ensureStarted(dims.cols, dims.rows);
      });
  }

  private startSession(tab: TabState): TerminalSession {
    const runtime = this.runtimeFor(tab.agentId);
    const { agent, executable, preparation } = runtime;
    const resumeArgs = tab.sessionId && agent.sessions ? agent.sessions.resumeArgs(tab.sessionId) : [];
    const tabId = tab.tabId;

    // Called fresh per session, so each one's predicate starts counting from zero rather
    // than carrying over a previous session's already-passed state.
    let isSessionReady = agent.createIsSessionReady?.();
    const startedAt = Date.now();
    if (isSessionReady) {
      this.acquireIndicator();
    }
    const hideIndicator = (): void => {
      if (!isSessionReady) {
        return;
      }
      // Cleared before the delay, so a second call (e.g. the session stopping right after)
      // can't queue a second release.
      isSessionReady = undefined;
      setTimeout(() => this.releaseIndicator(), INDICATOR_LINGER_MS);
    };

    // A tab that brings its own program — a saved command's — is not this agent's process, so
    // nothing the agent itself would have been started with applies to it.
    const args = tab.executable
      ? (tab.runArgs ?? [])
      : [...(agent.args ?? []), ...(preparation?.args ?? []), ...resumeArgs, ...(tab.runArgs ?? [])];

    const session = new TerminalSession(
      tab.executable ?? executable,
      tab.cwd ?? this.project.path,
      { ...agent.env, ...preparation?.env },
      {
        onOutput: (data) => {
          this.callbacks.onOutput(this.project.id, tabId, data);
          // Only the shells: an agent tab's output is its own TUI redrawing itself.
          if (!agent.sessions) {
            this.shellContext.append(data);
          }
          if (isSessionReady?.(data, Date.now() - startedAt)) {
            hideIndicator();
          }
          // A CLI persists or updates its session shortly after producing output, so
          // reconciling once output settles adopts a fresh session id and picks up a title
          // the CLI generated for one it already had.
          this.scheduleReconcile(runtime);
        },
        onStatusChange: (status) => {
          tab.status = status;
          this.callbacks.onStatus(this.project.id, tabId, status);
          if (status === "stopped" || status === "error") {
            this.scheduleReconcile(runtime);
            // Safety net: the CLI may exit before ever producing enough output to cross the
            // heuristic above — don't leave the bar stuck up forever.
            hideIndicator();
          }
        }
      },
      args,
      tab.env
    );

    if (!tab.sessionId) {
      tab.spawnedAt = Date.now();
    }
    this.sessions.set(tabId, session);
    session.markInstalled(this.canStart(runtime));
    return session;
  }

  write(tabId: string, data: string): void {
    this.sessions.get(tabId)?.write(data);
  }

  /**
   * What full url a fragment on screen belongs to — see AgentDefinition.resolveUrlPrefix.
   * Undefined whenever it can't be answered (agent doesn't implement it, tab has no
   * session yet, or the lookup failed); the renderer caches that as "don't ask again".
   */
  async resolveUrlPrefix(tabId: string, prefix: string): Promise<string | undefined> {
    const tab = this.tabs.find((candidate) => candidate.tabId === tabId);
    if (!tab?.sessionId) {
      return undefined;
    }
    const { agent, executable } = this.runtimeFor(tab.agentId);
    if (!agent.resolveUrlPrefix) {
      return undefined;
    }
    try {
      return await agent.resolveUrlPrefix(executable, this.project.path, tab.sessionId, prefix);
    } catch {
      return undefined;
    }
  }

  /**
   * Closing a tab deletes the session behind it. Every tab is dropped from the UI up front;
   * the teardown then runs one tab at a time, to avoid concurrent CLI calls for
   * listing/removing sessions.
   */
  async closeTabs(tabIds: string[]): Promise<void> {
    const doomed = new Set(tabIds);
    const tabs = this.tabs.filter((tab) => doomed.has(tab.tabId));
    if (tabs.length === 0) {
      return;
    }
    const indices = new Map(tabs.map((tab) => [tab.tabId, this.tabs.indexOf(tab)]));
    this.tabs = this.tabs.filter((tab) => !doomed.has(tab.tabId));
    this.postTabs();

    for (const tab of tabs) {
      await this.destroyTab(tab, indices.get(tab.tabId) ?? this.tabs.length);
    }
    // Closing a tab deleted its session too, so this may have been the last thing keeping the
    // agent's setup up — the same state the project was in when it had nothing to show.
    for (const runtime of this.runtimes.values()) {
      this.releaseIdleRuntime(runtime);
    }
  }

  /**
   * Kills a removed tab's pty and deletes its persisted session; `index` is where the tab
   * sat before removal, used to put it back if the deletion fails.
   */
  private async destroyTab(tab: TabState, index: number): Promise<void> {
    const session = this.sessions.get(tab.tabId);
    if (session) {
      session.stop();
      this.sessions.delete(tab.tabId);
    }

    const { agent, executable } = this.runtimeFor(tab.agentId);
    if (!agent.sessions) {
      return;
    }
    if (!tab.sessionId && session) {
      // A fresh tab may have persisted a session already — claim its id so it gets deleted
      // too. Runs after the UI removal (the list call can take seconds); detachedTabs lets
      // reconcile match a tab we already spliced out.
      this.detachedTabs.push(tab);
      try {
        await this.reconcile(this.runtimeFor(tab.agentId));
      } finally {
        this.detachedTabs.splice(this.detachedTabs.indexOf(tab), 1);
      }
    }
    const sessionId = tab.sessionId;
    if (!sessionId) {
      return;
    }
    this.deletingSessionIds.add(sessionId);
    try {
      if (session) {
        await new Promise((resolve) => setTimeout(resolve, SESSION_REMOVE_DELAY_MS));
      }
      await agent.sessions.remove(executable, this.project.path, sessionId);
    } catch (error) {
      this.callbacks.onNotice("error", `Could not delete ${agent.displayName} session: ${String(error)}`);
      // The persisted session still exists — put its tab back.
      tab.status = "ready";
      this.tabs.splice(Math.min(index, this.tabs.length), 0, tab);
      this.postTabs();
    } finally {
      this.deletingSessionIds.delete(sessionId);
    }
  }

  /**
   * A tab without a sessionId yet has nothing persisted to rename (no transcript file, no
   * opencode row) — the renderer's optimistic label reverts to the placeholder in that case.
   */
  async renameTab(tabId: string, title: string): Promise<void> {
    const tab = this.tabs.find((candidate) => candidate.tabId === tabId);
    if (!tab) {
      return;
    }
    const { agent, executable } = this.runtimeFor(tab.agentId);
    if (!tab.sessionId || !agent.sessions) {
      this.postTabs();
      return;
    }
    const previousTitle = tab.title;
    try {
      await agent.sessions.rename(executable, this.project.path, tab.sessionId, title);
      tab.title = title.trim();
      // A name the user picked is final — nothing left for the polling below to wait for.
      tab.provisionalTitle = false;
    } catch (error) {
      this.callbacks.onNotice("error", `Could not rename ${agent.displayName} session: ${String(error)}`);
      tab.title = previousTitle;
    }
    this.postTabs();
  }

  /**
   * One of this project's sessions has finished a turn, as the agent itself reported it — see
   * AgentPaths.onSessionFinished. Whether the mark is *shown* is not decided here: the
   * renderer is the half that knows which tab is in front of the user.
   */
  private markFinished(runtime: AgentRuntime, sessionId: string): void {
    if (this.disposed || this.applyFinished(runtime, sessionId)) {
      return;
    }
    // No tab holds that id yet — a fresh tab whose first turn ended before the reconcile that
    // adopts its session ran, the common short-first-question case. Held rather than dropped,
    // and re-listed at once so the wait is as short as it can be.
    runtime.pendingFinished.add(sessionId);
    this.scheduleReconcile(runtime, 0);
  }

  private applyFinished(runtime: AgentRuntime, sessionId: string): boolean {
    const tab = this.tabsOf(runtime).find((candidate) => candidate.sessionId === sessionId);
    if (!tab) {
      return false;
    }
    tab.finishedAt = Date.now();
    this.postTabs();
    return true;
  }

  /**
   * The tab is in front of the user, so whatever was waiting on it has been seen. Nothing is
   * checked here: the renderer calls it for the active tab of the project on screen, which is
   * the one thing this process cannot know for itself.
   */
  markSeen(tabId: string): void {
    const tab = this.tabs.find((candidate) => candidate.tabId === tabId);
    if (tab?.finishedAt === undefined) {
      return;
    }
    tab.finishedAt = undefined;
    this.postTabs();
  }

  private scheduleReconcile(runtime: AgentRuntime, delayMs = RECONCILE_DEBOUNCE_MS): void {
    runtime.reconcileRetriesLeft = RECONCILE_MAX_RETRIES;
    // Only tabs whose label is unsettled need the mid-output reconcile; elsewhere the debounce
    // alone keeps the extra session listings out of a turn. A stand-in title counts as
    // unsettled — non-empty, but the agent can still replace it mid-turn.
    if (runtime.reconcileDeadline === undefined && this.tabsOf(runtime).some(titleUnsettled)) {
      runtime.reconcileDeadline = Date.now() + RECONCILE_MAX_WAIT_MS;
    }
    this.armReconcileTimer(runtime, delayMs);
  }

  private armReconcileTimer(runtime: AgentRuntime, delayMs: number): void {
    // The retry below re-arms this timer after every run, so a reconcile in flight when the
    // project closed would put a fresh one in place behind dispose's back — and opencode's
    // listing brings its server back up, leaving a process nobody owns.
    if (this.disposed) {
      return;
    }
    clearTimeout(runtime.reconcileTimer);
    const cappedDelay =
      runtime.reconcileDeadline === undefined
        ? delayMs
        : Math.min(delayMs, Math.max(0, runtime.reconcileDeadline - Date.now()));
    runtime.reconcileTimer = setTimeout(() => {
      runtime.reconcileDeadline = undefined;
      void this.reconcile(runtime).then(() => {
        if (runtime.reconcileRetriesLeft > 0) {
          runtime.reconcileRetriesLeft -= 1;
          this.armReconcileTimer(runtime, RECONCILE_RETRY_MS);
        }
      });
    }, cappedDelay);
  }

  private tabsOf(runtime: AgentRuntime): TabState[] {
    return this.tabs.filter((tab) => tab.agentId === runtime.agent.id);
  }

  /**
   * Re-lists one agent's sessions to (a) adopt real session ids/titles for fresh tabs whose
   * CLI has persisted a session since spawning, and (b) refresh titles of known tabs.
   */
  private reconcile(runtime: AgentRuntime): Promise<void> {
    // Serialized: a second call while one is in flight just waits for the first.
    runtime.reconciling ??= this.doReconcile(runtime).finally(() => {
      runtime.reconciling = undefined;
    });
    return runtime.reconciling;
  }

  private async doReconcile(runtime: AgentRuntime): Promise<void> {
    countActivity("reconcile");
    const { agent, executable } = runtime;
    // A released runtime has nothing to reconcile, and listing would start its server back up.
    // A disposed project is the same case: the listing is what would revive it.
    if (this.disposed || runtime.released || !agent.sessions || !this.canStart(runtime)) {
      return;
    }
    const infos = await agent.sessions.list(executable, this.project.path);
    const ownTabs = this.tabsOf(runtime);
    const claimed = new Set([
      ...ownTabs.map((tab) => tab.sessionId).filter((id) => id !== undefined),
      ...this.deletingSessionIds
    ]);
    const unclaimed = infos.filter((info) => !claimed.has(info.id));
    let changed = false;

    const pendingTabs = [...ownTabs, ...this.detachedTabs.filter((tab) => tab.agentId === agent.id)]
      .filter((tab) => !tab.sessionId && tab.spawnedAt !== undefined)
      .sort((a, b) => (b.spawnedAt ?? 0) - (a.spawnedAt ?? 0));
    for (const tab of pendingTabs) {
      const match = unclaimed.find((info) => info.updatedAt > (tab.spawnedAt ?? 0));
      if (!match) {
        continue;
      }
      unclaimed.splice(unclaimed.indexOf(match), 1);
      tab.sessionId = match.id;
      tab.title = match.title;
      tab.updatedAt = match.updatedAt;
      tab.createdAt = match.createdAt;
      tab.provisionalTitle = match.provisionalTitle;
      // Detached tabs are gone from the UI — claiming their id is all that's needed.
      changed ||= this.tabs.includes(tab);
    }

    for (const tab of ownTabs) {
      if (!tab.sessionId) {
        continue;
      }
      const info = infos.find((candidate) => candidate.id === tab.sessionId);
      if (!info) {
        continue;
      }
      // Tracked even when the label itself is unchanged: an assigned name can read the same
      // as the stand-in it replaces, and that still ends the polling above.
      tab.provisionalTitle = info.provisionalTitle;
      if (info.title !== tab.title || info.updatedAt !== tab.updatedAt) {
        tab.title = info.title;
        tab.updatedAt = info.updatedAt;
        changed = true;
      }
    }

    // Turns reported before their tab had claimed the session — see markFinished. One gone
    // from the listing is dropped rather than waited on: no tab will claim an id no session
    // has any more, and that is what bounds this set.
    for (const sessionId of runtime.pendingFinished) {
      const tab = ownTabs.find((candidate) => candidate.sessionId === sessionId);
      if (tab) {
        tab.finishedAt = Date.now();
        runtime.pendingFinished.delete(sessionId);
        changed = true;
      } else if (!infos.some((info) => info.id === sessionId)) {
        runtime.pendingFinished.delete(sessionId);
      }
    }

    if (changed) {
      this.postTabs();
    }
  }

  dispose(): void {
    // Read by the reconcile loop, whose calls can outlive this and would otherwise arm
    // themselves again — see armReconcileTimer.
    this.disposed = true;
    this.shellContext.dispose();
    for (const runtime of this.runtimes.values()) {
      clearTimeout(runtime.reconcileTimer);
      runtime.stopWatching?.();
      runtime.stopWatching = undefined;
    }
    for (const session of this.sessions.values()) {
      session.stop();
    }
    this.sessions.clear();
    // Last: the sessions above may still be talking to whatever it set up.
    for (const runtime of this.runtimes.values()) {
      runtime.preparation?.dispose();
      runtime.preparation = undefined;
    }
  }
}

/** The open projects' session managers. */
export class SessionManagerRegistry {
  private readonly managers = new Map<string, ProjectSessionManager>();

  constructor(
    private readonly storageRoot: string,
    private readonly settings: SettingsStore,
    private readonly callbacks: SessionManagerCallbacks
  ) {}

  open(project: Project): ProjectSessionManager {
    const existing = this.managers.get(project.id);
    if (existing) {
      return existing;
    }
    const manager = new ProjectSessionManager(project, this.storageRoot, this.settings, this.callbacks);
    this.managers.set(project.id, manager);
    void manager.bootstrap();
    return manager;
  }

  get(projectId: string): ProjectSessionManager | undefined {
    return this.managers.get(projectId);
  }

  close(projectId: string): void {
    this.managers.get(projectId)?.dispose();
    this.managers.delete(projectId);
  }

  disposeAll(): void {
    for (const manager of this.managers.values()) {
      manager.dispose();
    }
    this.managers.clear();
  }
}
