import { useEffect, useRef, useState, type DragEvent } from "react";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { confirm, prompt } from "./Dialog";
import { PlayIcon, PlusIcon, SparkleIcon, SpinnerIcon } from "./icons";

/**
 * A type of our own, for the same reason the project list has one: a row dragged across a
 * terminal must not end up pasted into it, and this list is no target for anything else.
 */
const DRAG_TYPE = "application/x-meeseek-action";

interface ActionListProps {
  /** Whose actions these are; null when no project is open. */
  projectId: string | null;
  /** Dragged on the sash above the list, which is why it isn't a style of its own. */
  height: number;
}

/**
 * A project's saved shell commands, under the project list. They come from a meeseek.json in
 * the repository's own root, so they belong to the project rather than to this machine — and
 * they change with the project the sidebar has selected.
 *
 * Running one shows nothing while it goes; the notice at the end says how it went. Anything
 * you want to watch belongs in a terminal, which is what the tabs next door are for.
 */
export function ActionList({ projectId, height }: ActionListProps) {
  const [actions, setActions] = useState<string[]>([]);
  const [running, setRunning] = useState<string[]>([]);
  /** The wand is out asking an agent; a second press would only ask the same thing again. */
  const [suggesting, setSuggesting] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; command: string } | null>(null);
  /** The project the automatic lookup has already run for; it is not offered a second time. */
  const autoSuggested = useRef<string | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  /** Where the dragged action would land: the index it would take among the others. */
  const [dropAt, setDropAt] = useState<number | null>(null);

  useEffect(() => {
    if (!projectId) {
      setActions([]);
      return;
    }
    let cancelled = false;
    void window.meeseek.actions.list(projectId).then((saved) => {
      if (cancelled) {
        return;
      }
      setActions(saved ?? []);
      // No meeseek.json at all: nobody has set this project up here, which is the one moment
      // where looking its commands up unasked is worth the wait. A file with an empty list is
      // someone having deleted them all, and stays empty.
      if (saved === null && autoSuggested.current !== projectId) {
        autoSuggested.current = projectId;
        void suggest();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  /** The list is written whole; the file is the record, this is only what is on screen. */
  const save = (next: string[]): void => {
    if (!projectId) {
      return;
    }
    setActions(next);
    void window.meeseek.actions.save(projectId, next);
  };

  const askAdd = async (): Promise<void> => {
    const command = await prompt({
      title: "New action",
      label: "Command",
      detail: "Saved to meeseek.json in the project, and run in its directory.",
      value: "",
      confirmLabel: "Save"
    });
    if (command !== null && !actions.includes(command)) {
      save([...actions, command]);
    }
  };

  const askRemove = async (command: string): Promise<void> => {
    const answer = await confirm({
      title: "Delete action",
      message: `Delete "${command}"?`,
      detail: "It is removed from the project's meeseek.json.",
      confirmLabel: "Delete"
    });
    if (answer.confirmed) {
      save(actions.filter((entry) => entry !== command));
    }
  };

  /**
   * The wand. The agent reads the project and names what it can run; whatever comes back is
   * added to the list, and the whole list comes back so this does not have to re-read the
   * file. It can take a while — the button says so by being disabled.
   */
  const suggest = async (): Promise<void> => {
    if (!projectId || suggesting) {
      return;
    }
    setSuggesting(true);
    try {
      setActions(await window.meeseek.actions.suggest(projectId));
    } finally {
      setSuggesting(false);
    }
  };

  /** Marked as running until it answers, so a long one is not started twice over. */
  const run = (command: string): void => {
    if (!projectId || running.includes(command)) {
      return;
    }
    setRunning((current) => [...current, command]);
    void window.meeseek.actions
      .run(projectId, command)
      .finally(() => setRunning((current) => current.filter((entry) => entry !== command)));
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

  const begin = (event: DragEvent<HTMLDivElement>, command: string): void => {
    event.dataTransfer.setData(DRAG_TYPE, command);
    event.dataTransfer.effectAllowed = "move";
    setDragged(command);
  };

  const over = (event: DragEvent<HTMLDivElement>, index: number): void => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropAt(insertionIndex(event, index));
  };

  const move = (command: string, to: number): void => {
    setDragged(null);
    setDropAt(null);
    const from = actions.indexOf(command);
    if (from < 0) {
      return;
    }
    const reordered = actions.filter((_, position) => position !== from);
    // Everything behind it moves up once it is out of the list, so a target past it is one
    // index closer than it looked.
    reordered.splice(to > from ? to - 1 : to, 0, command);
    save(reordered);
  };

  const drop = (event: DragEvent<HTMLDivElement>, index: number): void => {
    event.preventDefault();
    move(event.dataTransfer.getData(DRAG_TYPE), insertionIndex(event, index));
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
    move(event.dataTransfer.getData(DRAG_TYPE), actions.length);
  };

  const itemClass = (command: string, index: number): string => {
    const classes = ["action-item"];
    if (running.includes(command)) {
      classes.push("running");
    }
    if (command === dragged) {
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

  const menuEntries = (command: string): ContextMenuEntry[] => [
    { label: "Run", run: () => run(command) },
    { label: "Delete...", run: () => void askRemove(command) }
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
            onClick={() => void suggest()}
          >
            {suggesting ? <SpinnerIcon className="spinning" /> : <SparkleIcon />}
          </button>
          <button className="icon-button" title="New action" disabled={!projectId} onClick={() => void askAdd()}>
            <PlusIcon />
          </button>
        </span>
      </div>
      <div className="action-items" onDragOver={overEnd} onDrop={dropAtEnd}>
        {actions.map((command, index) => (
          <div
            key={command}
            className={itemClass(command, index)}
            title={command}
            draggable
            onDragStart={(event) => begin(event, command)}
            onDragOver={(event) => over(event, index)}
            onDrop={(event) => drop(event, index)}
            onDragEnd={() => {
              setDragged(null);
              setDropAt(null);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, command });
            }}
          >
            <span className="action-command">{command}</span>
            <button
              className="icon-button"
              title={running.includes(command) ? "Running..." : `Run ${command}`}
              disabled={running.includes(command)}
              onClick={() => run(command)}
            >
              <PlayIcon />
            </button>
          </div>
        ))}
        {projectId && actions.length === 0 && <div className="placeholder">No actions yet.</div>}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.command)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
