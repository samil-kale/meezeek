import { useCallback, useEffect, useState } from "react";
import type { CheckoutTarget, Project, RepositoryState } from "../shared/types";
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
  const [error, setError] = useState<string | null>(null);
  // Defaults and limits of the draggable panes. Every project's git tab shares the two below,
  // so they are held here rather than in each of them.
  const [sidebarWidth, setSidebarWidth] = usePaneSize("sidebar", 240);
  const [gitPanelsWidth, setGitPanelsWidth] = usePaneSize("git-panels", 300);
  const [branchTreeHeight, setBranchTreeHeight] = usePaneSize("branch-tree", 260);

  useEffect(() => {
    const unsubscribe = window.meeseex.repository.onState(({ projectId, state }) =>
      setStates((current) => ({ ...current, [projectId]: state }))
    );

    void (async () => {
      const stored = await window.meeseex.projects.list();
      setProjects(stored);
      setActiveProjectId((current) => current ?? stored[0]?.id ?? null);
      const loaded = await Promise.all(
        stored.map(async (project) => [project.id, await window.meeseex.repository.state(project.id)] as const)
      );
      // States pushed while this was in flight are newer than what was just fetched.
      setStates((current) => ({ ...Object.fromEntries(loaded), ...current }));
    })();

    return unsubscribe;
  }, []);

  useEffect(() => window.meeseex.onNotice(({ message }) => setError(message)), []);

  const addProject = useCallback(async () => {
    const project = await window.meeseex.projects.add();
    if (!project) {
      return;
    }
    setProjects((current) => (current.some((entry) => entry.id === project.id) ? current : [...current, project]));
    setActiveProjectId(project.id);
  }, []);

  const closeProject = useCallback(
    async (projectId: string) => {
      await window.meeseex.projects.remove(projectId);
      const remaining = projects.filter((project) => project.id !== projectId);
      setProjects(remaining);
      setActiveProjectId((current) => (current === projectId ? (remaining[0]?.id ?? null) : current));
    },
    [projects]
  );

  const checkout = useCallback(async (projectId: string, target: CheckoutTarget) => {
    const result = await window.meeseex.repository.checkout(projectId, target);
    setError(result.ok ? null : (result.error ?? "Checkout failed"));
  }, []);

  const refresh = useCallback(() => {
    if (activeProjectId) {
      void window.meeseex.repository.refresh(activeProjectId);
    }
  }, [activeProjectId]);

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeState = (activeProjectId ? states[activeProjectId] : undefined) ?? EMPTY_STATE;

  return (
    <div className="app">
      {/* Just the app name; the bar itself is the drag region and the space the window
          controls overlay needs. */}
      <div className="titlebar">
        <span className="titlebar-name">MEESEEX</span>
      </div>

      <div className="body">
        <ProjectList
          projects={projects}
          activeProjectId={activeProjectId}
          width={sidebarWidth}
          onSelect={setActiveProjectId}
          onClose={(projectId) => void closeProject(projectId)}
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
              onCheckout={(target) => void checkout(project.id, target)}
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

      {error && (
        <button className="banner" onClick={() => setError(null)} title="Dismiss">
          {error}
        </button>
      )}

      <div className="branch-bar">
        {activeProject && activeState.error && <span className="branch-error">{activeState.error}</span>}
        {activeProject && !activeState.error && (
          <>
            <BranchIcon />
            <span className="branch-name">{activeState.head || "..."}</span>
            <button className="icon-button" title="Refresh repository" onClick={refresh}>
              <RefreshIcon />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
