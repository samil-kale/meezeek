import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EMPTY_REPOSITORY_STATE } from "../shared/types";
import type { GitActionResult, Project, RepositoryState, TerminalDescriptor } from "../shared/types";
import { AddRepositoryDialog } from "./components/AddRepositoryDialog";
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
import { matchesShortcut } from "./shortcuts";

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

/** What an open diff has to be re-read for: HEAD, and the status of the file it shows. */
function diffVersion(state: RepositoryState | undefined, filePath: string): string {
  return `${state?.head}:${state?.changes.find((change) => change.path === filePath)?.status}`;
}

/** The tabs of a project that has none — one instance, so the pane's props stay identical. */
const NO_TABS: TerminalDescriptor[] = [];
const NO_IDS: string[] = [];

/** The sessions of one project that are marked, by tab id: finished out of sight, and waiting. */
interface ProjectMarks {
  finished: string[];
  waiting: string[];
}

/** `next` unless `previous` already holds the same ids — then that one, identity and all. */
function sameIds(previous: string[] | undefined, next: string[]): string[] {
  if (next.length === 0) {
    return NO_IDS;
  }
  return previous && previous.length === next.length && previous.every((id, i) => id === next[i]) ? previous : next;
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
  // Defaults and limits of the draggable panes. The one git pane shares the two below,
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
  /**
   * The git pane or an open diff is working; the active project's bar reports either. Two
   * flags rather than one, because each writer clears its own on unmount — a diff closed while
   * a discard still runs must not take the discard's "busy" down with it.
   */
  const [gitBusy, setGitBusy] = useState(false);
  const [diffBusy, setDiffBusy] = useState(false);
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
      setStates((current) => forget(current, projectId));
      setTabs((current) => forget(current, projectId));
      setActiveTabs((current) => forget(current, projectId));
      busyCursor.current = forget(busyCursor.current, projectId);
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

  /**
   * A project's sessions that stopped mid-turn on a question, oldest first. The same rule as
   * `markedTabs` and for the same reason — a question asked in the tab in front of the user was
   * never asked out of sight — so the two live next to each other and both views take the
   * answer from here rather than working it out twice.
   */
  const waitingTabs = useCallback(
    (projectId: string): TerminalDescriptor[] => {
      const onScreen = projectId === activeProjectId ? activeTabs[projectId] : undefined;
      return (tabs[projectId] ?? [])
        .filter((tab) => tab.waitingAt !== undefined && tab.tabId !== onScreen)
        .sort((a, b) => (a.waitingAt ?? 0) - (b.waitingAt ?? 0));
    },
    [tabs, activeTabs, activeProjectId]
  );

  /**
   * Both of the above as tab ids, once per render for every project, and by identity only
   * where the answer changed: a pane and a project row take these as props, and a fresh array
   * for an unchanged answer would re-render every memoized view on every push from any project.
   */
  const marksRef = useRef<Record<string, ProjectMarks>>({});
  const marks = useMemo(() => {
    const next: Record<string, ProjectMarks> = {};
    for (const projectId of Object.keys(tabs)) {
      const previous = marksRef.current[projectId];
      const finished = markedTabs(projectId).map((tab) => tab.tabId);
      const waiting = waitingTabs(projectId).map((tab) => tab.tabId);
      next[projectId] = {
        finished: sameIds(previous?.finished, finished),
        waiting: sameIds(previous?.waiting, waiting)
      };
    }
    marksRef.current = next;
    return next;
  }, [tabs, markedTabs, waitingTabs]);

  /**
   * Whether any session of this project is working on a turn. Unlike the mark above, the tab in
   * front of the user is *not* left out: a spinner says what is happening now, and it says it
   * wherever the tab is — the reason to look at it is that the answer is not there yet.
   */
  const hasBusyTab = useCallback(
    (projectId: string): boolean => (tabs[projectId] ?? []).some((tab) => tab.busy),
    [tabs]
  );

  /**
   * The project row's spinner: the sessions that are working, one press at a time. Where the
   * mark beside it works through its list by emptying it — a session seen stops being marked —
   * watching a session does not stop it working, so this has to remember where it left off. A
   * ref rather than state: it changes what the *next* press does, and nothing on screen.
   */
  const busyCursor = useRef<Record<string, string>>({});
  const showBusy = useCallback(
    (projectId: string) => {
      const working = (tabs[projectId] ?? []).filter((tab) => tab.busy);
      if (working.length === 0) {
        return;
      }
      // Where the last press landed, or -1 when that tab has since stopped or gone — either way
      // the next index is the one to show, and it wraps.
      const at = working.findIndex((tab) => tab.tabId === busyCursor.current[projectId]);
      const next = working[(at + 1) % working.length];
      busyCursor.current[projectId] = next.tabId;
      showTab(projectId, next.tabId);
    },
    [tabs, showTab]
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

  /** The same, for the session that has been waiting on an answer the longest. */
  const showWaiting = useCallback(
    (projectId: string) => {
      const next = waitingTabs(projectId)[0];
      if (next) {
        showTab(projectId, next.tabId);
      }
    },
    [waitingTabs, showTab]
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
    const seen = tabs[activeProjectId]?.find(
      (tab) => tab.tabId === onScreen && (tab.finishedAt !== undefined || tab.waitingAt !== undefined)
    );
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
   * Ctrl/Cmd+Shift+U: across every project, whichever session has been waiting on a question the
   * longest — or, if none is, whichever finished out of sight first. The same "oldest first" rule
   * `showWaiting`/`showFinished` apply to one project's row, just not stopped at one project: the
   * key exists precisely so a project nobody has clicked into is not missed.
   */
  const showNeedsAttention = useCallback(() => {
    // Through `waitingTabs`/`markedTabs`, so the "not the tab on screen" rule stays in one place.
    const collect = (
      of: (projectId: string) => TerminalDescriptor[],
      field: "waitingAt" | "finishedAt"
    ): { projectId: string; tab: TerminalDescriptor }[] =>
      Object.keys(tabs)
        .flatMap((projectId) => of(projectId).map((tab) => ({ projectId, tab })))
        .sort((a, b) => (a.tab[field] ?? 0) - (b.tab[field] ?? 0));
    const next = collect(waitingTabs, "waitingAt")[0] ?? collect(markedTabs, "finishedAt")[0];
    if (next) {
      showTab(next.projectId, next.tab.tabId);
    }
  }, [tabs, waitingTabs, markedTabs, showTab]);

  /** Ctrl/Cmd+Shift+./, — the active project's tabs, one over from where it is now. */
  const cycleTab = useCallback(
    (direction: 1 | -1) => {
      if (!activeProjectId) {
        return;
      }
      const list = tabs[activeProjectId] ?? [];
      if (list.length === 0) {
        return;
      }
      const at = list.findIndex((tab) => tab.tabId === activeTabs[activeProjectId]);
      const next = list[(at + direction + list.length) % list.length];
      showTab(activeProjectId, next.tabId);
    },
    [activeProjectId, tabs, activeTabs, showTab]
  );

  /** Ctrl/Cmd+Shift+T — a shell tab in the project on screen, the same as its row's own button. */
  const newShellTab = useCallback(() => {
    if (activeProjectId) {
      openTerminal(activeProjectId);
    }
  }, [activeProjectId, openTerminal]);

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

  /**
   * The window's own shortcuts, on `document` in the capture phase so they win the race against
   * xterm's own listener (attached to its own textarea, further down the tree) rather than
   * arriving as input to whichever terminal has focus — see "The keyboard belongs to the
   * terminal" in CLAUDE.md for why every one of `matchesShortcut`'s combinations is safe to take.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (matchesShortcut(event, "settings")) {
        event.preventDefault();
        event.stopPropagation();
        setSettingsOpen(true);
      } else if (matchesShortcut(event, "toggleGit")) {
        event.preventDefault();
        event.stopPropagation();
        setGitOpen(!gitOpen);
      } else if (matchesShortcut(event, "needsAttention")) {
        event.preventDefault();
        event.stopPropagation();
        showNeedsAttention();
      } else if (matchesShortcut(event, "nextTab")) {
        event.preventDefault();
        event.stopPropagation();
        cycleTab(1);
      } else if (matchesShortcut(event, "previousTab")) {
        event.preventDefault();
        event.stopPropagation();
        cycleTab(-1);
      } else if (matchesShortcut(event, "newShellTab")) {
        event.preventDefault();
        event.stopPropagation();
        newShellTab();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [gitOpen, setGitOpen, showNeedsAttention, cycleTab, newShellTab]);

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeState = (activeProjectId ? states[activeProjectId] : undefined) ?? EMPTY_REPOSITORY_STATE;

  // Stable handles for what the views below take, so a memoized view re-renders for a change in
  // what it shows and not for a fresh arrow function.
  const closeProjectSync = useCallback((projectId: string) => void closeProject(projectId), [closeProject]);
  const openAdd = useCallback(() => setAddOpen(true), []);
  const closeAdd = useCallback(() => setAddOpen(false), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closeDiff = useCallback(() => setDiffFile(null), []);
  const remoteOf = useCallback((projectId: string) => states[projectId]?.remotes[0], [states]);
  const headOf = useCallback((projectId: string) => states[projectId]?.head, [states]);
  const hasFinished = useCallback((projectId: string) => (marks[projectId]?.finished.length ?? 0) > 0, [marks]);
  const hasWaiting = useCallback((projectId: string) => (marks[projectId]?.waiting.length ?? 0) > 0, [marks]);
  const toggleGit = useCallback(() => setGitOpen(!gitOpen), [gitOpen, setGitOpen]);
  const openDiff = useCallback((projectId: string, path: string) => setDiffFile({ projectId, path }), []);
  const openActiveDiff = useCallback(
    (path: string) => {
      if (activeProjectId) {
        setDiffFile({ projectId: activeProjectId, path });
      }
    },
    [activeProjectId]
  );
  const runActiveBranchAction = useCallback(
    (label: string, action: () => Promise<GitActionResult>) => {
      if (activeProjectId) {
        void runBranchAction(activeProjectId, label, action);
      }
    },
    [activeProjectId, runBranchAction]
  );
  /** What the git pane may start, in the shape its views take it — for the project on screen. */
  const activeBranch = useMemo<BranchActions>(
    () => ({ busy: branchAction?.projectId === activeProjectId, run: runActiveBranchAction }),
    [branchAction, activeProjectId, runActiveBranchAction]
  );

  return (
    <div className="app">
      {/* The app name and the one button that belongs to the window rather than to a project;
          the bar itself is the drag region and the space the window controls overlay needs. */}
      <div className="titlebar">
        <img className="titlebar-icon" src="icon.png" alt="" />
        <span className="titlebar-name">MEEZEEK</span>
        <button className="titlebar-button" title="Settings" onClick={openSettings}>
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
            onClose={closeProjectSync}
            onReorder={reorderProjects}
            onAdd={openAdd}
            remoteOf={remoteOf}
            headOf={headOf}
            onOpenTerminal={openTerminal}
            hasFinished={hasFinished}
            hasBusy={hasBusyTab}
            hasWaiting={hasWaiting}
            onShowBusy={showBusy}
            onShowFinished={showFinished}
            onShowWaiting={showWaiting}
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
                branch={activeBranch}
                treeHeight={branchTreeHeight}
                onTreeHeight={setBranchTreeHeight}
                onOpenDiff={openActiveDiff}
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
              tabs={tabs[project.id] ?? NO_TABS}
              visible={project.id === activeProjectId}
              gitOpen={gitOpen}
              onToggleGit={toggleGit}
              externalBusy={
                branchAction?.projectId === project.id || (project.id === activeProjectId && (gitBusy || diffBusy))
              }
              onOpenDiff={openDiff}
              openedTab={openedTab?.projectId === project.id ? openedTab : null}
              onActiveTab={setActiveTab}
              markedTabIds={marks[project.id]?.finished ?? NO_IDS}
              waitingTabIds={marks[project.id]?.waiting ?? NO_IDS}
            />
          ))}
          {!activeProject && (
            <div className="empty-workspace">
              <p>No repository open.</p>
              <button className="button" onClick={openAdd}>
                <PlusIcon />
                <span>Add repository</span>
              </button>
            </div>
          )}
        </main>
      </div>

      {/* Over everything, and only ever one: a diff is looked at and then left again. It
          reloads when what it shows can have changed — HEAD, or this file's own status — and
          not with every other file an agent touches: a reload reads the diff again and colours
          all of it again, hundreds of milliseconds on the renderer for a long file. */}
      {diffFile && (
        <DiffDialog
          projectId={diffFile.projectId}
          path={diffFile.path}
          version={diffVersion(states[diffFile.projectId], diffFile.path)}
          onClose={closeDiff}
          onBusy={setDiffBusy}
        />
      )}

      {addOpen && <AddRepositoryDialog onAdded={projectAdded} onClose={closeAdd} />}

      {settingsOpen && <SettingsDialog onClose={closeSettings} />}

      <Notices />
      <Dialogs />
    </div>
  );
}
