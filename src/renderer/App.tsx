import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_REPOSITORY_STATE } from "../shared/types";
import type { GitActionResult, Project, RepositoryState } from "../shared/types";
import { AddRepositoryDialog } from "./components/AddRepositoryDialog";
import { BranchBar } from "./components/BranchBar";
import { CommandList } from "./components/CommandList";
import type { BranchActions } from "./components/BranchTree";
import { DiffDialog } from "./components/DiffDialog";
import { Dialogs } from "./components/Dialog";
import { GitPane } from "./components/GitPane";
import { Notices, notify } from "./components/Notices";
import { ProjectList } from "./components/ProjectList";
import { Sash, usePaneSize, usePaneToggle } from "./components/Sash";
import { TerminalsPane } from "./components/TerminalsPane";
import { disposeProjectTerminals } from "./terminal-views";
import { PlusIcon } from "./components/icons";

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
  /** Whether the add-repository dialog (clone, add, create) is up. */
  const [addOpen, setAddOpen] = useState(false);
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

  /** What the add-repository dialog ends in, whichever of its tabs produced the project. */
  const projectAdded = useCallback((project: Project) => {
    setProjects((current) => (current.some((entry) => entry.id === project.id) ? current : [...current, project]));
    setActiveProjectId(project.id);
  }, []);

  const closeProject = useCallback(
    async (projectId: string) => {
      await window.meeseek.projects.remove(projectId);
      const remaining = projects.filter((project) => project.id !== projectId);
      setProjects(remaining);
      setActiveProjectId((current) => (current === projectId ? (remaining[0]?.id ?? null) : current));
      // The xterm instances live outside React and outlive the pane that mounted them, so
      // this is where they are let go of — the one moment a project ends for good.
      disposeProjectTerminals(projectId);
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
  const activeState = (activeProjectId ? states[activeProjectId] : undefined) ?? EMPTY_REPOSITORY_STATE;

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
            onAdd={() => setAddOpen(true)}
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
              <button className="button" onClick={() => setAddOpen(true)}>
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

      {addOpen && <AddRepositoryDialog onAdded={projectAdded} onClose={() => setAddOpen(false)} />}

      <Notices />
      <Dialogs />

      <BranchBar
        project={activeProject}
        state={activeState}
        busyLabel={busyLabel}
        run={(label, action) => {
          if (activeProjectId) {
            void runBranchAction(activeProjectId, label, action);
          }
        }}
        onRefresh={refresh}
      />
    </div>
  );
}
