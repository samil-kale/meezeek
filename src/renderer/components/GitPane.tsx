import { useEffect, useState } from "react";
import type { ChangeStatus, FileChange, GitActionResult, Project, RepositoryState } from "../../shared/types";
import { isWindows, revealLabel } from "../platform";
import { BranchTree, type BranchActions } from "./BranchTree";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "./ContextMenu";
import { confirm } from "./Dialog";
import { notify } from "./Notices";
import { Sash } from "./Sash";
import { DiscardIcon, StashIcon } from "./icons";

interface GitPaneProps {
  project: Project;
  state: RepositoryState;
  branch: BranchActions;
  /** Dragged on the sash between the tree and the changes; held by the app, like the width. */
  treeHeight: number;
  onTreeHeight: (size: number) => void;
  /** A file to look at — the diff opens as a dialog over everything. */
  onOpenDiff: (path: string) => void;
  /** A discard or an ignore is running; the app feeds it into the one progress bar. */
  onBusy: (busy: boolean) => void;
}

const STATUS_LETTER: Record<ChangeStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "?",
  conflicted: "C"
};

/**
 * The repository, beside the terminals rather than in place of them: branches over the changed
 * files, and nothing else. The diff is not here — a file is opened by double-clicking it and
 * shown over the whole window, so this pane stays narrow enough to leave next to a terminal.
 */
export function GitPane({ project, state, branch, treeHeight, onTreeHeight, onOpenDiff, onBusy }: GitPaneProps) {
  const [filter, setFilter] = useState("");
  /** Ctrl- and shift-click extend it, so one discard can cover several files. */
  const [selected, setSelected] = useState<string[]>([]);
  /** Where a shift-click measures its range from: the row that was clicked plainly last. */
  const [anchor, setAnchor] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; change: FileChange } | null>(null);

  const query = filter.trim().toLowerCase();
  const visible = state.changes.filter((change) => change.path.toLowerCase().includes(query));

  useEffect(() => onBusy(acting), [acting, onBusy]);

  // A file that stopped being changed — committed in a terminal, or discarded here — is gone
  // from the list, and holding on to it would let a later change reappear pre-selected.
  useEffect(() => {
    setSelected((current) => {
      const kept = current.filter((path) => state.changes.some((change) => change.path === path));
      return kept.length === current.length ? current : kept;
    });
  }, [state.changes]);

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

  /** VS Code's list selection: plain replaces, ctrl toggles, shift takes the range. */
  const select = (event: React.MouseEvent, path: string): void => {
    if (event.shiftKey && anchor) {
      const from = visible.findIndex((change) => change.path === anchor);
      const to = visible.findIndex((change) => change.path === path);
      if (from >= 0 && to >= 0) {
        const range = visible.slice(Math.min(from, to), Math.max(from, to) + 1);
        setSelected(range.map((change) => change.path));
        return;
      }
    }
    setAnchor(path);
    if (event.ctrlKey || event.metaKey) {
      setSelected((current) =>
        current.includes(path) ? current.filter((entry) => entry !== path) : [...current, path]
      );
      return;
    }
    setSelected([path]);
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

  /** git reports paths relative to the root; the clipboard gets ones the platform accepts. */
  const absolutePath = (relative: string): string =>
    [project.path, ...relative.split("/")].join(isWindows() ? "\\" : "/");

  /**
   * GitHub Desktop's changed-file menu, minus the editor entries meeseek has no setting for.
   * It acts on the whole selection where that makes sense, and on the one file where it does
   * not — a diff and a file manager both show exactly one thing.
   */
  const menuEntries = (change: FileChange): ContextMenuEntry[] => {
    // A right-click inside the selection keeps it; one outside has already replaced it.
    const paths = selected.includes(change.path) ? selected : [change.path];
    const one = paths.length === 1;
    const extension = /\.[^./]+$/.exec(change.path)?.[0];
    const discard = (targets: string[]) => () => void confirmDiscard(targets);
    const ignore = (scope: "file" | "extension") => () =>
      act(() => window.meeseek.repository.ignore(project.id, change.path, scope));

    const entries: ContextMenuEntry[] = [
      { label: "Open diff", run: one ? () => onOpenDiff(change.path) : undefined },
      {
        label: "Open in external editor",
        run: one ? () => void window.meeseek.shell.openFileExternally(project.id, change.path) : undefined
      },
      SEPARATOR,
      { label: one ? "Discard changes..." : `Discard ${paths.length} selected changes...`, run: discard(paths) },
      {
        label: "Discard all changes...",
        // With nothing but the selection changed it would be the entry above under another name.
        run:
          state.changes.length > paths.length ? discard(state.changes.map((entry) => entry.path)) : undefined
      },
      SEPARATOR,
      {
        label: revealLabel(),
        run: one ? () => void window.meeseek.shell.revealFile(project.id, change.path) : undefined
      },
      {
        label: one ? "Copy file path" : "Copy file paths",
        run: () => void navigator.clipboard.writeText(paths.map(absolutePath).join("\n"))
      },
      {
        label: one ? "Copy relative file path" : "Copy relative file paths",
        run: () => void navigator.clipboard.writeText(paths.join("\n"))
      }
    ];
    if (one && change.status === "untracked") {
      entries.push(SEPARATOR, { label: "Ignore file (add to .gitignore)", run: ignore("file") });
      if (extension) {
        entries.push({ label: `Ignore all ${extension} files (add to .gitignore)`, run: ignore("extension") });
      }
    }
    return entries;
  };

  return (
    <div className="git-pane">
      {/* Both halves are titled the way the navigation's are — same bar, same height. */}
      <div className="git-section" style={{ height: treeHeight }}>
        <div className="sidebar-header">
          <span>BRANCHES</span>
        </div>
        <BranchTree projectId={project.id} state={state} branch={branch} />
      </div>
      <Sash orientation="horizontal" size={treeHeight} min={120} minOther={140} onResize={onTreeHeight} />
      <div className="git-section grows">
        <div className="sidebar-header">
          <span>
            LOCAL CHANGES <span className="count">({state.changes.length})</span>
          </span>
          {/* The two things that clear the whole list, in the order of what they cost: one puts
              it away and can be popped again, the other throws it out. Anything narrower than
              "all of it" is in the changes' own context menu. */}
          <span className="sidebar-header-actions">
            <button
              className="icon-button"
              title="Stash all changes"
              disabled={branch.busy || acting || state.changes.length === 0}
              onClick={() =>
                branch.run("Stashing changes...", () => window.meeseek.repository.stashPush(project.id, ""))
              }
            >
              <StashIcon />
            </button>
            <button
              className="icon-button"
              title="Discard all changes"
              disabled={branch.busy || acting || state.changes.length === 0}
              onClick={() => void confirmDiscard(state.changes.map((change) => change.path))}
            >
              <DiscardIcon />
            </button>
          </span>
        </div>
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
                className={`change-item${selected.includes(change.path) ? " selected" : ""}`}
                onClick={(event) => select(event, change.path)}
                onDoubleClick={() => onOpenDiff(change.path)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  if (!selected.includes(change.path)) {
                    setSelected([change.path]);
                    setAnchor(change.path);
                  }
                  setMenu({ x: event.clientX, y: event.clientY, change });
                }}
                title={`${change.origPath ? `${change.origPath} → ${change.path}` : change.path}\nDouble-click to see the diff`}
              >
                <span className={`change-status ${change.status}`}>{STATUS_LETTER[change.status]}</span>
                <span className="change-path">{change.path}</span>
              </button>
            ))}
            {state.changes.length === 0 && <div className="placeholder">No local changes.</div>}
          </div>
        </div>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.change)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
