import { useMemo, useState } from "react";
import type { CheckoutTarget, RepositoryState } from "../../shared/types";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "./ContextMenu";
import { confirm } from "./Dialog";
import { BranchIcon, ChevronIcon, PlusIcon, RemoteIcon, SearchIcon } from "./icons";

/**
 * Everything the tree can do to a branch. Bundled and held by the app rather than passed one
 * callback at a time, because they share the one "a branch command is running" state: two of
 * them at once race for the same index lock.
 */
export interface BranchActions {
  /** A branch command is running in this project; the tree offers no second one meanwhile. */
  busy: boolean;
  checkout: (target: CheckoutTarget) => void;
  /** Creates the branch and switches to it; `startPoint` is a ref name, or HEAD without one. */
  create: (name: string, startPoint?: string) => void;
  rename: (from: string, to: string) => void;
  /** Deletes it locally, and on `remote` as well when the question came back saying so. */
  remove: (name: string, remote?: string) => void;
}

interface BranchTreeProps {
  state: RepositoryState;
  /** Dragged on the sash below the tree, which is why it isn't a style of its own. */
  height: number;
  branch: BranchActions;
}

/** Where a new branch is being started from: a ref, or HEAD when the user asked from nowhere. */
interface NewBranch {
  startPoint?: string;
  /** What the placeholder names as the starting point — the ref, or the current branch. */
  label: string;
}

type BranchMenu = { x: number; y: number; name: string; remote?: string };

