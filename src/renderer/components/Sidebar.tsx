import { useMemo, useState } from "react";
import type { CheckoutTarget, RepositoryState, ViewId } from "../../shared/types";
import { BranchIcon, ChevronIcon, RemoteIcon, SearchIcon } from "./icons";

interface SidebarProps {
  state: RepositoryState;
  view: ViewId;
  onSelectView: (view: ViewId) => void;
  onCheckout: (target: CheckoutTarget) => void;
  disabled: boolean;
}

const VIEWS: { id: ViewId; label: string }[] = [
  { id: "terminals", label: "TERMINALS" },
  { id: "changes", label: "LOCAL CHANGES" }
];

export function Sidebar({ state, view, onSelectView, onCheckout, disabled }: SidebarProps) {
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const query = filter.trim().toLowerCase();
  const matches = (name: string): boolean => name.toLowerCase().includes(query);

  const localBranches = useMemo(() => state.localBranches.filter(matches), [state.localBranches, query]);
  const remotes = useMemo(
    () => state.remotes.map((remote) => ({ ...remote, branches: remote.branches.filter(matches) })),
    [state.remotes, query]
  );

  const isCollapsed = (key: string): boolean => collapsed[key] ?? false;
  const toggle = (key: string): void => setCollapsed((current) => ({ ...current, [key]: !isCollapsed(key) }));

  return (
    <div className="sidebar">
      <div className="sidebar-nav">
        {VIEWS.map((entry) => (
          <button
            key={entry.id}
            className={`sidebar-nav-item${view === entry.id ? " active" : ""}`}
            onClick={() => onSelectView(entry.id)}
            disabled={disabled}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="branch-filter">
        <SearchIcon className="branch-filter-icon" />
        <input
          type="text"
          placeholder="Search branches..."
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          disabled={disabled}
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
            localBranches.map((branch) => (
              <button
                key={branch}
                className={`tree-item${!state.detached && branch === state.head ? " current" : ""}`}
                title="Double-click to check out"
                onDoubleClick={() => onCheckout({ name: branch })}
              >
                <BranchIcon className="tree-icon" />
                <span className="tree-label">{branch}</span>
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
                  remote.branches.map((branch) => (
                    <button
                      key={branch}
                      className="tree-item nested"
                      title="Double-click to check out"
                      onDoubleClick={() => onCheckout({ name: branch, remote: remote.name })}
                    >
                      <BranchIcon className="tree-icon" />
                      <span className="tree-label">{branch}</span>
                    </button>
                  ))}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
