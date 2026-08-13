import { useState, type DragEvent } from "react";
import type { Project } from "../../shared/types";
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
}

export function ProjectList({ projects, activeProjectId, onSelect, onClose, onReorder, onAdd }: ProjectListProps) {
  const [dragged, setDragged] = useState<string | null>(null);
  /** Where the dragged project would land: the index it would take among the others. */
  const [dropAt, setDropAt] = useState<number | null>(null);

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
    </div>
  );
}
