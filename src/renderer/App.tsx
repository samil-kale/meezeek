import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_REPOSITORY_STATE } from "../shared/types";
import type { GitActionResult, Project, RepositoryState, TerminalDescriptor } from "../shared/types";
import { AddRepositoryDialog } from "./components/AddRepositoryDialog";
import { BranchBar } from "./components/BranchBar";
import { CommandList } from "./components/CommandList";
import type { BranchActions } from "./components/BranchTree";
import { DiffDialog } from "./components/DiffDialog";
import { Dialogs } from "./components/Dialog";
import { GitPane } from "./components/GitPane";
import { Notices, notify } from "./components/Notices";
import { ProjectList } from "./components/ProjectList";
import { SettingsDialog } from "./components/SettingsDialog";
import {
  MIN_CONTENT_WIDTH,
  MIN_PANE_HEIGHT,
  MIN_PANE_WIDTH,
  Sash,
  usePaneSize,
  usePaneToggle
} from "./components/Sash";
import { TerminalsPane } from "./components/TerminalsPane";
import { disposeProjectTerminals } from "./terminal-views";
import { GearIcon, PlusIcon } from "./components/icons";

/** A little over `.git-pane-host.sliding`'s 0.15s, so the class outlives the transition. */
const GIT_SLIDE_MS = 180;

/**
 * A copy of one of the per-project records without that project in it. Nothing pushes anything
 * for a closed project, so what was mirrored of it has to be dropped by hand — and a folder
 * opened again gets the same id, which would otherwise show its own stale tabs for a frame,
 * marks and all.
 */
