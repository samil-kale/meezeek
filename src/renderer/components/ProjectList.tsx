import type { Project } from "../../shared/types";
import { CloseIcon, PlusIcon } from "./icons";

interface ProjectListProps {
  projects: Project[];
  activeProjectId: string | null;
  /** Dragged on the sash beside the list, which is why it isn't a style of its own. */
  width: number;
  onSelect: (projectId: string) => void;
  onClose: (projectId: string) => void;
  onAdd: () => void;
}

export function ProjectList({ projects, activeProjectId, width, onSelect, onClose, onAdd }: ProjectListProps) {
  return (
    <div className="project-list" style={{ width }}>
      <div className="project-list-header">
        <span>PROJECTS</span>
        <button className="icon-button" title="Add repository" onClick={onAdd}>
          <PlusIcon />
        </button>
      </div>
      <div className="project-list-items">
        {projects.map((project) => (
          <div
            key={project.id}
            className={`project-item${project.id === activeProjectId ? " active" : ""}`}
            onClick={() => onSelect(project.id)}
            title={project.path}
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
