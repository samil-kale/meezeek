import { useCallback, useEffect, useState } from "react";
import type { CheckoutTarget, Project, RepositoryState, ViewId } from "../shared/types";
import { ChangesView } from "./components/ChangesView";
import { ProjectTabs } from "./components/ProjectTabs";
import { Sidebar } from "./components/Sidebar";
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
  const [views, setViews] = useState<Record<string, ViewId>>({});
  const [states, setStates] = useState<Record<string, RepositoryState>>({});
  const [error, setError] = useState<string | null>(null);

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

  const checkout = useCallback(
    async (target: CheckoutTarget) => {
      if (!activeProjectId) {
        return;
      }
      const result = await window.meeseex.repository.checkout(activeProjectId, target);
      setError(result.ok ? null : (result.error ?? "Checkout failed"));
    },
    [activeProjectId]
  );

  const refresh = useCallback(() => {
    if (activeProjectId) {
      void window.meeseex.repository.refresh(activeProjectId);
    }
  }, [activeProjectId]);

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeState = (activeProjectId ? states[activeProjectId] : undefined) ?? EMPTY_STATE;
  const activeView = (activeProjectId ? views[activeProjectId] : undefined) ?? "terminals";

  return (
    <div className="app">
      <div className="titlebar">
        <ProjectTabs
          projects={projects}
          activeProjectId={activeProjectId}
          onSelect={setActiveProjectId}
          onClose={(projectId) => void closeProject(projectId)}
          onAdd={() => void addProject()}
        />
      </div>

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

      <div className="body">
        <Sidebar
          state={activeState}
          view={activeView}
          onSelectView={(view) => {
            if (activeProjectId) {
              setViews((current) => ({ ...current, [activeProjectId]: view }));
            }
          }}
          onCheckout={(target) => void checkout(target)}
          disabled={!activeProject}
        />

        <main className="content">
          {/* Every project's terminals stay mounted so switching view or project keeps their
              buffers and running processes untouched. */}
          {projects.map((project) => (
            <TerminalsPane
              key={project.id}
              project={project}
              visible={project.id === activeProjectId && (views[project.id] ?? "terminals") === "terminals"}
            />
          ))}
          {activeProject && activeView === "changes" && (
            <ChangesView project={activeProject} changes={activeState.changes} />
          )}
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
    </div>
  );
}
