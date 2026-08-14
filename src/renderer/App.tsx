import { useCallback, useEffect, useRef, useState } from "react";
import type { GitActionResult, Project, RepositoryState } from "../shared/types";
import { CommandList } from "./components/CommandList";
import type { BranchActions } from "./components/BranchTree";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "./components/ContextMenu";
import { DiffDialog } from "./components/DiffDialog";
import { Dialogs, confirm } from "./components/Dialog";
import { GitPane } from "./components/GitPane";
import { Notices, notify } from "./components/Notices";
import { ProjectList } from "./components/ProjectList";
import { Sash, usePaneSize, usePaneToggle } from "./components/Sash";
import { TerminalsPane } from "./components/TerminalsPane";
import { ArrowDownIcon, ArrowUpIcon, BranchIcon, PlusIcon, RefreshIcon, SyncIcon } from "./components/icons";

const EMPTY_STATE: RepositoryState = {
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

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, RepositoryState>>({});
  /**
   * The branch command in flight, if any, and what to call it while it runs — a checkout can
   * take seconds on a large repository, and deleting on a remote goes to the network.
   */
  const [branchAction, setBranchAction] = useState<{ projectId: string; label: string } | null>(null);
  /** The same, read synchronously: a second double-click can land before a re-render does. */
  const branchActionRef = useRef<{ projectId: string; label: string } | null>(null);
  // Defaults and limits of the draggable panes. Every project's git tab shares the two below,
  // so they are held here rather than in each of them.
  const [sidebarWidth, setSidebarWidth] = usePaneSize("sidebar", 240);
  const [gitPanelsWidth, setGitPanelsWidth] = usePaneSize("git-panels", 300);
  const [branchTreeHeight, setBranchTreeHeight] = usePaneSize("branch-tree", 260);
  // 40% of the window it first opens in.
  const [commandsHeight, setCommandsHeight] = usePaneSize("commands", Math.round(window.innerHeight * 0.4));
  /**
   * Whether the git pane is out. Closed until it is asked for — the terminals are what the
   * window is for, and the repository is something you look at now and then. Remembered like
   * a pane size, since it is one.
   */
  const [gitOpen, setGitOpen] = usePaneToggle("git-pane", false);
  /** The git pane or an open diff is working; the active project's bar reports it. */
  const [gitBusy, setGitBusy] = useState(false);
  /** The file whose diff is open over everything, if any. */
  const [diffFile, setDiffFile] = useState<{ projectId: string; path: string } | null>(null);
  /** The sync button's own menu: the variants of what it does, for when its pick is not the one. */
  const [syncMenu, setSyncMenu] = useState<{ x: number; y: number } | null>(null);
  /**
   * A tab that was just opened from outside its own pane — a shell asked for from a project's
   * row, or the terminal a saved command runs in. The pane brings it to the front once it
   * arrives; a tab id is only ever created once, so it acts exactly once.
   */
  const [openedTab, setOpenedTab] = useState<{ projectId: string; tabId: string } | null>(null);

  useEffect(() => {
    const unsubscribe = window.meeseek.repository.onState(({ projectId, state }) =>
      setStates((current) => ({ ...current, [projectId]: state }))
    );

    void (async () => {
      const stored = await window.meeseek.projects.list();
      setProjects(stored);
      setActiveProjectId((current) => current ?? stored[0]?.id ?? null);
      const loaded = await Promise.all(
        stored.map(async (project) => [project.id, await window.meeseek.repository.state(project.id)] as const)
      );
      // States pushed while this was in flight are newer than what was just fetched.
      setStates((current) => ({ ...Object.fromEntries(loaded), ...current }));
    })();

    return unsubscribe;
  }, []);

  useEffect(() => window.meeseek.onNotice(({ severity, message }) => notify(severity, message)), []);

  const addProject = useCallback(async () => {
    const project = await window.meeseek.projects.add();
    if (!project) {
      return;
    }
    setProjects((current) => (current.some((entry) => entry.id === project.id) ? current : [...current, project]));
    setActiveProjectId(project.id);
  }, []);

  const closeProject = useCallback(
    async (projectId: string) => {
      await window.meeseek.projects.remove(projectId);
      const remaining = projects.filter((project) => project.id !== projectId);
      setProjects(remaining);
      setActiveProjectId((current) => (current === projectId ? (remaining[0]?.id ?? null) : current));
    },
    [projects]
  );

  const reorderProjects = useCallback((ordered: Project[]) => {
    setProjects(ordered);
    void window.meeseek.projects.reorder(ordered.map((project) => project.id));
  }, []);

  /**
   * Runs one branch command per project at a time. Clicking a second branch while the first
   * switch runs would stack two `git switch` on one repository; the branch tree says so with
   * its cursor, and this is what enforces it. Per project, since two repositories working at
   * once is not a conflict at all.
   */
  const runBranchAction = useCallback(
    async (projectId: string, label: string, action: () => Promise<GitActionResult>) => {
      if (branchActionRef.current?.projectId === projectId) {
        return;
      }
      // Which project is working, not just that one is: the bar shows the active project, and
      // that may not be the one still busy when the user moves on.
      const started = { projectId, label };
      branchActionRef.current = started;
      setBranchAction(started);
      try {
        const result = await action();
        if (!result.ok) {
          notify("error", result.error ?? `${label} failed`);
        }
      } finally {
        branchActionRef.current = null;
        setBranchAction(null);
      }
    },
    []
  );

  /** What the git pane may start, in the shape its views take it. */
  const branchActions = useCallback(
    (projectId: string): BranchActions => ({
      busy: branchAction?.projectId === projectId,
      run: (label, action) => void runBranchAction(projectId, label, action)
    }),
    [branchAction, runBranchAction]
  );

  /** Shows a tab something outside the terminals pane opened: its project, then the tab. */
  const showTab = useCallback((projectId: string, tabId: string) => {
    setActiveProjectId(projectId);
    setOpenedTab({ projectId, tabId });
  }, []);

  /** Opens a shell tab in that project, which is what a project row offers as "terminal". */
  const openTerminal = useCallback(
    (projectId: string) => {
      void window.meeseek.terminals.create(projectId, "shell").then((tab) => showTab(projectId, tab.tabId));
    },
    [showTab]
  );

  const refresh = useCallback(() => {
    if (activeProjectId) {
      void window.meeseek.repository.refresh(activeProjectId);
    }
  }, [activeProjectId]);

  const busyLabel = branchAction?.projectId === activeProjectId ? branchAction.label : null;
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeState = (activeProjectId ? states[activeProjectId] : undefined) ?? EMPTY_STATE;

  /**
   * The one button GitHub Desktop puts here, and the same rules for what it does: publish a
   * branch the remote has never seen, then pull what came in, then push what went out, and
   * fetch when the two agree. One thing to press, whatever the state of the branch is.
   */
  const sync = ((): { label: string; title: string; icon: React.ReactNode; run: () => void } | null => {
    const remote = activeState.remotes[0]?.name;
    if (!activeProjectId || !remote || activeState.detached) {
      return null;
    }
    const start = (label: string, call: (projectId: string) => Promise<GitActionResult>) => () =>
      void runBranchAction(activeProjectId, `${label}...`, () => call(activeProjectId));
    if (activeState.upstream === undefined) {
      return {
        label: "Publish branch",
        title: `Push ${activeState.head} to ${remote} and track it`,
        icon: <ArrowUpIcon />,
        run: start("Publishing", window.meeseek.repository.push)
      };
    }
    if (activeState.behind > 0) {
      return {
        label: `Pull ${remote}`,
        title: `Pull ${activeState.behind} commits from ${activeState.upstream}`,
        icon: <ArrowDownIcon />,
        run: start("Pulling", window.meeseek.repository.pull)
      };
    }
    if (activeState.ahead > 0) {
      return {
        label: `Push ${remote}`,
        title: `Push ${activeState.ahead} commits to ${activeState.upstream}`,
        icon: <ArrowUpIcon />,
        run: start("Pushing", window.meeseek.repository.push)
      };
    }
    return {
      label: `Fetch ${remote}`,
      title: `Fetch from ${remote}`,
      icon: <SyncIcon />,
      run: start("Fetching", window.meeseek.repository.fetch)
    };
  })();

  /** Rewrites what the remote holds, which is why it is the one entry that asks first. */
  const askForcePush = async (projectId: string): Promise<void> => {
    const answer = await confirm({
      title: "Force push",
      message: `Are you sure you want to force push ${activeState.head} to ${activeState.upstream}?`,
      detail:
        "Commits the remote has and this branch does not are overwritten. The push is refused if the remote moved since the last fetch.",
      confirmLabel: "Force push"
    });
    if (answer.confirmed) {
      void runBranchAction(projectId, "Force pushing...", () => window.meeseek.repository.forcePush(projectId));
    }
  };

  /**
   * The other things that one button could have done. GitHub Desktop keeps them in its
   * Repository menu; meeseek has no menu bar, so they sit on the button itself.
   */
  const syncEntries = (projectId: string): ContextMenuEntry[] => {
    const start = (label: string, call: (projectId: string) => Promise<GitActionResult>) => () =>
      void runBranchAction(projectId, `${label}...`, () => call(projectId));
    // Without an upstream there is nothing to pull from and nothing to rewrite; publishing it
    // is what the button itself offers then.
    const tracked = activeState.upstream !== undefined;
    return [
      { label: "Fetch", run: start("Fetching", window.meeseek.repository.fetch) },
      SEPARATOR,
      { label: "Pull", run: tracked ? start("Pulling", window.meeseek.repository.pull) : undefined },
      {
        label: "Pull with rebase",
        run: tracked ? start("Pulling", window.meeseek.repository.pullRebase) : undefined
      },
      SEPARATOR,
      { label: "Push", run: start("Pushing", window.meeseek.repository.push) },
      { label: "Force push...", run: tracked ? () => void askForcePush(projectId) : undefined }
    ];
  };

  return (
    <div className="app">
      {/* Just the app name; the bar itself is the drag region and the space the window
          controls overlay needs. */}
      <div className="titlebar">
        <img className="titlebar-icon" src="icon.png" alt="" />
        <span className="titlebar-name">MEESEEK</span>
      </div>

      <div className="body">
        {/* Projects on top, the selected one's saved commands below them. */}
        <div className="sidebar" style={{ width: sidebarWidth }}>
          <ProjectList
            projects={projects}
            activeProjectId={activeProjectId}
            onSelect={setActiveProjectId}
            onClose={(projectId) => void closeProject(projectId)}
            onReorder={reorderProjects}
            onAdd={() => void addProject()}
            remoteOf={(projectId) => states[projectId]?.remotes[0]}
            onOpenTerminal={openTerminal}
          />
          <Sash
            orientation="horizontal"
            size={commandsHeight}
            min={60}
            minOther={100}
            reverse
            onResize={setCommandsHeight}
          />
          <CommandList projectId={activeProjectId} height={commandsHeight} onOpenTab={showTab} />
        </div>
        <Sash orientation="vertical" size={sidebarWidth} min={140} minOther={320} onResize={setSidebarWidth} />

        {/* The repository of the active project, between the navigation and its terminals.
            One pane for all of them, unlike the terminals: it holds no state a project would
            lose by being switched away from. */}
        {gitOpen && activeProject && (
          <>
            <div className="git-pane-host" style={{ width: gitPanelsWidth }}>
              <GitPane
                project={activeProject}
                state={activeState}
                branch={branchActions(activeProject.id)}
                treeHeight={branchTreeHeight}
                onTreeHeight={setBranchTreeHeight}
                onOpenDiff={(path) => setDiffFile({ projectId: activeProject.id, path })}
                onBusy={setGitBusy}
              />
            </div>
            <Sash
              orientation="vertical"
              size={gitPanelsWidth}
              min={180}
              minOther={320}
              onResize={setGitPanelsWidth}
            />
          </>
        )}

        <main className="content">
          {/* Every project's terminals stay mounted so switching project keeps their buffers
              and running processes untouched. */}
          {projects.map((project) => (
            <TerminalsPane
              key={project.id}
              project={project}
              visible={project.id === activeProjectId}
              gitOpen={gitOpen}
              onToggleGit={() => setGitOpen(!gitOpen)}
              externalBusy={branchAction?.projectId === project.id || (project.id === activeProjectId && gitBusy)}
              onOpenDiff={(path) => setDiffFile({ projectId: project.id, path })}
              openedTabId={openedTab?.projectId === project.id ? openedTab.tabId : null}
            />
          ))}
          {!activeProject && (
            <div className="empty-workspace">
              <p>No repository open.</p>
              <button className="button" onClick={() => void addProject()}>
                <PlusIcon />
                <span>Add repository</span>
              </button>
            </div>
          )}
        </main>
      </div>

      {/* Over everything, and only ever one: a diff is looked at and then left again. It
          reloads with the repository state, so an agent editing the file updates it. */}
      {diffFile && (
        <DiffDialog
          projectId={diffFile.projectId}
          path={diffFile.path}
          version={states[diffFile.projectId]?.changes}
          onClose={() => setDiffFile(null)}
          onBusy={setGitBusy}
        />
      )}

      <Notices />
      <Dialogs />

      <div className="branch-bar">
        {/* A repository that could not be read says so as a notice like everything else; the
            bar then simply has no branch to name. */}
        {activeProject && (
          <>
            {/* Left, where a status bar puts what you are looking at; everything that acts on
                it stays on the right. */}
            <span className="branch-path" title={activeProject.path}>
              {activeProject.path}
            </span>
            <BranchIcon />
            {/* While a branch command runs the bar says what it is doing instead of naming
                HEAD — for those seconds the branch you are on is not the whole story. */}
            <span className={`branch-name${busyLabel === null ? "" : " busy"}`}>
              {busyLabel ?? (activeState.head || "...")}
            </span>
            {/* How far HEAD and its upstream have drifted apart, only where they have. */}
            {activeState.ahead > 0 && (
              <span className="branch-count" title={`${activeState.ahead} commits to push`}>
                <ArrowUpIcon />
                {activeState.ahead}
              </span>
            )}
            {activeState.behind > 0 && (
              <span className="branch-count" title={`${activeState.behind} commits to pull`}>
                <ArrowDownIcon />
                {activeState.behind}
              </span>
            )}
            {sync && (
              <button
                className="branch-sync"
                title={`${sync.title}\nRight-click for the other network commands`}
                disabled={busyLabel !== null}
                onClick={sync.run}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setSyncMenu({ x: event.clientX, y: event.clientY });
                }}
              >
                {sync.icon}
                <span>{sync.label}</span>
              </button>
            )}
            <button className="icon-button" title="Refresh repository" onClick={refresh}>
              <RefreshIcon />
            </button>
          </>
        )}
      </div>

      {syncMenu && activeProjectId && (
        <ContextMenu
          x={syncMenu.x}
          y={syncMenu.y}
          entries={syncEntries(activeProjectId)}
          onClose={() => setSyncMenu(null)}
        />
      )}
    </div>
  );
}
