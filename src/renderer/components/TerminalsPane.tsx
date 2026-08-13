import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentId, AgentInfo, Project, TerminalDescriptor } from "../../shared/types";
import { attachTerminal, disposeTerminal, fitTerminal, focusTerminal } from "../terminal-views";
import { CloseIcon, PlusIcon } from "./icons";

/** Dragging the window edge fires dozens of observations, and every pty resize repaints the TUI. */
const RESIZE_DEBOUNCE_MS = 100;

interface TerminalsPaneProps {
  project: Project;
  visible: boolean;
}

function TerminalHost({ id, active }: { id: string; active: boolean }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (container.current) {
      attachTerminal(id, container.current);
    }
  }, [id]);

  // "hidden" is visibility, not display — xterm needs a laid-out element to measure itself,
  // both when it opens and when output arrives for a background tab.
  return <div ref={container} className={`terminal${active ? "" : " hidden"}`} />;
}

export function TerminalsPane({ project, visible }: TerminalsPaneProps) {
  const [tabs, setTabs] = useState<TerminalDescriptor[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const stack = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      const [existing, available] = await Promise.all([
        window.meeseex.terminals.list(project.id),
        window.meeseex.agents.list()
      ]);
      setAgents(available);
      setTabs(existing);
      setActiveId((current) => current ?? existing[0]?.id ?? null);
    })();
  }, [project.id]);

  useEffect(
    () =>
      window.meeseex.terminals.onStatus(({ id, status }) =>
        setTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, status } : tab)))
      ),
    []
  );

  // Refit whenever the terminal becomes the visible one: while its pane was hidden it had no
  // layout, so its last measured size is stale. The resize is also what starts its process.
  useEffect(() => {
    if (visible && activeId) {
      fitTerminal(activeId);
      focusTerminal(activeId);
    }
  }, [visible, activeId]);

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
          fitTerminal(activeId);
        }
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [visible, activeId]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const close = (): void => setMenuOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const createTerminal = useCallback(
    async (agentId: AgentId) => {
      const descriptor = await window.meeseex.terminals.create(project.id, agentId);
      setTabs((current) => [...current, descriptor]);
      setActiveId(descriptor.id);
    },
    [project.id]
  );

  const closeTerminal = useCallback(
    async (terminalId: string) => {
      await window.meeseex.terminals.close(terminalId);
      disposeTerminal(terminalId);
      setTabs((current) => {
        const remaining = current.filter((tab) => tab.id !== terminalId);
        setActiveId((active) => (active === terminalId ? (remaining.at(-1)?.id ?? null) : active));
        return remaining;
      });
    },
    []
  );

  return (
    <div className={`terminals-pane${visible ? "" : " pane-hidden"}`}>
      <div className="terminal-tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`terminal-tab${tab.id === activeId ? " active" : ""}${tab.status === "exited" || tab.status === "error" ? " inactive" : ""}`}
            onClick={() => setActiveId(tab.id)}
            title={tab.title}
          >
            <span className="terminal-tab-label">{tab.title}</span>
            <button
              className="icon-button"
              title="Close terminal"
              onClick={(event) => {
                event.stopPropagation();
                void closeTerminal(tab.id);
              }}
            >
              <CloseIcon />
            </button>
          </div>
        ))}
        <div className="new-terminal">
          <button
            className="icon-button"
            title="New terminal"
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
                    void createTerminal(agent.id);
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
          <TerminalHost key={tab.id} id={tab.id} active={tab.id === activeId} />
        ))}
        {tabs.length === 0 && <div className="placeholder">No terminal yet — use + to start an agent or a shell.</div>}
      </div>
    </div>
  );
}
