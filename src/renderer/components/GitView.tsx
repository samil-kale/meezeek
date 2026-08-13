import { useEffect, useState } from "react";
import type { ChangeStatus, CheckoutTarget, FileDiff, Project, RepositoryState } from "../../shared/types";
import { BranchTree } from "./BranchTree";
import { DiffView } from "./DiffView";
import { Sash } from "./Sash";

/**
 * The two sizes the git tab's panels can be dragged to. Held by the app rather than by this
 * view: every project has a git tab of its own, and they all show the same layout.
 */
export interface GitPaneSizes {
  panelsWidth: number;
  onPanelsWidth: (size: number) => void;
  treeHeight: number;
  onTreeHeight: (size: number) => void;
}

interface GitViewProps {
  project: Project;
  state: RepositoryState;
  sizes: GitPaneSizes;
  onCheckout: (target: CheckoutTarget) => void;
  /**
   * Repository-relative path of the file whose diff is shown. Owned by the pane, so a file
   * ctrl-clicked in a terminal can open this tab on it.
   */
  selected: string | null;
  onSelect: (path: string) => void;
  /** Passed on to the diff, which is the half of this view that has to wait for anything. */
  onBusy: (busy: boolean) => void;
  /** False while another tab is on screen; the view stays mounted so its selection survives. */
  active: boolean;
}

const STATUS_LETTER: Record<ChangeStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "?",
  conflicted: "C"
};

export function GitView({ project, state, sizes, onCheckout, selected, onSelect, onBusy, active }: GitViewProps) {
  const [filter, setFilter] = useState("");
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(false);

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
    void window.meeseex.repository.diff(project.id, selected).then((result) => {
      if (!cancelled) {
        setDiff(result);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [project.id, selected, state.changes]);

  return (
    <div className={`git-view${active ? "" : " pane-hidden"}`}>
      <div className="git-panels" style={{ width: sizes.panelsWidth }}>
        <BranchTree state={state} height={sizes.treeHeight} onCheckout={onCheckout} />
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
      <div className="changes-diff">
        <DiffView diff={diff} loading={loading} onBusy={onBusy} />
      </div>
    </div>
  );
}
