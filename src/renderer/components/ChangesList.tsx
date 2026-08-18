import { useEffect, useMemo, useState } from "react";
import type { ChangeStatus, FileChange, GitActionResult, Project } from "../../shared/types";
import { isWindows, revealLabel } from "../platform";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "./ContextMenu";
import { confirm } from "./Dialog";

/** Runs a file action against the repository; the owner shows it running on its own bar. */
export type FileAct = (action: () => Promise<GitActionResult>) => void;

interface ChangesListProps {
  project: Project;
  changes: FileChange[];
  act: FileAct;
  /** A file to look at. */
  onOpenDiff: (path: string) => void;
  /**
   * The file whose diff is open — the diff dialog's list. Given, a plain click and ↑/↓ open a
   * file, where the git pane's list opens on a double-click and a plain click only selects.
   */
  active?: string;
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
 * Asks before throwing work away — the one file action here that cannot be undone, except
 * through the trash the discard puts untracked files in.
 */
export async function confirmDiscard(projectId: string, paths: string[], act: FileAct): Promise<void> {
  const what = paths.length === 1 ? paths[0] : `${paths.length} files`;
  const answer = await confirm({
    title: "Discard changes",
    message: `Are you sure you want to discard all changes to ${what}?`,
    detail: "Files git does not track go to the trash and can be restored from there.",
    confirmLabel: "Discard changes"
  });
  if (answer.confirmed) {
    act(() => window.tet.repository.discard(projectId, paths));
  }
}

/**
 * The changed files with a filter over them and GitHub Desktop's per-file menu — the same
 * list under LOCAL CHANGES in the git pane and beside the diff in its dialog, so the two never
 * offer different things for the same file. What is *shown* to be running is the owner's:
 * each hands in its own `act`, since each has a bar of its own.
 */
export function ChangesList({ project, changes, act, onOpenDiff, active }: ChangesListProps) {
  const [filter, setFilter] = useState("");
  /** Ctrl- and shift-click extend it, so one discard can cover several files. */
  const [selected, setSelected] = useState<string[]>(() => (active === undefined ? [] : [active]));
  /** Where a shift-click measures its range from: the row that was clicked plainly last. */
  const [anchor, setAnchor] = useState<string | null>(active ?? null);
  const [menu, setMenu] = useState<{ x: number; y: number; change: FileChange } | null>(null);

  const query = filter.trim().toLowerCase();
  const visible = useMemo(
    () => changes.filter((change) => change.path.toLowerCase().includes(query)),
    [changes, query]
  );

  // Another project's files: nothing chosen among them yet. Compared rather than done in an
  // effect, which would also run on mount and drop the open file the dialog's list starts with.
  const [projectId, setProjectId] = useState(project.id);
  if (projectId !== project.id) {
    setProjectId(project.id);
    setSelected([]);
    setAnchor(null);
  }

  // A file that stopped being changed — committed in a terminal, or discarded here — is gone
  // from the list, and holding on to it would let a later change reappear pre-selected.
  useEffect(() => {
    setSelected((current) => {
      const kept = current.filter((path) => changes.some((change) => change.path === path));
      return kept.length === current.length ? current : kept;
    });
  }, [changes]);

  /** Chooses one file the way a plain click does, and opens it. */
  const open = (path: string): void => {
    setSelected([path]);
    setAnchor(path);
    onOpenDiff(path);
  };

  // ↑/↓ step through the list as it is filtered, from the open file — or from either end when
  // that file is not in the list (a path ctrl-clicked in a terminal need not be changed at
  // all). Not while a question or a menu is up: the question's own keys come first, and the
  // menu acts on the selection this would move from under it.
  useEffect(() => {
    if (active === undefined) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.key !== "ArrowUp" && event.key !== "ArrowDown") || document.querySelector(".dialog-overlay, .context-menu")) {
        return;
      }
      const index = visible.findIndex((change) => change.path === active);
      const next = event.key === "ArrowDown" ? (index < 0 ? 0 : index + 1) : index < 0 ? visible.length - 1 : index - 1;
      const target = visible[next];
      if (target) {
        event.preventDefault();
        open(target.path);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

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
    if (active !== undefined) {
      onOpenDiff(path);
    }
  };

  /** git reports paths relative to the root; the clipboard gets ones the platform accepts. */
  const absolutePath = (relative: string): string =>
    [project.path, ...relative.split("/")].join(isWindows() ? "\\" : "/");

  /**
   * GitHub Desktop's changed-file menu, minus the editor entries tet has no setting for.
   * It acts on the whole selection where that makes sense, and on the one file where it does
   * not — a diff and a file manager each show exactly one thing.
   */
  const menuEntries = (change: FileChange): ContextMenuEntry[] => {
    // A right-click inside the selection keeps it; one outside has already replaced it.
    const paths = selected.includes(change.path) ? selected : [change.path];
    const one = paths.length === 1;
    const extension = /\.[^./]+$/.exec(change.path)?.[0];
    const discard = (targets: string[]) => () => void confirmDiscard(project.id, targets, act);
    const ignore = (scope: "file" | "extension") => () =>
      act(() => window.tet.repository.ignore(project.id, change.path, scope));

    const entries: ContextMenuEntry[] = [
      { label: "Open diff", run: one ? () => onOpenDiff(change.path) : undefined },
      {
        label: "Open in external editor",
        run: one ? () => void window.tet.shell.openFileExternally(project.id, change.path) : undefined
      },
      SEPARATOR,
      { label: one ? "Discard changes..." : `Discard ${paths.length} selected changes...`, run: discard(paths) },
      {
        label: "Discard all changes...",
        // With nothing but the selection changed it would be the entry above under another name.
        run: changes.length > paths.length ? discard(changes.map((entry) => entry.path)) : undefined
      },
      SEPARATOR,
      {
        label: revealLabel(),
        run: one ? () => void window.tet.shell.revealFile(project.id, change.path) : undefined
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
            title={`${change.origPath ? `${change.origPath} → ${change.path}` : change.path}${
              active === undefined ? "\nDouble-click to see the diff" : ""
            }`}
          >
            <span className={`change-status ${change.status}`}>{STATUS_LETTER[change.status]}</span>
            <span className="change-path">{change.path}</span>
          </button>
        ))}
        {changes.length === 0 && <div className="placeholder">No local changes.</div>}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.change)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
