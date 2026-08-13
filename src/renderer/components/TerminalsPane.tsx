import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentId, AgentInfo, Project, TerminalDescriptor } from "../../shared/types";
import { attachTerminal, disposeTerminal, fitTerminal, focusTerminal } from "../terminal-views";
import { AgentIcon } from "./agent-icons";
import { CloseIcon, PlusIcon } from "./icons";

/** Dragging the window edge fires dozens of observations, and every pty resize repaints the TUI. */
const RESIZE_DEBOUNCE_MS = 100;

interface TerminalsPaneProps {
  project: Project;
  visible: boolean;
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

export function TerminalsPane({ project, visible }: TerminalsPaneProps) {
  const [tabs, setTabs] = useState<TerminalDescriptor[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const stack = useRef<HTMLDivElement>(null);
  const knownTabs = useRef<TerminalDescriptor[]>([]);

  useEffect(() => {
    void (async () => {
      const [existing, available] = await Promise.all([
        window.meeseex.terminals.list(project.id),
        window.meeseex.agents.list()
      ]);
      setAgents(available);
      setTabs(existing);
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
    if (activeId && !ids.has(activeId)) {
      // Same rule as VS Code: hand over to the nearest neighbour on the right, or — if the
      // closed tab was the rightmost one — on the left.
      const index = previous.findIndex((tab) => tab.tabId === activeId);
      setActiveId(tabs[Math.min(index, tabs.length - 1)]?.tabId ?? null);
    } else if (!activeId && tabs.length > 0) {
      // On first load, open the session the user last worked in.
      const mostRecent = [...tabs].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
      setActiveId(mostRecent.tabId);
    }
  }, [tabs, activeId, project.id]);

  // Refit whenever the terminal becomes the visible one: while its pane was hidden it had no
  // layout, so its last measured size is stale. The resize is also what starts its process.
  useEffect(() => {
    if (visible && activeId) {
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
        if (visible && activeId) {
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

  const closeTab = useCallback(
    (tabId: string) => void window.meeseex.terminals.close(project.id, [tabId]),
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

  return (
    <div className={`terminals-pane${visible ? "" : " pane-hidden"}`}>
      <div className="terminal-tabs">
        <div className="terminal-tab-strip">
          {tabs.map((tab) => (
          <div
            key={tab.tabId}
            className={`terminal-tab${tab.tabId === activeId ? " active" : ""}${tab.status === "stopped" || tab.status === "error" ? " inactive" : ""}${tab.status === "missing" ? " unavailable" : ""}`}
            onClick={() => setActiveId(tab.tabId)}
            onDoubleClick={() => tab.hasSession && setRenamingId(tab.tabId)}
            title={
              tab.status === "missing"
                ? `${agentName(tab.agentId)} was not found — install it and reopen the project`
                : `${agentName(tab.agentId)}${tab.title ? `: ${tab.title}` : ""}`
            }
          >
            <AgentIcon agentId={tab.agentId} className="terminal-tab-icon" />
            {renamingId === tab.tabId ? (
              <input
                className="tab-rename-input"
                autoFocus
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
                closeTab(tab.tabId);
              }}
            >
              <CloseIcon />
            </button>
          </div>
          ))}
        </div>
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

      <div className="terminal-stack" ref={stack}>
        {tabs.map((tab) => (
          <TerminalHost key={tab.tabId} projectId={project.id} tabId={tab.tabId} active={tab.tabId === activeId} />
        ))}
        {tabs.length === 0 && <div className="placeholder">No session yet — use + to start an agent or a shell.</div>}
      </div>
    </div>
  );
}
