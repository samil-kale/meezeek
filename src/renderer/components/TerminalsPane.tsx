import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { AgentId, AgentInfo, Project, TerminalDescriptor } from "../../shared/types";
import { disposeTerminal, fitTerminal, focusTerminal, refitTerminal, setRevealHandler } from "../terminal-views";
import { AgentIcon } from "./agent-icons";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "./ContextMenu";
import { prompt } from "./Dialog";
import { TerminalHost } from "./TerminalHost";
import { BranchIcon, CloseIcon, CommentIcon, ExclamationIcon, PlusIcon, QuestionIcon, SpinnerIcon } from "./icons";

/** Dragging the window edge fires dozens of observations, and every pty resize repaints the TUI. */
const RESIZE_DEBOUNCE_MS = 100;
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
  /** This project's tabs. Held by App, since the project list needs every project's. */
  tabs: TerminalDescriptor[];
  visible: boolean;
  /** Whether the git pane beside this one is open; the button in the strip shows which. */
  gitOpen: boolean;
  onToggleGit: () => void;
  /** Anything slow outside this pane — a branch command, a diff being read — for the one bar. */
  externalBusy: boolean;
  /** A file ctrl-clicked in a terminal; it opens over everything as a diff. */
  onOpenDiff: (projectId: string, path: string) => void;
  /**
   * A tab opened from outside this pane — a shell from the project's row, a saved command's own
   * terminal, a session the project row's mark points at — to be brought to the front once the
   * host reports it. The nonce is what makes asking for the *same* tab twice work.
   */
  openedTab: { tabId: string; nonce: number } | null;
  /** Which tab is in front, so App can tell a finished session that was seen from one that wasn't. */
  onActiveTab: (projectId: string, tabId: string | null) => void;
  /** Tabs whose finished turn is still waiting to be looked at — App decides, this draws it. */
  markedTabIds: string[];
  /** Tabs stopped mid-turn on an unanswered question — decided in App for the same reason. */
  waitingTabIds: string[];
}

