import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentId, AgentInfo, Project, RepositoryState, TerminalDescriptor } from "../../shared/types";
import { disposeTerminal, fitTerminal, focusTerminal, refitTerminal, setRevealHandler } from "../terminal-views";
import { AgentIcon } from "./agent-icons";
import type { BranchActions } from "./BranchTree";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "./ContextMenu";
import { prompt } from "./Dialog";
import { GitView, type GitPaneSizes } from "./GitView";
import { TerminalHost } from "./TerminalHost";
import { BranchIcon, CloseIcon, PlusIcon } from "./icons";

/** Dragging the window edge fires dozens of observations, and every pty resize repaints the TUI. */
const RESIZE_DEBOUNCE_MS = 100;
/**
 * Selection id of the git tab. It has no pty behind it, so it lives only here and never
 * appears in the tab list the host reports; agent session ids never look like this.
 */
const GIT_TAB_ID = "git";
/** What VS Code's own tab rename accepts. */
const MAX_TITLE_LENGTH = 50;

/** ISO 8601 date/time, space instead of "T", local time, seconds precision. */
function formatIso(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

interface TerminalsPaneProps {
  project: Project;
  visible: boolean;
  state: RepositoryState;
  /** Passed straight through to the git tab, which is where the panels they size live. */
  gitSizes: GitPaneSizes;
  /** The branch commands the git tab offers; `busy` also drives the tab strip's progress bar. */
  branch: BranchActions;
}

export function TerminalsPane({ project, visible, state, gitSizes, branch }: TerminalsPaneProps) {
  const [tabs, setTabs] = useState<TerminalDescriptor[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedChange, setSelectedChange] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  /** The git tab reading or coloring a diff — the same bar as a starting agent. */
  const [gitBusy, setGitBusy] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const stack = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const knownTabs = useRef<TerminalDescriptor[]>([]);
  /** Whether onStartupProgress has fired; the initial query must not overwrite a push. */
  const progressPushed = useRef(false);

  // The git tab's console is a session like any other, but it belongs to that tab rather than
  // to the strip — everything below works off `stripTabs`, and the console is handed on.
  const consoleTab = tabs.find((tab) => tab.console);
  const stripTabs = tabs.filter((tab) => !tab.console);

  useEffect(() => {
    void (async () => {
      const [existing, available, isStarting] = await Promise.all([
        window.meeseek.terminals.list(project.id),
        window.meeseek.agents.list(),
        window.meeseek.terminals.starting(project.id)
      ]);
      setAgents(available);
      setTabs(existing);
      if (!progressPushed.current) {
        setStarting(isStarting);
      }
    })();
    return window.meeseek.terminals.onTabs((payload) => {
      if (payload.projectId === project.id) {
        setTabs(payload.tabs);
      }
    });
  }, [project.id]);

  useEffect(
    () =>
      window.meeseek.terminals.onStatus(({ projectId, tabId, status }) => {
        if (projectId === project.id) {
          setTabs((current) => current.map((tab) => (tab.tabId === tabId ? { ...tab, status } : tab)));
        }
      }),
    [project.id]
  );

  useEffect(
    () =>
      window.meeseek.terminals.onStartupProgress(({ projectId, show }) => {
        if (projectId === project.id) {
          progressPushed.current = true;
          setStarting(show);
        }
      }),
    [project.id]
  );

  // VS Code scrolls its tab strip horizontally with the vertical wheel. Registered by hand
  // because preventDefault needs a non-passive listener, which React's onWheel isn't.
  useEffect(() => {
    const element = strip.current;
    if (!element) {
      return;
    }
    const onWheel = (event: WheelEvent): void => {
      // Scrolling moves the tab the menu was opened on out from under it.
      setTabMenu(null);
      if (event.deltaY !== 0) {
        event.preventDefault();
        element.scrollLeft += event.deltaY;
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  // Keeps the selection and the xterm instances in sync with the tabs the host reports.
  useEffect(() => {
    const previous = knownTabs.current;
    knownTabs.current = tabs;
    const ids = new Set(tabs.map((tab) => tab.tabId));
    for (const tab of previous) {
      if (!ids.has(tab.tabId)) {
        disposeTerminal(project.id, tab.tabId);
      }
    }
    if (activeId === GIT_TAB_ID) {
      return;
    }
    const strip = tabs.filter((tab) => !tab.console);
    if (activeId && !ids.has(activeId)) {
      // Same rule as VS Code: hand over to the nearest neighbour on the right, or — if the
      // closed tab was the rightmost one — on the left.
      const index = previous.filter((tab) => !tab.console).findIndex((tab) => tab.tabId === activeId);
      setActiveId(strip[Math.min(index, strip.length - 1)]?.tabId ?? GIT_TAB_ID);
    } else if (!activeId && strip.length > 0) {
      // On first load, open the session the user last worked in.
      const mostRecent = [...strip].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
      setActiveId(mostRecent.tabId);
    }
  }, [tabs, activeId, project.id]);

  // Refit whenever the terminal becomes the visible one: while its pane was hidden it had no
  // layout, so its last measured size is stale. The resize is also what starts its process.
  useEffect(() => {
    if (visible && activeId && activeId !== GIT_TAB_ID) {
      fitTerminal(project.id, activeId);
      focusTerminal(project.id, activeId);
    }
  }, [visible, activeId, project.id]);

  useEffect(() => {
    const element = stack.current;
    if (!element) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    // xterm follows the pane at once — dragging a sash would otherwise leave a strip of empty
    // background until the debounce fires. Only the pty resize waits, since it repaints the CLI.
    const observer = new ResizeObserver(() => {
      if (!visible || !activeId || activeId === GIT_TAB_ID) {
        return;
      }
      refitTerminal(project.id, activeId);
      clearTimeout(timer);
      timer = setTimeout(() => fitTerminal(project.id, activeId), RESIZE_DEBOUNCE_MS);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [visible, activeId, project.id]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const close = (): void => setMenuOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const createTab = useCallback(
    async (agentId: AgentId) => {
      const descriptor = await window.meeseek.terminals.create(project.id, agentId);
      setActiveId(descriptor.tabId);
    },
    [project.id]
  );

  const closeTabs = useCallback(
    (tabIds: string[]) => void window.meeseek.terminals.close(project.id, tabIds),
    [project.id]
  );

  const closeTabMenu = useCallback(() => setTabMenu(null), []);

  // Ctrl+clicking a changed file in a terminal opens the git tab on that file's diff.
  useEffect(
    () =>
      setRevealHandler(project.id, (path) => {
        setSelectedChange(path);
        setActiveId(GIT_TAB_ID);
      }),
    [project.id]
  );

  const askRename = useCallback(
    async (tab: TerminalDescriptor) => {
      const answer = await prompt({
        title: "Rename session",
        label: "Name",
        value: tab.title,
        confirmLabel: "Rename",
        maxLength: MAX_TITLE_LENGTH
      });
      if (answer !== null && answer.value !== tab.title) {
        void window.meeseek.terminals.rename(project.id, tab.tabId, answer.value);
      }
    },
    [project.id]
  );

  const agentName = (agentId: AgentId): string =>
    agents.find((agent) => agent.id === agentId)?.displayName ?? agentId;

  /** Agents label their tab with the session title; a shell tab has no session to name. */
  const tabLabel = (tab: TerminalDescriptor): string => {
    if (tab.title) {
      return tab.title;
    }
    return agents.find((agent) => agent.id === tab.agentId)?.hasSessions === false
      ? agentName(tab.agentId)
      : "New session";
  };

  const tabTooltip = (tab: TerminalDescriptor): string => {
    const lines =
      tab.status === "missing"
        ? [`${agentName(tab.agentId)} was not found — install it and reopen the project`]
        : [`${agentName(tab.agentId)}${tab.title ? `: ${tab.title}` : ""}`];
    if (tab.createdAt) {
      lines.push(`Created: ${formatIso(tab.createdAt)}`);
    }
    if (tab.updatedAt) {
      lines.push(`Updated: ${formatIso(tab.updatedAt)}`);
    }
    return lines.join("\n");
  };

  /**
   * VS Code's editor tab context menu, reduced to its close actions plus rename. For a close
   * action the set of tabs it would close is what decides whether it's enabled, so "nothing
   * to close" (a right-click on the only tab, or on the last one) renders it disabled.
   */
  const tabMenuEntries = (tabId: string): ContextMenuEntry[] => {
    const ids = stripTabs.map((tab) => tab.tabId);
    const renamable = stripTabs.find((tab) => tab.tabId === tabId && tab.hasSession);
    const closeAction = (label: string, targets: string[]): ContextMenuEntry => ({
      label,
      run: targets.length > 0 ? () => closeTabs(targets) : undefined
    });
    return [
      closeAction("Close", [tabId]),
      closeAction(
        "Close Others",
        ids.filter((id) => id !== tabId)
      ),
      closeAction("Close to the Right", ids.slice(ids.indexOf(tabId) + 1)),
      closeAction("Close All", ids),
      SEPARATOR,
      // A tab whose agent hasn't persisted a session yet has nothing to rename — the host
      // would just revert the new label, so don't offer it in the first place.
      {
        label: "Rename...",
        run: renamable ? () => void askRename(renamable) : undefined
      }
    ];
  };

  // The git tab is always there and can't be closed, so it is also what "nothing selected"
  // falls back to: a project without sessions opens on it, as does closing the last terminal.
  const gitActive = activeId === null || activeId === GIT_TAB_ID;

  return (
    <div className={`terminals-pane${visible ? "" : " pane-hidden"}`}>
      <div className="terminal-tabs">
        <div className="terminal-tab-strip" ref={strip}>
          <div
            className={`terminal-tab git${gitActive ? " active" : ""}`}
            onClick={() => setActiveId(GIT_TAB_ID)}
            title="Git"
          >
            <BranchIcon className="terminal-tab-icon" />
            <span className="terminal-tab-label">Git</span>
          </div>
          {stripTabs.map((tab) => (
          <div
            key={tab.tabId}
            className={`terminal-tab${tab.tabId === activeId ? " active" : ""}${tab.status === "stopped" || tab.status === "error" ? " inactive" : ""}${tab.status === "missing" ? " unavailable" : ""}`}
            onClick={() => setActiveId(tab.tabId)}
            onDoubleClick={() => tab.hasSession && void askRename(tab)}
            // Keeps the terminal focused across the whole right-click interaction: without
            // this, mousedown's default focus handling blurs xterm's textarea (the tab isn't
            // focusable, so focus falls back to <body>), leaving the user unable to type
            // after the menu closes until they click the terminal again.
            onMouseDown={(event) => {
              if (event.button === 2) {
                event.preventDefault();
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setTabMenu({ tabId: tab.tabId, x: event.clientX, y: event.clientY });
            }}
            title={tabTooltip(tab)}
          >
            <AgentIcon agentId={tab.agentId} className="terminal-tab-icon" />
            <span className="terminal-tab-label">{tabLabel(tab)}</span>
            <button
              className="icon-button"
              title={tab.hasSession ? "Close tab and delete its session" : "Close tab"}
              onClick={(event) => {
                event.stopPropagation();
                closeTabs([tab.tabId]);
              }}
            >
              <CloseIcon />
            </button>
          </div>
          ))}
        </div>
        {/* The one progress indicator in the window, so everything slow in this project shares
            it. The diff only while the git tab is the one on screen: one it loaded on the way
            out is nothing the user is still waiting for. */}
        {(starting || branch.busy || (gitActive && gitBusy)) && (
          <div className="tab-progress">
            <div className="tab-progress-bit" />
          </div>
        )}
        <div className="new-terminal">
          <button
            className="icon-button"
            title="New session"
            onMouseDown={(event) => {
              event.stopPropagation();
              setMenuOpen((open) => !open);
            }}
          >
            <PlusIcon />
          </button>
          {menuOpen && (
            <div className="menu" onMouseDown={(event) => event.stopPropagation()}>
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  className="menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    void createTab(agent.id);
                  }}
                >
                  {agent.displayName}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className={`terminal-stack${gitActive ? " pane-hidden" : ""}`} ref={stack}>
        {stripTabs.map((tab) => (
          <TerminalHost key={tab.tabId} projectId={project.id} tabId={tab.tabId} active={tab.tabId === activeId} />
        ))}
      </div>
      <GitView
        project={project}
        state={state}
        sizes={gitSizes}
        branch={branch}
        selected={selectedChange}
        onSelect={setSelectedChange}
        onBusy={setGitBusy}
        active={gitActive}
        agents={agents}
        console={consoleTab}
      />

      {tabMenu && (
        <ContextMenu x={tabMenu.x} y={tabMenu.y} entries={tabMenuEntries(tabMenu.tabId)} onClose={closeTabMenu} />
      )}
    </div>
  );
}
