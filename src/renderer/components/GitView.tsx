import { useEffect, useRef, useState } from "react";
import type {
  AgentId,
  AgentInfo,
  ChangeStatus,
  FileChange,
  FileDiff,
  GitActionResult,
  Project,
  RepositoryState,
  TerminalDescriptor
} from "../../shared/types";
import { isMac, isWindows } from "../platform";
import { fitTerminal, refitTerminal } from "../terminal-views";
import { BranchTree, type BranchActions } from "./BranchTree";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "./ContextMenu";
import { confirm } from "./Dialog";
import { DiffView } from "./DiffView";
import { notify } from "./Notices";
import { Sash } from "./Sash";
import { TerminalHost } from "./TerminalHost";

/**
 * The two sizes the git tab's panels can be dragged to. Held by the app rather than by this
 * view: every project has a git tab of its own, and they all show the same layout.
 */
export interface GitPaneSizes {
  panelsWidth: number;
  onPanelsWidth: (size: number) => void;
  treeHeight: number;
  onTreeHeight: (size: number) => void;
  consoleHeight: number;
  onConsoleHeight: (size: number) => void;
}

interface GitViewProps {
  project: Project;
  state: RepositoryState;
  sizes: GitPaneSizes;
  /** Passed straight through to the tree, which is the only place they are offered. */
  branch: BranchActions;
  /** What the console's dropdown may offer. */
  agents: AgentInfo[];
  /** This project's console session, once one has been opened. */
  console?: TerminalDescriptor;
  /**
   * Repository-relative path of the file whose diff is shown. Owned by the pane, so a file
   * ctrl-clicked in a terminal can open this tab on it.
   */
  selected: string | null;
  onSelect: (path: string) => void;
  /** Everything this view has to wait for: reading and coloring the diff, and file actions. */
  onBusy: (busy: boolean) => void;
  /** False while another tab is on screen; the view stays mounted so its selection survives. */
  active: boolean;
}

/** Dragging the sash fires dozens of observations; the pty is resized once they stop. */
const CONSOLE_RESIZE_DEBOUNCE_MS = 100;

const STATUS_LETTER: Record<ChangeStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "?",
  conflicted: "C"
};

/** What each platform calls its own file manager, the way GitHub Desktop names them. */
function revealLabel(): string {
  if (isMac()) {
    return "Reveal in Finder";
  }
  return isWindows() ? "Show in Explorer" : "Show in your file manager";
}

