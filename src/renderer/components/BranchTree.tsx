import { useMemo, useState } from "react";
import type { CheckoutTarget, RepositoryState } from "../../shared/types";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { BranchIcon, ChevronIcon, RemoteIcon, SearchIcon, StashIcon, TagIcon } from "./icons";

/**
 * What the tree can do, which is check a branch out and nothing else. Everything that would
 * *change* a branch — creating, renaming, deleting, merging, rebasing — is deliberately not
 * here: it belongs in an agent or a shell, and this view is for finding your way around.
 */
export interface BranchActions {
  /** A git command is running in this project; the tree offers no second one meanwhile. */
  busy: boolean;
  checkout: (target: CheckoutTarget) => void;
}

interface BranchTreeProps {
  state: RepositoryState;
  /** Dragged on the sash below the tree, which is why it isn't a style of its own. */
  height: number;
  branch: BranchActions;
}

type BranchMenu = { x: number; y: number; name: string; remote?: string };

export function BranchTree({ state, height, branch }: BranchTreeProps) {
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<BranchMenu | null>(null);

  const query = filter.trim().toLowerCase();
  const matches = (name: string): boolean => name.toLowerCase().includes(query);

  const localBranches = useMemo(() => state.localBranches.filter(matches), [state.localBranches, query]);
  const remotes = useMemo(
    () => state.remotes.map((remote) => ({ ...remote, branches: remote.branches.filter(matches) })),
    [state.remotes, query]
  );
  // The filter is named for branches but reads as "find a ref", so tags go through it too.
  const tags = useMemo(() => state.tags.filter(matches), [state.tags, query]);

  const isCollapsed = (key: string): boolean => collapsed[key] ?? false;
  const toggle = (key: string): void => setCollapsed((current) => ({ ...current, [key]: !isCollapsed(key) }));

  const isCurrent = (name: string): boolean => !state.detached && name === state.head;

  /** One entry, because checking out is the one thing this tree does. */
  const menuEntries = ({ name, remote }: BranchMenu): ContextMenuEntry[] => [
    {
      label: "Check out",
      // Checking out the branch you are already on does nothing, and a command already
      // running would race this one.
      run: branch.busy || (!remote && isCurrent(name)) ? undefined : () => branch.checkout({ name, remote })
    }
  ];

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
          <button className="tree-header" onClick={() => toggle("local")}>
            <ChevronIcon expanded={!isCollapsed("local")} />
            <span>LOCAL BRANCHES</span>
            <span className="count">({state.localBranches.length})</span>
          </button>
          {!isCollapsed("local") &&
            localBranches.map((localBranch) => (
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
            ))}
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

        {/* Tags and stashes are shown, never acted on: creating a tag or popping a stash is
            a job for a terminal, and a row that reacts without doing anything would lie. */}
        <div className="tree-section">
          <button className="tree-header" onClick={() => toggle("tags")}>
            <ChevronIcon expanded={!isCollapsed("tags")} />
            <span>TAGS</span>
            <span className="count">({state.tags.length})</span>
          </button>
          {!isCollapsed("tags") &&
            tags.map((tag) => (
              <div key={tag} className="tree-item static" title={tag}>
                <TagIcon className="tree-icon" />
                <span className="tree-label">{tag}</span>
              </div>
            ))}
        </div>

        <div className="tree-section">
          <button className="tree-header" onClick={() => toggle("stashes")}>
            <ChevronIcon expanded={!isCollapsed("stashes")} />
            <span>STASHES</span>
            <span className="count">({state.stashes.length})</span>
          </button>
          {!isCollapsed("stashes") &&
            state.stashes.map((stash) => (
              <div key={stash.ref} className="tree-item static" title={`${stash.ref}: ${stash.message}`}>
                <StashIcon className="tree-icon" />
                <span className="tree-label">{stash.message}</span>
              </div>
            ))}
        </div>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu)} onClose={() => setMenu(null)} />}
    </div>
  );
}
