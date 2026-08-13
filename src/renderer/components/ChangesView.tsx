import { useEffect, useState } from "react";
import type { ChangeStatus, FileChange, FileDiff, Project } from "../../shared/types";
import { DiffView } from "./DiffView";

interface ChangesViewProps {
  project: Project;
  changes: FileChange[];
}

const STATUS_LETTER: Record<ChangeStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "?",
  conflicted: "C"
};

export function ChangesView({ project, changes }: ChangesViewProps) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(false);

  const query = filter.trim().toLowerCase();
  const visible = changes.filter((change) => change.path.toLowerCase().includes(query));

  // Reloads whenever the selection changes and whenever the repository state changed, so an
  // agent editing the selected file updates the diff on screen.
  useEffect(() => {
    if (!selected) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void window.meeseex.repository.diff(project.id, selected).then((result) => {
      if (!cancelled) {
        setDiff(result);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [project.id, selected, changes]);

  return (
    <div className="changes-view">
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
              onClick={() => setSelected(change.path)}
              title={change.origPath ? `${change.origPath} → ${change.path}` : change.path}
            >
              <span className={`change-status ${change.status}`}>{STATUS_LETTER[change.status]}</span>
              <span className="change-path">{change.path}</span>
            </button>
          ))}
          {changes.length === 0 && <div className="placeholder">No local changes.</div>}
        </div>
      </div>
      <div className="changes-diff">
        <DiffView diff={diff} loading={loading} />
      </div>
    </div>
  );
}