function forget<T>(record: Record<string, T>, projectId: string): Record<string, T> {
  const rest = { ...record };
  delete rest[projectId];
  return rest;
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, RepositoryState>>({});
  /**
   * Every project's terminal tabs, held here rather than in each pane for the same reason the
   * repository states above are: the project list needs all of them at once. What it takes
   * from them is `finishedAt` — the sessions that finished while nobody was looking.
   */
  const [tabs, setTabs] = useState<Record<string, TerminalDescriptor[]>>({});
  /** Which tab each pane has in front; a pane still owns its own selection and reports it here. */
  const [activeTabs, setActiveTabs] = useState<Record<string, string | null>>({});
  /**
   * The branch command in flight, if any, and what to call it while it runs — a checkout can
   * take seconds on a large repository, and deleting on a remote goes to the network.
   */
  const [branchAction, setBranchAction] = useState<{ projectId: string; label: string } | null>(null);
  /** The same, read synchronously: a second double-click can land before a re-render does. */
  const branchActionRef = useRef<{ projectId: string; label: string } | null>(null);
  // Defaults and limits of the draggable panes. Every project's git tab shares the two below,
  // so they are held here rather than in each of them.
  const [sidebarWidth, setSidebarWidth] = usePaneSize("sidebar", 240, MIN_PANE_WIDTH);
  const [gitPanelsWidth, setGitPanelsWidth] = usePaneSize("git-panels", 300, MIN_PANE_WIDTH);
  const [branchTreeHeight, setBranchTreeHeight] = usePaneSize("branch-tree", 260, MIN_PANE_HEIGHT);
  // 40% of the window it first opens in.
  const [commandsHeight, setCommandsHeight] = usePaneSize(
    "commands",
    Math.round(window.innerHeight * 0.4),
    MIN_PANE_HEIGHT
  );
  /**
   * Whether the git pane is out. Closed until it is asked for, and remembered like a pane
   * size, since it is one.
   */
  const [gitOpen, setGitOpen] = usePaneToggle("git-pane", false);
  /**
   * Drives the slide: `gitMounted` keeps the pane in the DOM through the closing transition,
   * `gitExpanded` is what the width transition animates. Opening flips `gitExpanded` only once
   * the browser has painted the freshly mounted, still-0-width frame — a single
   * `requestAnimationFrame` fires before that paint as often as after it, which made opening
   * jump straight to full width; two nested ones wait it out reliably. Closing reverses that
   * and unmounts once the transition has had time to finish.
   */
  const [gitMounted, setGitMounted] = useState(gitOpen);
  const [gitExpanded, setGitExpanded] = useState(gitOpen);
  /**
   * Whether that slide is running right now, which is what `.git-pane-host.sliding` transitions
   * on. The transition may not stay on the pane: the sash sets the very same width, and an
   * animated one lags the pointer by its whole duration.
   */
  const [gitSliding, setGitSliding] = useState(false);
  useEffect(() => {
    setGitSliding(true);
    let stop: ReturnType<typeof setTimeout> | undefined;
    if (gitOpen) {
      setGitMounted(true);
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => {
          setGitExpanded(true);
          stop = setTimeout(() => setGitSliding(false), GIT_SLIDE_MS);
        });
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
        clearTimeout(stop);
      };
    }
    setGitExpanded(false);
    stop = setTimeout(() => {
      setGitMounted(false);
      setGitSliding(false);
    }, GIT_SLIDE_MS);
    return () => clearTimeout(stop);
  }, [gitOpen]);
  /** The git pane or an open diff is working; the active project's bar reports it. */
  const [gitBusy, setGitBusy] = useState(false);
  /** The file whose diff is open over everything, if any. */
  const [diffFile, setDiffFile] = useState<{ projectId: string; path: string } | null>(null);
  /** Whether the add-repository dialog (clone, add, create) is up. */
  const [addOpen, setAddOpen] = useState(false);
  /** Whether the settings are up; they belong to the window, not to a project. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * A tab that was just opened from outside its own pane — a shell asked for from a project's
   * row, the terminal a saved command runs in, or the session a project row's mark points at.
   * The pane brings it to the front once it arrives. The nonce is what lets the *same* tab be
   * asked for twice: a session the mark already took the user to can finish again later.
   */
  const [openedTab, setOpenedTab] = useState<{ projectId: string; tabId: string; nonce: number } | null>(null);

  useEffect(() => {
    const unsubscribers = [
      window.meezeek.repository.onState(({ projectId, state }) =>
        setStates((current) => ({ ...current, [projectId]: state }))
      ),
      window.meezeek.terminals.onTabs(({ projectId, tabs: list }) =>
        setTabs((current) => ({ ...current, [projectId]: list }))
      ),
      // A status arrives on its own rather than as a whole list, so it is patched into the one
      // tab it names instead of replacing the project's.
      window.meezeek.terminals.onStatus(({ projectId, tabId, status }) =>
        setTabs((current) => {
          const list = current[projectId];
          return list
            ? { ...current, [projectId]: list.map((tab) => (tab.tabId === tabId ? { ...tab, status } : tab)) }
            : current;
        })
      )
    ];

    void (async () => {
      const stored = await window.meezeek.projects.list();
      setProjects(stored);
      setActiveProjectId((current) => current ?? stored[0]?.id ?? null);
      const loaded = await Promise.all(
        stored.map(async (project) => {
          const [state, list] = await Promise.all([
            window.meezeek.repository.state(project.id),
            window.meezeek.terminals.list(project.id)
          ]);
          return [project.id, state, list] as const;
        })
      );
      // Both were pushed while this was in flight if the project bootstrapped before the window
      // existed, and what was pushed is newer than what was just fetched.
      setStates((current) => ({
        ...Object.fromEntries(loaded.map(([id, state]) => [id, state])),
        ...current
      }));
      setTabs((current) => ({ ...Object.fromEntries(loaded.map(([id, , list]) => [id, list])), ...current }));
    })();

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);

  useEffect(() => window.meezeek.onNotice(({ severity, message }) => notify(severity, message)), []);

  /** What the add-repository dialog ends in, whichever of its tabs produced the project. */
  const projectAdded = useCallback((project: Project) => {
    setProjects((current) => (current.some((entry) => entry.id === project.id) ? current : [...current, project]));
    setActiveProjectId(project.id);
  }, []);

  const closeProject = useCallback(
    async (projectId: string) => {
      await window.meezeek.projects.remove(projectId);
      const remaining = projects.filter((project) => project.id !== projectId);
      setProjects(remaining);
      setActiveProjectId((current) => (current === projectId ? (remaining[0]?.id ?? null) : current));
      setTabs((current) => forget(current, projectId));
      setActiveTabs((current) => forget(current, projectId));
      // The xterm instances live outside React and outlive the pane that mounted them, so
      // this is where they are let go of — the one moment a project ends for good.
      disposeProjectTerminals(projectId);
    },
    [projects]
  );

  const reorderProjects = useCallback((ordered: Project[]) => {
    setProjects(ordered);
    void window.meezeek.projects.reorder(ordered.map((project) => project.id));
  }, []);

  /**
   * Runs one branch command per project at a time: clicking a second branch mid-switch would
   * stack two `git switch` on one repository. The branch tree says so with its cursor, this
   * enforces it. Per project, since two repositories working at once is no conflict.
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
    setOpenedTab((current) => ({ projectId, tabId, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  /** What a pane reports its own selection through; it stays the owner of it. */
  const setActiveTab = useCallback((projectId: string, tabId: string | null) => {
    setActiveTabs((current) => (current[projectId] === tabId ? current : { ...current, [projectId]: tabId }));
  }, []);

  /**
   * A project's sessions that finished a turn nobody has looked at since, oldest first — the
   * mark in the tab strip, and what the project row's own mark opens one of at a time.
   *
   * The one thing it leaves out is the tab in front of the user: a session that finishes while
   * its terminal is on screen was never out of sight. Decided here rather than in the main
   * process, which holds the mark but cannot know what is on screen — and here rather than in
   * each of the two views, which would then have to agree with each other about it.
   */
  const markedTabs = useCallback(
    (projectId: string): TerminalDescriptor[] => {
      const onScreen = projectId === activeProjectId ? activeTabs[projectId] : undefined;
      return (tabs[projectId] ?? [])
        .filter((tab) => tab.finishedAt !== undefined && tab.tabId !== onScreen)
        .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    },
    [tabs, activeTabs, activeProjectId]
  );

  /** The project row's mark: the session that finished first, then the next one the time after. */
  const showFinished = useCallback(
    (projectId: string) => {
      const next = markedTabs(projectId)[0];
      if (next) {
        showTab(projectId, next.tabId);
      }
    },
    [markedTabs, showTab]
  );

  /**
   * The tab in front of the user has been seen, so the mark on it goes. The main process holds
   * it but never learns which tab is on screen, which is why this is the renderer's half.
   */
  useEffect(() => {
    if (!activeProjectId) {
      return;
    }
    const onScreen = activeTabs[activeProjectId];
    const seen = tabs[activeProjectId]?.find((tab) => tab.tabId === onScreen && tab.finishedAt !== undefined);
    if (seen) {
      window.meezeek.terminals.seen(activeProjectId, seen.tabId);
    }
  }, [activeProjectId, activeTabs, tabs]);

  /** Opens a shell tab in that project, which is what a project row offers as "terminal". */
  const openTerminal = useCallback(
    (projectId: string) => {
      void window.meezeek.terminals.create(projectId, "shell").then((tab) => showTab(projectId, tab.tabId));
    },
    [showTab]
  );

  /**
   * Coming back to the window is when a change the watcher missed would show, so that is when
   * the repository is read again — GitHub Desktop refreshes on focus for the same reason. Only
   * the project on screen: refreshing every open one would spend three git processes each for
   * a state nobody is reading.
   */
  useEffect(() => {
    if (!activeProjectId) {
      return;
    }
    const onFocus = (): void => {
      void window.meezeek.repository.refresh(activeProjectId);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [activeProjectId]);

  const busyLabel = branchAction?.projectId === activeProjectId ? branchAction.label : null;
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeState = (activeProjectId ? states[activeProjectId] : undefined) ?? EMPTY_REPOSITORY_STATE;

  return (
    <div className="app">
      {/* The app name and the one button that belongs to the window rather than to a project;
          the bar itself is the drag region and the space the window controls overlay needs. */}
      <div className="titlebar">
        <img className="titlebar-icon" src="icon.png" alt="" />
        <span className="titlebar-name">MEEZEEK</span>
        <button className="titlebar-button" title="Settings" onClick={() => setSettingsOpen(true)}>
          <GearIcon />
        </button>
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
            hasFinished={(projectId) => markedTabs(projectId).length > 0}
            onShowFinished={showFinished}
          />
          <Sash
            orientation="horizontal"
            size={commandsHeight}
            min={MIN_PANE_HEIGHT}
            minOther={MIN_PANE_HEIGHT}
            reverse
            onResize={setCommandsHeight}
          />
          <CommandList projectId={activeProjectId} height={commandsHeight} onOpenTab={showTab} />
        </div>
        <Sash
          orientation="vertical"
          size={sidebarWidth}
          min={MIN_PANE_WIDTH}
          minOther={MIN_CONTENT_WIDTH}
          onResize={setSidebarWidth}
        />

        {/* The repository of the active project, between the navigation and its terminals.
            One pane for all of them, unlike the terminals: it holds no state a project would
            lose by being switched away from. */}
        {gitMounted && activeProject && (
          <>
            <div
              className={`git-pane-host${gitSliding ? " sliding" : ""}`}
              style={{ width: gitExpanded ? gitPanelsWidth : 0 }}
            >
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
            {gitOpen && (
              <Sash
                orientation="vertical"
                size={gitPanelsWidth}
                min={MIN_PANE_WIDTH}
                minOther={MIN_CONTENT_WIDTH}
                onResize={setGitPanelsWidth}
              />
            )}
          </>
        )}

        <main className="content">
          {/* Every project's terminals stay mounted so switching project keeps their buffers
              and running processes untouched. */}
          {projects.map((project) => (
            <TerminalsPane
              key={project.id}
              project={project}
              tabs={tabs[project.id] ?? []}
              visible={project.id === activeProjectId}
              gitOpen={gitOpen}
              onToggleGit={() => setGitOpen(!gitOpen)}
              externalBusy={branchAction?.projectId === project.id || (project.id === activeProjectId && gitBusy)}
              onOpenDiff={(path) => setDiffFile({ projectId: project.id, path })}
              openedTab={openedTab?.projectId === project.id ? openedTab : null}
              onActiveTab={setActiveTab}
              markedTabIds={markedTabs(project.id).map((tab) => tab.tabId)}
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

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}

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
      />
    </div>
  );
}