export function BranchTree({ state, height, branch }: BranchTreeProps) {
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<BranchMenu | null>(null);
  const [creating, setCreating] = useState<NewBranch | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const query = filter.trim().toLowerCase();
  const matches = (name: string): boolean => name.toLowerCase().includes(query);

  const localBranches = useMemo(() => state.localBranches.filter(matches), [state.localBranches, query]);
  const remotes = useMemo(
    () => state.remotes.map((remote) => ({ ...remote, branches: remote.branches.filter(matches) })),
    [state.remotes, query]
  );

  const isCollapsed = (key: string): boolean => collapsed[key] ?? false;
  const toggle = (key: string): void => setCollapsed((current) => ({ ...current, [key]: !isCollapsed(key) }));

  const isCurrent = (name: string): boolean => !state.detached && name === state.head;

  /** A new branch starts under LOCAL BRANCHES, so make sure that section is open to show it. */
  const startCreating = (next: NewBranch): void => {
    setCollapsed((current) => ({ ...current, local: false }));
    setCreating(next);
  };

  const commitCreate = (name: string): void => {
    const trimmed = name.trim();
    const startPoint = creating?.startPoint;
    setCreating(null);
    if (trimmed) {
      branch.create(trimmed, startPoint);
    }
  };

  /**
   * Deleting a branch cannot be undone, so it is asked first. Without an upstream in the
   * state, a remote holding a branch of that name is what stands in for one; the checkbox
   * that offers it is GitHub Desktop's, and so is leaving it unchecked.
   */
  const confirmRemove = async (name: string): Promise<void> => {
    const remote = state.remotes.find((candidate) => candidate.branches.includes(name));
    const answer = await confirm({
      title: "Delete branch",
      message: `Delete branch "${name}"?`,
      detail: "This action cannot be undone.",
      confirmLabel: "Delete",
      checkboxLabel: remote && `Yes, delete this branch on ${remote.name}`
    });
    if (answer.confirmed) {
      branch.remove(name, answer.checked ? remote?.name : undefined);
    }
  };

  const commitRename = (from: string, to: string): void => {
    const trimmed = to.trim();
    setRenaming(null);
    if (trimmed && trimmed !== from) {
      branch.rename(from, trimmed);
    }
  };

  /**
   * GitHub Desktop's branch menu, minus what it does over the network. A branch command that
   * is already running disables all of it — the same reason the tree stops taking clicks.
   */
  const menuEntries = ({ name, remote }: BranchMenu): ContextMenuEntry[] => {
    const ref = remote ? `${remote}/${name}` : name;
    const enabled = (run: () => void): (() => void) | undefined => (branch.busy ? undefined : run);
    if (remote) {
      return [
        { label: "Check out", run: enabled(() => branch.checkout({ name, remote })) },
        SEPARATOR,
        { label: "Create branch from here...", run: enabled(() => startCreating({ startPoint: ref, label: ref })) }
      ];
    }
    return [
      // The branch you are on is the one thing none of these apply to: git refuses to delete
      // or rename it out from under a working tree, and checking it out again does nothing.
      { label: "Check out", run: isCurrent(name) ? undefined : enabled(() => branch.checkout({ name })) },
      SEPARATOR,
      { label: "Rename...", run: isCurrent(name) ? undefined : enabled(() => setRenaming(name)) },
      { label: "Delete...", run: isCurrent(name) ? undefined : enabled(() => void confirmRemove(name)) },
      SEPARATOR,
      { label: "Create branch from here...", run: enabled(() => startCreating({ startPoint: ref, label: ref })) }
    ];
  };

  /** The inline row a name is typed into — VS Code's new-file row, not a dialog. */
  const nameInput = (options: {
    key?: string;
    placeholder?: string;
    defaultValue?: string;
    commit: (value: string) => void;
    cancel: () => void;
  }) => (
    <input
      key={options.key}
      className="tree-input"
      autoFocus
      placeholder={options.placeholder}
      defaultValue={options.defaultValue}
      onBlur={options.cancel}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          options.commit(event.currentTarget.value);
        } else if (event.key === "Escape") {
          options.cancel();
        }
      }}
    />
  );

  return (
    <div className={`branch-tree${branch.busy ? " busy" : ""}`} style={{ height }}>
      <div className="branch-filter">
        <SearchIcon className="branch-filter-icon" />
        <input
          type="text"
          placeholder="Search branches..."
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      <div className="tree">
        <div className="tree-section">
          <div className="tree-header-row">
            <button className="tree-header" onClick={() => toggle("local")}>
              <ChevronIcon expanded={!isCollapsed("local")} />
              <span>LOCAL BRANCHES</span>
              <span className="count">({state.localBranches.length})</span>
            </button>
            <button
              className="icon-button"
              title="Create branch from the current one"
              disabled={branch.busy}
              onClick={() => startCreating({ label: state.head || "HEAD" })}
            >
              <PlusIcon />
            </button>
          </div>
          {!isCollapsed("local") && (
            <>
              {creating &&
                nameInput({
                  placeholder: `New branch from ${creating.label}`,
                  commit: commitCreate,
                  cancel: () => setCreating(null)
                })}
              {localBranches.map((localBranch) =>
                renaming === localBranch ? (
                  nameInput({
                    key: localBranch,
                    defaultValue: localBranch,
                    commit: (value) => commitRename(localBranch, value),
                    cancel: () => setRenaming(null)
                  })
                ) : (
                  <button
                    key={localBranch}
                    className={`tree-item${isCurrent(localBranch) ? " current" : ""}`}
                    title="Double-click to check out"
                    onDoubleClick={() => branch.checkout({ name: localBranch })}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setMenu({ x: event.clientX, y: event.clientY, name: localBranch });
                    }}
                  >
                    <BranchIcon className="tree-icon" />
                    <span className="tree-label">{localBranch}</span>
                  </button>
                )
              )}
            </>
          )}
        </div>

        <div className="tree-section">
          <button className="tree-header" onClick={() => toggle("remotes")}>
            <ChevronIcon expanded={!isCollapsed("remotes")} />
            <span>REMOTES</span>
            <span className="count">({state.remotes.length})</span>
          </button>
          {!isCollapsed("remotes") &&
            remotes.map((remote) => (
              <div key={remote.name}>
                <button className="tree-item remote" onClick={() => toggle(`remote:${remote.name}`)}>
                  <ChevronIcon expanded={!isCollapsed(`remote:${remote.name}`)} />
                  <RemoteIcon className="tree-icon" />
                  <span className="tree-label">{remote.name}</span>
                  <span className="count">({remote.branches.length})</span>
                </button>
                {!isCollapsed(`remote:${remote.name}`) &&
                  remote.branches.map((remoteBranch) => (
                    <button
                      key={remoteBranch}
                      className="tree-item nested"
                      title="Double-click to check out"
                      onDoubleClick={() => branch.checkout({ name: remoteBranch, remote: remote.name })}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setMenu({ x: event.clientX, y: event.clientY, name: remoteBranch, remote: remote.name });
                      }}
                    >
                      <BranchIcon className="tree-icon" />
                      <span className="tree-label">{remoteBranch}</span>
                    </button>
                  ))}
              </div>
            ))}
        </div>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu)} onClose={() => setMenu(null)} />}
    </div>
  );
}
