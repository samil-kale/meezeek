import { useEffect, useRef, useState, type DragEvent } from "react";
import type { ProjectAction } from "../../shared/types";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { confirm, prompt } from "./Dialog";
import { PlayIcon, PlusIcon, SparkleIcon, SpinnerIcon } from "./icons";

/**
 * A type of our own, for the same reason the project list has one: a row dragged across a
 * terminal must not end up pasted into it, and this list is no target for anything else.
 */
const DRAG_TYPE = "application/x-meeseek-action";

/** The whole action as a tooltip: the command, where it runs, and what it runs with. */
function describe(action: ProjectAction): string {
  const lines = [action.command];
  if (action.cwd) {
    lines.push(`in ${action.cwd}`);
  }
  for (const [name, value] of Object.entries(action.env ?? {})) {
    lines.push(`${name}=${value}`);
  }
  if (action.shell) {
    lines.push("through a shell, so only on this platform");
  }
  return lines.join("\n");
}

interface ActionListProps {
  /** Whose actions these are; null when no project is open. */
  projectId: string | null;
  /** Dragged on the sash above the list, which is why it isn't a style of its own. */
  height: number;
  /** The tab a started command opened, so the app can bring it to the front. */
  onOpenTab: (projectId: string, tabId: string) => void;
}

/**
 * A project's saved shell commands, under the project list. They come from a meeseek.json in
 * the repository's own root, so they belong to the project rather than to this machine — and
 * they change with the project the sidebar has selected.
 *
 * Running one opens a terminal tab and hands it over: the command is that tab's process, so
 * this list has nothing to report afterwards and keeps no state about what is going.
 */
