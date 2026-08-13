import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentId,
  AgentInfo,
  CheckoutTarget,
  Project,
  RepositoryState,
  TerminalDescriptor
} from "../../shared/types";
import { attachTerminal, disposeTerminal, fitTerminal, focusTerminal, setRevealHandler } from "../terminal-views";
import { AgentIcon } from "./agent-icons";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "./ContextMenu";
import { GitView, type GitPaneSizes } from "./GitView";
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
  onCheckout: (target: CheckoutTarget) => void;
}

function TerminalHost({ projectId, tabId, active }: { projectId: string; tabId: string; active: boolean }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (container.current) {
      attachTerminal(projectId, tabId, container.current);
    }
  }, [projectId, tabId]);

  // "hidden" is visibility, not display — xterm needs a laid-out element to measure itself,
  // both when it opens and when output arrives for a background tab.
  return <div ref={container} className={`terminal${active ? "" : " hidden"}`} />;
}

export function TerminalsPane({ project, visible, state, gitSizes, onCheckout }: TerminalsPaneProps) {
  const [tabs, setTabs] = useState<TerminalDescriptor[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedChange, setSelectedChange] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  /** The git tab reading or coloring a diff — the same bar as a starting agent. */
  const [gitBusy, setGitBusy] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const stack = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const knownTabs = useRef<TerminalDescriptor[]>([]);
  /** Whether onStartupProgress has fired; the initial query must not overwrite a push. */
  const progressPushed = useRef(false);

  useEffect(() => {
    void (async () => {
      const [existing, available, isStarting] = await Promise.all([
        window.meeseex.terminals.list(project.id),
        window.meeseex.agents.list(),
        window.meeseex.terminals.starting(project.id)
      ]);
      setAgents(available);
      setTabs(existing);
      if (!progressPushed.current) {
        setStarting(isStarting);
      }
    })();
    return window.meeseex.terminals.onTabs((payload) => {
      if (payload.projectId === project.id) {
        setTabs(payload.tabs);
      }
    });
  }, [project.id]);

  useEffect(
    () =>
      window.meeseex.terminals.onStatus(({ projectId, tabId, status }) => {
        if (projectId === project.id) {
          setTabs((current) => current.map((tab) => (tab.tabId === tabId ? { ...tab, status } : tab)));
        }
      }),
    [project.id]
  );

  useEffect(
    () =>
      window.meeseex.terminals.onStartupProgress(({ projectId, show }) => {
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
    if (activeId && !ids.has(activeId)) {
      // Same rule as VS Code: hand over to the nearest neighbour on the right, or — if the
      // closed tab was the rightmost one — on the left.
      const index = previous.findIndex((tab) => tab.tabId === activeId);
      setActiveId(tabs[Math.min(index, tabs.length - 1)]?.tabId ?? GIT_TAB_ID);
    } else if (!activeId && tabs.length > 0) {
      // On first load, open the session the user last worked in.
      const mostRecent = [...tabs].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
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
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (visible && activeId && activeId !== GIT_TAB_ID) {
          fitTerminal(project.id, activeId);
        }
      }, RESIZE_DEBOUNCE_MS);
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
      const descriptor = await window.meeseex.terminals.create(project.id, agentId);
      setActiveId(descriptor.tabId);
    },
    [project.id]
  );

  const closeTabs = useCallback(
    (tabIds: string[]) => void window.meeseex.terminals.close(project.id, tabIds),
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

  const commitRename = useCallback(
    (tabId: string, title: string) => {
      setRenamingId(null);
      if (title.trim()) {
        void window.meeseex.terminals.rename(project.id, tabId, title);
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
    const ids = tabs.map((tab) => tab.tabId);
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
        label: "Rename",
        run: tabs.find((tab) => tab.tabId === tabId)?.hasSession ? () => setRenamingId(tabId) : undefined
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
          {tabs.map((tab) => (
          <div
            key={tab.tabId}
            className={`terminal-tab${tab.tabId === activeId ? " active" : ""}${tab.status === "stopped" || tab.status === "error" ? " inactive" : ""}${tab.status === "missing" ? " unavailable" : ""}`}
            onClick={() => setActiveId(tab.tabId)}
            onDoubleClick={() => tab.hasSession && setRenamingId(tab.tabId)}
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
            {renamingId === tab.tabId ? (
              <input
                className="tab-rename-input"
                autoFocus
                maxLength={MAX_TITLE_LENGTH}
                defaultValue={tab.title}
                onClick={(event) => event.stopPropagation()}
                onBlur={() => setRenamingId(null)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    commitRename(tab.tabId, event.currentTarget.value);
                  } else if (event.key === "Escape") {
                    setRenamingId(null);
                  }
                }}
              />
            ) : (
              <span className="terminal-tab-label">{tabLabel(tab)}</span>
            )}
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
        {/* Only while the git tab is the one on screen: a diff it loaded on the way out is
            nothing the user is still waiting for. */}
        {(starting || (gitActive && gitBusy)) && (
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
        {tabs.map((tab) => (
          <TerminalHost key={tab.tabId} projectId={project.id} tabId={tab.tabId} active={tab.tabId === activeId} />
        ))}
      </div>
      <GitView
        project={project}
        state={state}
        sizes={gitSizes}
        onCheckout={onCheckout}
        selected={selectedChange}
        onSelect={setSelectedChange}
        onBusy={setGitBusy}
        active={gitActive}
      />

      {tabMenu && (
        <ContextMenu x={tabMenu.x} y={tabMenu.y} entries={tabMenuEntries(tabMenu.tabId)} onClose={closeTabMenu} />
      )}
    </div>
  );
}
