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
}

/**
 * Where one xterm instance is mounted. The instance lives outside React in `terminal-views.ts`
 * and survives this component — attaching is what moves it into the DOM.
 *
 * Its own file rather than TerminalsPane's, because the git tab mounts one too and importing it
 * from there would be a cycle.
 */
export function TerminalHost({ projectId, tabId, agentId, active }: TerminalHostProps) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (container.current) {
      attachTerminal(projectId, tabId, agentId, container.current);
    }
  }, [projectId, tabId, agentId]);

  // "hidden" is visibility, not display — xterm needs a laid-out element to measure itself,
  // both when it opens and when output arrives for a background tab.
  return <div ref={container} className={`terminal-host${active ? "" : " hidden"}`} />;
}
