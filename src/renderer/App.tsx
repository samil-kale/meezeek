import { useCallback, useEffect, useRef, useState } from "react";
import type { CheckoutTarget, GitActionResult, Project, RepositoryState } from "../shared/types";
import { Dialogs } from "./components/Dialog";
import { Notices, notify } from "./components/Notices";
import { ProjectList } from "./components/ProjectList";
import { Sash, usePaneSize } from "./components/Sash";
import { TerminalsPane } from "./components/TerminalsPane";
import { BranchIcon, PlusIcon, RefreshIcon } from "./components/icons";

const EMPTY_STATE: RepositoryState = {
  head: "",
  detached: false,
  localBranches: [],
  remotes: [],
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

  /** The whole branch menu of one project, in the shape the git tab takes it. */
  const branchActions = useCallback(
    (projectId: string) => ({
      busy: branchAction?.projectId === projectId,
      checkout: (target: CheckoutTarget) =>
        void runBranchAction(projectId, `Switching to ${target.name}...`, () =>
          window.meeseek.repository.checkout(projectId, target)
        ),
      create: (name: string, startPoint?: string) =>
        void runBranchAction(projectId, `Creating ${name}...`, () =>
          window.meeseek.repository.createBranch(projectId, name, startPoint)
        ),
      rename: (from: string, to: string) =>
        void runBranchAction(projectId, `Renaming ${from} to ${to}...`, () =>
          window.meeseek.repository.renameBranch(projectId, from, to)
        ),
      remove: (name: string, remote?: string) =>
        void runBranchAction(projectId, `Deleting ${name}...`, () =>
          window.meeseek.repository.deleteBranch(projectId, name, remote)
        )
    }),
    [branchAction, runBranchAction]
  );

  const refresh = useCallback(() => {
    if (activeProjectId) {
      void window.meeseek.repository.refresh(activeProjectId);
    }
  }, [activeProjectId]);

  const busyLabel = branchAction?.projectId === activeProjectId ? branchAction.label : null;
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeState = (activeProjectId ? states[activeProjectId] : undefined) ?? EMPTY_STATE;

  return (
    <div className="app">
      {/* Just the app name; the bar itself is the drag region and the space the window
          controls overlay needs. */}
      <div className="titlebar">
        <span className="titlebar-name">MEESEEK</span>
      </div>

      <div className="body">
        <ProjectList
          projects={projects}
          activeProjectId={activeProjectId}
          width={sidebarWidth}
          onSelect={setActiveProjectId}
          onClose={(projectId) => void closeProject(projectId)}
          onReorder={reorderProjects}
          onAdd={() => void addProject()}
        />
        <Sash orientation="vertical" size={sidebarWidth} min={140} minOther={320} onResize={setSidebarWidth} />

        <main className="content">
          {/* Every project's terminals stay mounted so switching project keeps their buffers
              and running processes untouched. */}
          {projects.map((project) => (
            <TerminalsPane
              key={project.id}
              project={project}
              visible={project.id === activeProjectId}
              state={states[project.id] ?? EMPTY_STATE}
              gitSizes={{
                panelsWidth: gitPanelsWidth,
                onPanelsWidth: setGitPanelsWidth,
                treeHeight: branchTreeHeight,
                onTreeHeight: setBranchTreeHeight
              }}
              branch={branchActions(project.id)}
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

      <Notices />
      <Dialogs />

      <div className="branch-bar">
        {/* A repository that could not be read says so as a notice like everything else; the
            bar then simply has no branch to name. */}
        {activeProject && (
          <>
            <BranchIcon />
            {/* While a branch command runs the bar says what it is doing instead of naming
                HEAD — for those seconds the branch you are on is not the whole story. */}
            <span className={`branch-name${busyLabel === null ? "" : " busy"}`}>
              {busyLabel ?? (activeState.head || "...")}
            </span>
            <button className="icon-button" title="Refresh repository" onClick={refresh}>
              <RefreshIcon />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
