import { useState, type DragEvent } from "react";
import type { Project, RemoteInfo } from "../../shared/types";
import { revealLabel } from "../platform";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "./ContextMenu";
import { prompt } from "./Dialog";
import { notify } from "./Notices";
import { CloseIcon, PlusIcon } from "./icons";

/**
 * A type of our own rather than text/plain: a project dragged across a terminal must not end
 * up pasted into it, and the terminal only ever reads dropped files and plain text.
 */
const DRAG_TYPE = "application/x-meeseek-project";

interface ProjectListProps {
  projects: Project[];
  activeProjectId: string | null;
  onSelect: (projectId: string) => void;
  onClose: (projectId: string) => void;
  /** The full list in the order the user dropped it into. */
  onReorder: (projects: Project[]) => void;
  onAdd: () => void;
  /** The project's first remote, for the entries that open or change its url. */
  remoteOf: (projectId: string) => RemoteInfo | undefined;
  /** Opens a shell tab in that project, which is what "open in terminal" means here. */
  onOpenTerminal: (projectId: string) => void;
}

/**
 * The page a remote's git url points at, or null when it is not one a browser can open.
 * Both spellings git uses: "git@host:owner/repo.git" and a real url with a scheme.
 */
function webUrl(remoteUrl: string): string | null {
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/)(.+?)(?:\.git)?\/?$/.exec(remoteUrl);
  if (scp) {
    return `https://${scp[1]}/${scp[2]}`;
  }
  try {
    const url = new URL(remoteUrl);
    if (url.protocol === "ssh:") {
      return `https://${url.hostname}${url.pathname.replace(/\.git\/?$/, "")}`;
    }
    if (url.protocol === "https:" || url.protocol === "http:") {
      return `https://${url.host}${url.pathname.replace(/\.git\/?$/, "")}`;
    }
  } catch {
    // Not a url at all — a local path, say. There is nothing to open.
  }
  return null;
}

/** "View on GitHub" where that is where it is, and the host's own name everywhere else. */
function hostName(url: string): string {
  const { hostname } = new URL(url);
  const known = ["GitHub", "GitLab", "Bitbucket"].find((name) => hostname.includes(name.toLowerCase()));
  return known ?? hostname;
}