export const TerminalsPane = memo(function TerminalsPane({
  project,
  tabs,
  visible,
  gitOpen,
  onToggleGit,
  externalBusy,
  onOpenDiff,
  openedTab,
  onActiveTab,
  markedTabIds,
  waitingTabIds
}: TerminalsPaneProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [plusMenu, setPlusMenu] = useState<{ x: number; y: number } | null>(null);
  const [starting, setStarting] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const stack = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const knownTabs = useRef<TerminalDescriptor[]>([]);
  /** The last request this pane was told to act on, so each one brings a tab up exactly once. */
  const opened = useRef<number | null>(null);
  /** Whether onStartupProgress has fired; the initial query must not overwrite a push. */
  const progressPushed = useRef(false);

  useEffect(() => {
    void (async () => {
      const [available, isStarting] = await Promise.all([
        window.meezeek.agents.list(),
        window.meezeek.terminals.starting(project.id)
      ]);
      setAgents(available);
      if (!progressPushed.current) {
        setStarting(isStarting);
      }
    })();
  }, [project.id]);

  // App is what holds the tabs, and it is the half that can tell "this session finished while
  // its terminal was in front of the user" from "it finished out of sight".
  useEffect(() => onActiveTab(project.id, activeId), [onActiveTab, project.id, activeId]);

  useEffect(
    () =>
      window.meezeek.terminals.onStartupProgress(({ projectId, show }) => {
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
    // xterm follows the pane at once — dragging a sash would otherwise leave a strip of empty
    // background until the debounce fires. Only the pty resize waits, since it repaints the CLI.
    const observer = new ResizeObserver(() => {
      if (!visible || !activeId) {
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

  const createTab = useCallback(
    async (agentId: AgentId) => {
      const descriptor = await window.meezeek.terminals.create(project.id, agentId);
      setActiveId(descriptor.tabId);
    },
    [project.id]
  );

  /**
   * Selects a tab someone else opened, once it has arrived in the list. Only once per request:
   * the value stays set afterwards, and the list changes for every status update — without
   * this the selection would jump back while the user is somewhere else. Keyed by the nonce
   * rather than the tab id, because the *same* tab can be asked for twice: a session the mark
   * already took the user to can finish again while they are elsewhere.
   */
  useEffect(() => {
    if (!openedTab || opened.current === openedTab.nonce || !tabs.some((tab) => tab.tabId === openedTab.tabId)) {
      return;
    }
    opened.current = openedTab.nonce;
    setActiveId(openedTab.tabId);
  }, [openedTab, tabs]);

  const closeTabs = useCallback(
    (tabIds: string[]) => void window.meezeek.terminals.close(project.id, tabIds),
    [project.id]
  );

  const closeTabMenu = useCallback(() => setTabMenu(null), []);

  // Ctrl+clicking a changed file in a terminal opens that file's diff over everything.
  useEffect(() => setRevealHandler(project.id, (path) => onOpenDiff(project.id, path)), [project.id, onOpenDiff]);

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
        void window.meezeek.terminals.rename(project.id, tab.tabId, answer.value);
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
   * VS Code's editor tab context menu, reduced to its close actions plus rename. What a close
   * action would close is what decides whether it is enabled, so "nothing to close" (a
   * right-click on the only tab, or on the last one) renders it disabled.
   */
  const tabMenuEntries = (tabId: string): ContextMenuEntry[] => {
    const ids = tabs.map((tab) => tab.tabId);
    const renamable = tabs.find((tab) => tab.tabId === tabId && tab.hasSession);
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

  const newSessionEntries: ContextMenuEntry[] = agents.map((agent) => ({
    label: agent.displayName,
    icon: <AgentIcon agentId={agent.id} className="terminal-tab-icon" />,
    run: () => void createTab(agent.id)
  }));

  return (
    <div className={`terminals-pane${visible ? "" : " pane-hidden"}`}>
      <div className="terminal-tabs">
        {/* Where the git tab used to be, and no longer a tab: it shows a pane of its own
            beside this one rather than taking its place. */}
        <button
          className={`git-toggle${gitOpen ? " active" : ""}`}
          onClick={onToggleGit}
          title={gitOpen ? "Hide the repository" : "Show the repository"}
        >
          <BranchIcon className="terminal-tab-icon" />
          <span>Git</span>
        </button>
        <div className="terminal-tab-strip" ref={strip}>
          {tabs.map((tab) => (
          <div
            key={tab.tabId}
            className={`terminal-tab${tab.tabId === activeId ? " active" : ""}${tab.status === "stopped" ? " inactive" : ""}`}
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
            {/* What this session is doing takes the agent icon's place rather than claiming room
                of its own — the tab is as wide as its label and nothing more. In the order of
                how much they say: a tab whose agent cannot even start, or whose process ended on
                its own rather than at the user's own request, outranks everything else — none of
                the other three can ever be true for it. Of the rest, a standing question outranks
                working, because such a session is precisely *not* working and nothing moves until
                it is answered; working outranks finished, since a turn that started after the
                last one ended is the newer truth, and the mark is still there underneath for when
                it stops. */}
            {tab.status === "missing" || tab.status === "error" ? (
              <ExclamationIcon className="terminal-tab-icon session-mark session-mark-error" />
            ) : waitingTabIds.includes(tab.tabId) ? (
              <QuestionIcon className="terminal-tab-icon session-mark" />
            ) : tab.busy ? (
              <SpinnerIcon className="terminal-tab-icon session-mark spinning" />
            ) : markedTabIds.includes(tab.tabId) ? (
              <CommentIcon className="terminal-tab-icon session-mark" />
            ) : (
              <AgentIcon agentId={tab.agentId} className="terminal-tab-icon" />
            )}
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
            it — a starting agent here, and whatever the git pane or an open diff reports. */}
        {(starting || externalBusy) && (
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
              // The context menu's own outside-click handler already closed it by the time
              // this runs (it listens on the capture phase), so a second click only reopens
              // when the check below still sees the menu as open from before that happened.
              if (plusMenu) {
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              setPlusMenu({ x: rect.left, y: rect.bottom + 6 });
            }}
          >
            <PlusIcon />
          </button>
        </div>
      </div>

      <div className="terminal-stack" ref={stack}>
        {tabs.map((tab) => (
          <TerminalHost
            key={tab.tabId}
            projectId={project.id}
            tabId={tab.tabId}
            agentId={tab.agentId}
            active={tab.tabId === activeId}
            visible={visible}
          />
        ))}
        {tabs.length === 0 && <div className="placeholder">No sessions open.</div>}
      </div>

      {tabMenu && (
        <ContextMenu x={tabMenu.x} y={tabMenu.y} entries={tabMenuEntries(tabMenu.tabId)} onClose={closeTabMenu} />
      )}
      {plusMenu && (
        <ContextMenu
          x={plusMenu.x}
          y={plusMenu.y}
          entries={newSessionEntries}
          onClose={() => setPlusMenu(null)}
          className="new-session-menu"
        />
      )}
    </div>
  );
});
