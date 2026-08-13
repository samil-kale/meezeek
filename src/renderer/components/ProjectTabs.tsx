import type { Project } from "../../shared/types";
import { CloseIcon, PlusIcon } from "./icons";

interface ProjectTabsProps {
  projects: Project[];
  activeProjectId: string | null;
  onSelect: (projectId: string) => void;
  onClose: (projectId: string) => void;
  onAdd: () => void;
}

export function ProjectTabs({ projects, activeProjectId, onSelect, onClose, onAdd }: ProjectTabsProps) {
  return (
    <div className="project-tabs">
      {projects.map((project) => (
        <div
          key={project.id}
          className={`project-tab${project.id === activeProjectId ? " active" : ""}`}
          onClick={() => onSelect(project.id)}
          title={project.path}
        >
          <span className="project-tab-label">{project.name}</span>
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
      <button className="icon-button project-add" title="Add repository" onClick={onAdd}>
        <PlusIcon />
      </button>
    </div>
  );
}