export function ProjectList({
  projects,
  activeProjectId,
  onSelect,
  onClose,
  onReorder,
  onAdd,
  remoteOf,
  onOpenTerminal
}: ProjectListProps) {
  const [dragged, setDragged] = useState<string | null>(null);
  /** Where the dragged project would land: the index it would take among the others. */
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; project: Project } | null>(null);

  /**
   * The index the dragged project would take, from the pointer's position over one row: past
   * its middle it belongs below it, which is the next index. Both the line on screen and the
   * drop itself go through this, so the two cannot disagree.
   */
  const insertionIndex = (event: DragEvent<HTMLDivElement>, index: number): number => {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientY < box.top + box.height / 2 ? index : index + 1;
  };

  const begin = (event: DragEvent<HTMLDivElement>, projectId: string): void => {
    event.dataTransfer.setData(DRAG_TYPE, projectId);
    event.dataTransfer.effectAllowed = "move";
    setDragged(projectId);
  };

  const over = (event: DragEvent<HTMLDivElement>, index: number): void => {
    // What is being dragged is read off the drag itself rather than off our own state: it is
    // also what tells a project apart from a file dragged in from outside, which this list is
    // no target for.
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) {
      return;
    }
    // Only a prevented dragover makes an element a drop target at all.
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropAt(insertionIndex(event, index));
  };

  const move = (projectId: string, to: number): void => {
    setDragged(null);
    setDropAt(null);
    const from = projects.findIndex((project) => project.id === projectId);
    if (from < 0) {
      return;
    }
    const reordered = projects.filter((_, position) => position !== from);
    // Everything behind the project moves up once it is out of the list, so a target past it
    // is one index closer than it looked.
    reordered.splice(to > from ? to - 1 : to, 0, projects[from]);
    onReorder(reordered);
  };

  const drop = (event: DragEvent<HTMLDivElement>, index: number): void => {
    event.preventDefault();
    // Straight from the event, not from the state the last dragover set: that state exists to
    // draw the line, and a drop must not depend on the render for it having landed yet.
    move(event.dataTransfer.getData(DRAG_TYPE), insertionIndex(event, index));
  };

  /**
   * The empty space below the last project, which stands for the end of the list. Without it
   * the only way to drop a project last would be the lower half of the last row, a strip a
   * few pixels tall. Bubbling brings the rows' own drags here too, so anything that landed on
   * a row is left to the row.
   */
  const isBelowList = (event: DragEvent<HTMLDivElement>): boolean => event.target === event.currentTarget;

  const overEnd = (event: DragEvent<HTMLDivElement>): void => {
    if (!isBelowList(event) || !event.dataTransfer.types.includes(DRAG_TYPE)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropAt(projects.length);
  };

  const dropAtEnd = (event: DragEvent<HTMLDivElement>): void => {
    if (!isBelowList(event)) {
      return;
    }
    event.preventDefault();
    move(event.dataTransfer.getData(DRAG_TYPE), projects.length);
  };

  const end = (): void => {
    setDragged(null);
    setDropAt(null);
  };

  const itemClass = (project: Project, index: number): string => {
    const classes = ["project-item"];
    if (project.id === activeProjectId) {
      classes.push("active");
    }
    if (project.id === dragged) {
      classes.push("dragging");
    }
    if (dropAt === index) {
      classes.push("drop-above");
    }
    // The last row carries the line for the position behind it; there is no row after it.
    if (dropAt === projects.length && index === projects.length - 1) {
      classes.push("drop-below");
    }
    return classes.join(" ");
  };

  const askRemoteUrl = async (project: Project, remote: RemoteInfo): Promise<void> => {
    const answer = await prompt({
      title: "Change remote URL",
      label: `URL of ${remote.name}`,
      value: remote.url ?? "",
      confirmLabel: "Change URL"
    });
    if (!answer || answer.value === remote.url) {
      return;
    }
    const result = await window.meeseek.repository.setRemoteUrl(project.id, remote.name, answer.value);
    if (!result.ok) {
      notify("error", result.error ?? "Could not change the remote URL");
    }
  };

  /**
   * What a repository can be asked for from its own row. Nothing here touches the working
   * tree — those actions live in the git pane, where what they act on is on screen.
   */
  const menuEntries = (project: Project): ContextMenuEntry[] => {
    const remote = remoteOf(project.id);
    const web = remote?.url ? webUrl(remote.url) : null;
    return [
      { label: "Open in terminal", run: () => onOpenTerminal(project.id) },
      { label: revealLabel(), run: () => void window.meeseek.shell.openProject(project.id) },
      { label: "Copy repository path", run: () => void navigator.clipboard.writeText(project.path) },
      SEPARATOR,
      {
        label: web ? `View on ${hostName(web)}` : "View in browser",
        run: web ? () => void window.meeseek.shell.openUrl(web) : undefined
      },
      {
        label: "Change remote URL...",
        run: remote ? () => void askRemoteUrl(project, remote) : undefined
      },
      SEPARATOR,
      { label: "Close repository", run: () => onClose(project.id) }
    ];
  };

  return (
    <div className="project-list">
      <div className="sidebar-header">
        <span>PROJECTS</span>
        <button className="icon-button" title="Add repository" onClick={onAdd}>
          <PlusIcon />
        </button>
      </div>
      <div className="project-list-items" onDragOver={overEnd} onDrop={dropAtEnd}>
        {projects.map((project, index) => (
          <div
            key={project.id}
            className={itemClass(project, index)}
            onClick={() => onSelect(project.id)}
            title={project.path}
            draggable
            onDragStart={(event) => begin(event, project.id)}
            onDragOver={(event) => over(event, index)}
            onDrop={(event) => drop(event, index)}
            onDragEnd={end}
            onContextMenu={(event) => {
              event.preventDefault();
              onSelect(project.id);
              setMenu({ x: event.clientX, y: event.clientY, project });
            }}
          >
            <span className="project-item-label">{project.name}</span>
            <button
              className="icon-button"
              title="Close repository"
              onClick={(event) => {
                event.stopPropagation();
                onClose(project.id);
              }}
            >
              <CloseIcon />
            </button>
          </div>
        ))}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.project)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
