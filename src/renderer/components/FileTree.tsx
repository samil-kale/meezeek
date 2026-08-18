import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronIcon, SearchIcon } from "./icons";

interface TreeNode {
  name: string;
  /** Repository-relative, forward-slashed — the same shape `changes` paths already have. */
  path: string;
  /** Present for a folder, absent for a file — what tells the two apart while rendering. */
  children?: TreeNode[];
}

const INDENT_STEP = 16;
const INDENT_BASE = 6;

/** Folders before files, then alphabetical — VS Code's own explorer order. */
function compareNodes(a: TreeNode, b: TreeNode): number {
  if (!!a.children !== !!b.children) {
    return a.children ? -1 : 1;
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function sortTree(nodes: TreeNode[]): void {
  nodes.sort(compareNodes);
  for (const node of nodes) {
    if (node.children) {
      sortTree(node.children);
    }
  }
}

/** Every file, split on `/` into nested folders — `git ls-files` reports a flat list. */
function buildTree(files: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  const folders = new Map<string, TreeNode>();
  for (const file of files) {
    const parts = file.split("/");
    let siblings = root;
    let prefix = "";
    for (let depth = 0; depth < parts.length - 1; depth++) {
      prefix = prefix ? `${prefix}/${parts[depth]}` : parts[depth];
      let folder = folders.get(prefix);
      if (!folder) {
        folder = { name: parts[depth], path: prefix, children: [] };
        folders.set(prefix, folder);
        siblings.push(folder);
      }
      siblings = folder.children!;
    }
    siblings.push({ name: parts[parts.length - 1], path: file });
  }
  sortTree(root);
  return root;
}

/**
 * The filtered tree, VS Code's own quick-filter rule: a folder whose own path matches keeps its
 * whole subtree as it was; otherwise only descendants that themselves match survive, and their
 * ancestors are kept just to carry them.
 */
function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    const matches = node.path.toLowerCase().includes(query);
    if (node.children) {
      if (matches) {
        result.push(node);
        continue;
      }
      const children = filterTree(node.children, query);
      if (children.length > 0) {
        result.push({ ...node, children });
      }
    } else if (matches) {
      result.push(node);
    }
  }
  return result;
}

/** Every folder on the way down to a path, root first. */
function ancestorsOf(filePath: string): string[] {
  const parts = filePath.split("/");
  const ancestors: string[] = [];
  let prefix = "";
  for (let depth = 0; depth < parts.length - 1; depth++) {
    prefix = prefix ? `${prefix}/${parts[depth]}` : parts[depth];
    ancestors.push(prefix);
  }
  return ancestors;
}

interface RowsProps {
  nodes: TreeNode[];
  depth: number;
  expanded: Record<string, boolean>;
  toggle: (path: string) => void;
  forceExpanded: boolean;
  selected: string | null;
  onOpen: (path: string) => void;
  rows: Map<string, HTMLButtonElement>;
}

function Rows({ nodes, depth, expanded, toggle, forceExpanded, selected, onOpen, rows }: RowsProps) {
  return (
    <>
      {nodes.map((node) => {
        const isFolder = node.children !== undefined;
        const open = forceExpanded || (expanded[node.path] ?? false);
        return (
          <div key={node.path}>
            <button
              ref={(element) => {
                if (element) {
                  rows.set(node.path, element);
                } else {
                  rows.delete(node.path);
                }
              }}
              className={`tree-item${!isFolder && selected === node.path ? " selected" : ""}`}
              style={{ paddingLeft: INDENT_BASE + depth * INDENT_STEP }}
              title={node.path}
              onClick={() => (isFolder ? toggle(node.path) : onOpen(node.path))}
            >
              {isFolder ? <ChevronIcon expanded={open} className="tree-icon" /> : <span className="tree-icon" />}
              <span className="tree-label">{node.name}</span>
            </button>
            {isFolder && open && (
              <Rows
                nodes={node.children!}
                depth={depth + 1}
                expanded={expanded}
                toggle={toggle}
                forceExpanded={forceExpanded}
                selected={selected}
                onOpen={onOpen}
                rows={rows}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

interface FileTreeProps {
  /** Undefined while the listing is still being read — the FILES header's own bar says so. */
  files: string[] | undefined;
  /** The open file, if any — reveals and highlights it; not itself an ↑/↓ target (see CLAUDE.md). */
  selected: string | null;
  onOpen: (path: string) => void;
}

/**
 * The diff dialog's file browser: every file in the repository, not just the changed ones under
 * LOCAL CHANGES beside it. Deliberately narrow next to that list — no ↑/↓ (stays with
 * `ChangesList`), no context menu, single click opens: this is a way in for the occasional file
 * that has no diff, not a second file manager.
 */
export function FileTree({ files, selected, onOpen }: FileTreeProps) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const rows = useRef(new Map<string, HTMLButtonElement>());

  const tree = useMemo(() => buildTree(files ?? []), [files]);
  const query = filter.trim().toLowerCase();
  const filtering = query.length > 0;
  const shown = useMemo(() => (filtering ? filterTree(tree, query) : tree), [tree, query, filtering]);

  // Reveals the file the rest of the dialog opened (a ChangesList click, a ctrl-clicked path):
  // its folders expand and it scrolls into view, the same way VS Code's explorer follows the
  // active editor.
  useEffect(() => {
    if (!selected) {
      return;
    }
    const ancestors = ancestorsOf(selected);
    if (ancestors.length > 0) {
      setExpanded((current) => {
        const next = { ...current };
        let changed = false;
        for (const ancestor of ancestors) {
          if (!next[ancestor]) {
            next[ancestor] = true;
            changed = true;
          }
        }
        return changed ? next : current;
      });
    }
    rows.current.get(selected)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const toggle = (path: string): void => setExpanded((current) => ({ ...current, [path]: !current[path] }));

  return (
    <div className="file-tree">
      <div className="branch-filter">
        <SearchIcon className="branch-filter-icon" />
        <input type="text" placeholder="Filter files..." value={filter} onChange={(event) => setFilter(event.target.value)} />
      </div>
      <div className="tree">
        {files !== undefined && files.length === 0 && <div className="placeholder">No files.</div>}
        <Rows
          nodes={shown}
          depth={0}
          expanded={expanded}
          toggle={toggle}
          forceExpanded={filtering}
          selected={selected}
          onOpen={onOpen}
          rows={rows.current}
        />
      </div>
    </div>
  );
}