export function ActionList({ projectId, height, onOpenTab }: ActionListProps) {
  const [actions, setActions] = useState<ProjectAction[]>([]);
  /** The projects the wand is out for; this view outlives a project switch. */
  const [suggestingIn, setSuggestingIn] = useState<string[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; action: ProjectAction } | null>(null);
  /**
   * The projects the automatic lookup has already run for. A set, not one id: switching away
   * and back would otherwise start it over, and it costs an agent run each time.
   */
  const autoSuggested = useRef(new Set<string>());
  /** Which project is on screen, readable from a callback that started before a switch. */
  const shown = useRef(projectId);
  /** The list as it stands now, for callbacks that were made before the last change to it. */
  const latest = useRef<ProjectAction[]>([]);
  const [dragged, setDragged] = useState<number | null>(null);
  /** Where the dragged action would land: the index it would take among the others. */
  const [dropAt, setDropAt] = useState<number | null>(null);

  const suggesting = projectId !== null && suggestingIn.includes(projectId);

  useEffect(() => {
    shown.current = projectId;
  }, [projectId]);

  useEffect(() => {
    if (!projectId) {
      applyActions([]);
      return;
    }
    let cancelled = false;
    void window.meeseek.actions.list(projectId).then((saved) => {
      if (cancelled) {
        return;
      }
      applyActions(saved ?? []);
      // No meeseek.json at all: nobody has set this project up here, which is the one moment
      // where looking its commands up unasked is worth the wait. A file with an empty list is
      // someone having deleted them all, and stays empty.
      if (saved === null && !autoSuggested.current.has(projectId)) {
        autoSuggested.current.add(projectId);
        void suggest(projectId);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  /**
   * Every change to the list goes through here, and `latest` is what it is computed from
   * rather than the `actions` a callback closed over: a dialog is awaited, and the wand can
   * finish while one stands open — adding a command off the pre-dialog list would then write
   * the found ones straight back out of the file.
   */
  const applyActions = (next: ProjectAction[]): void => {
    latest.current = next;
    setActions(next);
  };

  /** The list is written whole; the file is the record, this is only what is on screen. */
  const save = (next: ProjectAction[]): void => {
    if (!projectId) {
      return;
    }
    applyActions(next);
    void window.meeseek.actions.save(projectId, next);
  };

  const askAdd = async (): Promise<void> => {
    const answer = await prompt({
      title: "New action",
      label: "Command",
      detail: "Saved to meeseek.json in the project.",
      value: "",
      confirmLabel: "Save",
      extra: { label: "Folder (optional)", placeholder: "relative to the project, e.g. web" }
    });
    if (answer === null) {
      return;
    }
    const action: ProjectAction = answer.extra ? { command: answer.value, cwd: answer.extra } : { command: answer.value };
    const current = latest.current;
    if (!current.some((entry) => entry.command === action.command && entry.cwd === action.cwd)) {
      save([...current, action]);
    }
  };

  const askRemove = async (action: ProjectAction): Promise<void> => {
    const answer = await confirm({
      title: "Delete action",
      message: `Delete "${action.command}"?`,
      detail: "It is removed from the project's meeseek.json.",
      confirmLabel: "Delete"
    });
    if (answer.confirmed) {
      save(latest.current.filter((entry) => entry !== action));
    }
  };

  /**
   * The wand. The agent reads the project and names what it can run; whatever comes back is
   * added to the list, and the whole list comes back so this does not have to re-read the
   * file. It can take minutes, which is long enough for the user to have moved on — the
   * result then belongs to a project this view is no longer showing, and only the file it was
   * already written to. Putting it on screen anyway would show one project's commands under
   * another's name, and the next drag would save them there.
   */
  const suggest = async (project: string): Promise<void> => {
    if (suggestingIn.includes(project)) {
      return;
    }
    setSuggestingIn((current) => [...current, project]);
    try {
      const found = await window.meeseek.actions.suggest(project);
      if (shown.current === project) {
        applyActions(found);
      }
    } finally {
      setSuggestingIn((current) => current.filter((entry) => entry !== project));
    }
  };

  /** Opens the tab the command runs in and switches to it; the tab is where it is watched. */
  const run = (action: ProjectAction): void => {
    if (!projectId) {
      return;
    }
    const project = projectId;
    void window.meeseek.actions.run(project, action).then((tab) => {
      if (tab) {
        onOpenTab(project, tab.tabId);
      }
    });
  };

  /**
   * Reordering, the same way the project list does it — see ProjectList for why the drag type
   * is one of our own and why the insertion index is read off the event rather than off the
   * state the last dragover left behind.
   */
  const insertionIndex = (event: DragEvent<HTMLDivElement>, index: number): number => {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientY < box.top + box.height / 2 ? index : index + 1;
  };

  // The row's position, not its command: the same command can be in the list twice, once per
  // folder it runs in.
  const begin = (event: DragEvent<HTMLDivElement>, index: number): void => {
    event.dataTransfer.setData(DRAG_TYPE, String(index));
    event.dataTransfer.effectAllowed = "move";
    setDragged(index);
  };

  const over = (event: DragEvent<HTMLDivElement>, index: number): void => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropAt(insertionIndex(event, index));
  };

  const move = (from: number, to: number): void => {
    setDragged(null);
    setDropAt(null);
    const action = actions[from];
    if (!action) {
      return;
    }
    const reordered = actions.filter((_, position) => position !== from);
    // Everything behind it moves up once it is out of the list, so a target past it is one
    // index closer than it looked.
    reordered.splice(to > from ? to - 1 : to, 0, action);
    save(reordered);
  };

  const drop = (event: DragEvent<HTMLDivElement>, index: number): void => {
    event.preventDefault();
    move(Number(event.dataTransfer.getData(DRAG_TYPE)), insertionIndex(event, index));
  };

  /** The empty space below the last action, which stands for the end of the list. */
  const isBelowList = (event: DragEvent<HTMLDivElement>): boolean => event.target === event.currentTarget;

  const overEnd = (event: DragEvent<HTMLDivElement>): void => {
    if (!isBelowList(event) || !event.dataTransfer.types.includes(DRAG_TYPE)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropAt(actions.length);
  };

  const dropAtEnd = (event: DragEvent<HTMLDivElement>): void => {
    if (!isBelowList(event)) {
      return;
    }
    event.preventDefault();
    move(Number(event.dataTransfer.getData(DRAG_TYPE)), actions.length);
  };

  const itemClass = (index: number): string => {
    const classes = ["action-item"];
    if (index === dragged) {
      classes.push("dragging");
    }
    if (dropAt === index) {
      classes.push("drop-above");
    }
    // The last row carries the line for the position behind it; there is no row after it.
    if (dropAt === actions.length && index === actions.length - 1) {
      classes.push("drop-below");
    }
    return classes.join(" ");
  };

  const menuEntries = (action: ProjectAction): ContextMenuEntry[] => [
    { label: "Run", run: () => run(action) },
    { label: "Delete...", run: () => void askRemove(action) }
  ];

  return (
    <div className="action-list" style={{ height }}>
      <div className="sidebar-header">
        <span>
          ACTIONS <span className="count">({actions.length})</span>
        </span>
        <span className="sidebar-header-actions">
          {/* The button becomes the progress: an agent reading a repository takes a while,
              and this is the only place that wait belongs. */}
          <button
            className={`icon-button${suggesting ? " busy" : ""}`}
            title={suggesting ? "Looking for commands..." : "Have an agent find this project's commands"}
            disabled={!projectId || suggesting}
            onClick={() => projectId && void suggest(projectId)}
          >
            {suggesting ? <SpinnerIcon className="spinning" /> : <SparkleIcon />}
          </button>
          <button className="icon-button" title="New action" disabled={!projectId} onClick={() => void askAdd()}>
            <PlusIcon />
          </button>
        </span>
      </div>
      <div className="action-items" onDragOver={overEnd} onDrop={dropAtEnd}>
        {actions.map((action, index) => (
          <div
            // The position, not the command: the same command can be in the list more than
            // once — another folder, another set of variables — and the rows hold no state
            // of their own that reordering could carry to the wrong one.
            key={index}
            className={itemClass(index)}
            title={describe(action)}
            draggable
            onDragStart={(event) => begin(event, index)}
            onDragOver={(event) => over(event, index)}
            onDrop={(event) => drop(event, index)}
            onDragEnd={() => {
              setDragged(null);
              setDropAt(null);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, action });
            }}
          >
            <span className="action-command">{action.command}</span>
            {/* Where it runs, when that is not the project root — the command alone would
                otherwise look like it belongs to a folder that has no such script. */}
            {action.cwd && <span className="action-cwd">{action.cwd}</span>}
            <button className="icon-button" title={`Run ${action.command} in a new tab`} onClick={() => run(action)}>
              <PlayIcon />
            </button>
          </div>
        ))}
        {projectId && actions.length === 0 && <div className="placeholder">No actions yet.</div>}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.action)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
