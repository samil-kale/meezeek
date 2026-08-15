import { useEffect, useRef } from "react";
import type { AgentId } from "../../shared/types";
import { attachTerminal } from "../terminal-views";

interface TerminalHostProps {
  projectId: string;
  tabId: string;
  /** Which agent's terminal this is — one colour of the theme depends on it (see theme.ts). */
  agentId: AgentId;
  /** The one on screen in its pane; the others keep their layout but stay hidden. */
  active: boolean;
  /** Whether the pane itself is on screen — the project is the one selected. */
  visible: boolean;
}

/**
 * Where one xterm instance is mounted. The instance lives outside React in `terminal-views.ts`
 * and survives this component — attaching is what moves it into the DOM.
 *
 * Attached the first time the tab is actually in front of the user, not on mount: every tab of
 * every project mounts at startup, and building an xterm — theme read off the stylesheet, its
 * DOM, a character measurement — for each of them, before the first paint, was most of what the
 * window did while coming up. Nothing is lost by waiting: a tab's process is only started by
 * its first fit, which needs the view, and output for a view that does not exist is dropped by
 * `terminal-views` for a tab that cannot have produced any. Once attached it stays attached.
 */
export function TerminalHost({ projectId, tabId, agentId, active, visible }: TerminalHostProps) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (active && visible && container.current) {
      attachTerminal(projectId, tabId, agentId, container.current);
    }
  }, [projectId, tabId, agentId, active, visible]);

  // "hidden" is visibility, not display — xterm needs a laid-out element to measure itself,
  // both when it opens and when output arrives for a background tab.
  return <div ref={container} className={`terminal-host${active ? "" : " hidden"}`} />;
}