export function GitView({
  project,
  state,
  sizes,
  branch,
  agents,
  console: consoleTab,
  selected,
  onSelect,
  onBusy,
  active
}: GitViewProps) {
  const [filter, setFilter] = useState("");
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(false);
  /** A file action is running; the same bar the diff uses, so both are reported as one. */
  const [acting, setActing] = useState(false);
  const [diffBusy, setDiffBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; change: FileChange } | null>(null);
  const consoleBody = useRef<HTMLDivElement>(null);
  /** A console is being replaced; nothing may open a second one in the gap. */
  const switchingConsole = useRef(false);
  /** `git diff -w`. Per project rather than per file: it is how the user wants to read. */
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);

  const query = filter.trim().toLowerCase();
  const visible = state.changes.filter((change) => change.path.toLowerCase().includes(query));

  // Reloads whenever the selection changes and whenever the repository state changed, so an
  // agent editing the selected file updates the diff on screen.
  useEffect(() => {
    if (!selected) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void window.meeseek.repository.diff(project.id, selected, { ignoreWhitespace }).then((result) => {
      if (cancelled) {
        return;
      }
      if (result.error) {
        notify("error", `${result.path}: ${result.error}`);
      }
      setDiff(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [project.id, selected, state.changes, ignoreWhitespace]);

  useEffect(() => onBusy(diffBusy || acting), [diffBusy, acting, onBusy]);

  /**
   * The console opens with the git tab and stays for the project's lifetime, running whatever
   * this project picked last. A shell when it never picked one: this is the pane you type git
   * commands into, and that is what a shell is for.
   */
  useEffect(() => {
    if (active && !consoleTab && !switchingConsole.current) {
      void window.meeseek.terminals.create(project.id, project.consoleAgent ?? "shell", true);
    }
  }, [active, consoleTab, project.id, project.consoleAgent]);

  /**
   * Only one console per project, so switching agents replaces it: the running one is closed —
   * which ends its session — and the new one takes its place. The flag holds off the effect
   * above, which would otherwise see the gap between the two and open a shell into it.
   */
  const switchConsole = (agentId: AgentId): void => {
    if (!consoleTab || consoleTab.agentId === agentId) {
      return;
    }
    switchingConsole.current = true;
    void window.meeseek.terminals
      .close(project.id, [consoleTab.tabId])
      .then(() => window.meeseek.terminals.create(project.id, agentId, true))
      // Remembered for the next time this project is opened, in its own meeseek.json.
      .then(() => window.meeseek.projects.setConsoleAgent(project.id, agentId))
      .finally(() => {
        switchingConsole.current = false;
      });
  };

  // While the git tab was off screen the console had no layout to measure itself against, so
  // its last measured size is stale. This is also what starts its process the first time.
  useEffect(() => {
    if (active && consoleTab) {
      fitTerminal(project.id, consoleTab.tabId);
    }
  }, [active, consoleTab, project.id]);

  // xterm follows the pane immediately, so dragging the sash never leaves an empty strip;
  // the pty hears about it once the dragging settles, because every pty resize repaints the
  // CLI in full.
  useEffect(() => {
    const element = consoleBody.current;
    if (!element || !consoleTab) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (!active) {
        return;
      }
      refitTerminal(project.id, consoleTab.tabId);
      clearTimeout(timer);
      timer = setTimeout(() => fitTerminal(project.id, consoleTab.tabId), CONSOLE_RESIZE_DEBOUNCE_MS);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [active, consoleTab, project.id]);

  /** Runs a file action against the repository and reports what it says when it failed. */
  const act = (action: () => Promise<GitActionResult>): void => {
    setActing(true);
    void action()
      .then((result) => {
        if (!result.ok) {
          notify("error", result.error ?? "Git command failed");
        }
      })
      .finally(() => setActing(false));
  };

  /**
   * Asks before throwing work away — the one file action here that cannot be undone, except
   * through the trash the discard puts untracked files in.
   */
  const confirmDiscard = async (paths: string[]): Promise<void> => {
    const what = paths.length === 1 ? paths[0] : `${paths.length} files`;
    const answer = await confirm({
      title: "Discard changes",
      message: `Are you sure you want to discard all changes to ${what}?`,
      detail: "Files git does not track go to the trash and can be restored from there.",
      confirmLabel: "Discard changes"
    });
    if (answer.confirmed) {
      act(() => window.meeseek.repository.discard(project.id, paths));
    }
  };

  /**
   * GitHub Desktop's changed-file menu, minus the editor entries meeseek has nothing to open
   * with. Ignoring is offered for untracked files only: a file git already tracks stays
   * tracked whatever .gitignore says, so the entry would do nothing anyone can see.
   */
  const menuEntries = (change: FileChange): ContextMenuEntry[] => {
    // git reports every path relative to the root with forward slashes; the clipboard should
    // hold one the platform's own tools accept.
    const absolute = [project.path, ...change.path.split("/")].join(isWindows() ? "\\" : "/");
    const extension = /\.[^./]+$/.exec(change.path)?.[0];
    const discard = (paths: string[]) => () => void confirmDiscard(paths);
    const ignore = (scope: "file" | "extension") => () =>
      act(() => window.meeseek.repository.ignore(project.id, change.path, scope));

    const entries: ContextMenuEntry[] = [
      { label: "Discard changes...", run: discard([change.path]) },
      {
        label: "Discard all changes...",
        // With a single change it would be the entry above under another name.
        run: state.changes.length > 1 ? discard(state.changes.map((entry) => entry.path)) : undefined
      },
      SEPARATOR,
      { label: revealLabel(), run: () => void window.meeseek.shell.revealFile(project.id, change.path) },
      { label: "Copy file path", run: () => void navigator.clipboard.writeText(absolute) },
      { label: "Copy relative file path", run: () => void navigator.clipboard.writeText(change.path) }
    ];
    if (change.status === "untracked") {
      entries.push(SEPARATOR, { label: "Ignore file (add to .gitignore)", run: ignore("file") });
      if (extension) {
        entries.push({ label: `Ignore all ${extension} files (add to .gitignore)`, run: ignore("extension") });
      }
    }
    return entries;
  };

  return (
    <div className={`git-view${active ? "" : " pane-hidden"}`}>
      <div className="git-panels" style={{ width: sizes.panelsWidth }}>
        <BranchTree state={state} height={sizes.treeHeight} branch={branch} />
        <Sash
          orientation="horizontal"
          size={sizes.treeHeight}
          min={80}
          minOther={100}
          onResize={sizes.onTreeHeight}
        />
        <div className="changes-list">
          <input
            className="changes-filter"
            type="text"
            placeholder="Filter changes..."
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <div className="changes-files">
            {visible.map((change) => (
              <button
                key={change.path}
                className={`change-item${change.path === selected ? " selected" : ""}`}
                onClick={() => onSelect(change.path)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ x: event.clientX, y: event.clientY, change });
                }}
                title={change.origPath ? `${change.origPath} → ${change.path}` : change.path}
              >
                <span className={`change-status ${change.status}`}>{STATUS_LETTER[change.status]}</span>
                <span className="change-path">{change.path}</span>
              </button>
            ))}
            {state.changes.length === 0 && <div className="placeholder">No local changes.</div>}
          </div>
        </div>
      </div>
      <Sash
        orientation="vertical"
        size={sizes.panelsWidth}
        min={180}
        minOther={200}
        onResize={sizes.onPanelsWidth}
      />
      {/* The right half: the diff, and the console under it. The branches and the changed
          files keep the full height on the left. */}
      <div className="git-right">
        <div className="changes-diff">
          <DiffView
            projectId={project.id}
            diff={diff}
            loading={loading}
            onBusy={setDiffBusy}
            ignoreWhitespace={ignoreWhitespace}
            onIgnoreWhitespace={setIgnoreWhitespace}
          />
        </div>

        <Sash
          orientation="horizontal"
          size={sizes.consoleHeight}
          min={80}
          minFraction={0.2}
          minOther={160}
          reverse
          onResize={sizes.onConsoleHeight}
        />

        {/* One console for the whole git tab. Which agent runs in it is the dropdown's
            business; switching replaces the session, there is never a second. */}
        <div className="git-console" style={{ height: sizes.consoleHeight }}>
          <div className="git-console-bar">
            <select
              value={consoleTab?.agentId ?? "shell"}
              disabled={!consoleTab}
              onChange={(event) => switchConsole(event.target.value as AgentId)}
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.displayName}
                </option>
              ))}
            </select>
          </div>
          {/* The terminal places itself absolutely, so it needs a box of its own to fill —
              otherwise it would sit over the bar above it. */}
          <div className="git-console-body" ref={consoleBody}>
            {consoleTab && <TerminalHost projectId={project.id} tabId={consoleTab.tabId} active={true} />}
          </div>
        </div>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.change)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
