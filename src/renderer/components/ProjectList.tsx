import { useState } from "react";
import type { Project, RemoteInfo } from "../../shared/types";
import { revealLabel } from "../platform";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "./ContextMenu";
import { prompt } from "./Dialog";
import { reorder, useDragReorder } from "./drag-reorder";
import { notify } from "./Notices";
import { CloseIcon, CommentIcon, PlusIcon } from "./icons";

/**
 * A type of our own rather than text/plain: a project dragged across a terminal must not end
 * up pasted into it, and the terminal only ever reads dropped files and plain text.
 */
const DRAG_TYPE = "application/x-meezeek-project";

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
  /** Whether a session of this project finished a turn nobody has looked at yet. */
  hasFinished: (projectId: string) => boolean;
  /** Opens the oldest of those; pressing the mark again moves on to the next. */
  onShowFinished: (projectId: string) => void;
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
  onOpenTerminal,
  hasFinished,
  onShowFinished
}: ProjectListProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; project: Project } | null>(null);

  const { rowProps, listProps, rowClasses } = useDragReorder({
    dragType: DRAG_TYPE,
    count: projects.length,
    // The id, not the position: it still names the same project if the list changed while
    // the drag was in the air.
    payloadOf: (index) => projects[index].id,
    indexOf: (id) => projects.findIndex((project) => project.id === id),
    onMove: (from, to) => onReorder(reorder(projects, from, to))
  });

  const itemClass = (project: Project, index: number): string => {
    const classes = ["project-item", ...rowClasses(index)];
    if (project.id === activeProjectId) {
      classes.push("active");
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
    const result = await window.meezeek.repository.setRemoteUrl(project.id, remote.name, answer.value);
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
      { label: revealLabel(), run: () => void window.meezeek.shell.openProject(project.id) },
      { label: "Copy repository path", run: () => void navigator.clipboard.writeText(project.path) },
      SEPARATOR,
      {
        label: web ? `View on ${hostName(web)}` : "View in browser",
        run: web ? () => void window.meezeek.shell.openUrl(web) : undefined
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
        <span>
          PROJECTS <span className="count">({projects.length})</span>
        </span>
        <button className="icon-button" title="Add repository" onClick={onAdd}>
          <PlusIcon />
        </button>
      </div>
      <div className="project-list-items" {...listProps}>
        {projects.map((project, index) => (
          <div
            key={project.id}
            className={itemClass(project, index)}
            onClick={() => onSelect(project.id)}
            title={project.path}
            {...rowProps(index)}
            onContextMenu={(event) => {
              event.preventDefault();
              onSelect(project.id);
              setMenu({ x: event.clientX, y: event.clientY, project });
            }}
          >
            <span className="project-item-label">{project.name}</span>
            {/* A session of this project finished while its terminal was out of sight. Pressing
                it goes there, which is also what takes it away again. */}
            {hasFinished(project.id) && (
              <button
                className="icon-button"
                title="Open the session that finished"
                onClick={(event) => {
                  event.stopPropagation();
                  onShowFinished(project.id);
                }}
              >
                <CommentIcon className="session-mark" />
              </button>
            )}
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
