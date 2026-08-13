import { useEffect, useRef } from "react";
import { attachTerminal } from "../terminal-views";

interface TerminalHostProps {
  projectId: string;
  tabId: string;
  /** The one on screen in its pane; the others keep their layout but stay hidden. */
  active: boolean;
}

/**
 * Where one xterm instance is mounted. The instance itself lives outside React in
 * `terminal-views.ts` and survives this component — attaching is what moves it into the DOM.
 *
 * Its own file rather than TerminalsPane's, because the git tab mounts one too and importing
 * it from there would be a cycle.
 */
export function TerminalHost({ projectId, tabId, active }: TerminalHostProps) {
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
