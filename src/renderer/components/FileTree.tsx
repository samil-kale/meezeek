import { useEffect, useMemo, useRef, useState } from "react";
import type { FileListing, Project } from "../../shared/types";
import { languageForPath } from "../diff-highlight";
import { absolutePath, revealLabel } from "../platform";
import { type FileAct } from "./ChangesList";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "./ContextMenu";
import { confirm, prompt } from "./Dialog";
import {
  ChevronIcon,
  CIcon,
  CppIcon,
  CSharpIcon,
  CssIcon,
  GoIcon,
  HtmlIcon,
  IniIcon,
  JavaIcon,
  JavaScriptIcon,
  JsonIcon,
  JsxIcon,
  MarkdownIcon,
  PowerShellIcon,
  PythonIcon,
  RustIcon,
  SearchIcon,
  ShellScriptIcon,
  SMALLER,
  SqlIcon,
  TomlIcon,
  TsxIcon,
  TypeScriptIcon,
  XmlIcon,
  YamlIcon,
  type IconProps
} from "./icons";

/**
 * A file's language, marked in its twistie slot — one entry per grammar `diff-highlight.ts`
 * bundles, so a mark only ever names a language the diff view itself can colour. Anything else
 * (an unlisted extension, no extension at all) shows no mark, same as a file always has until now.
 */
const LANGUAGE_ICONS: Record<string, (props: IconProps) => React.ReactElement> = {
  c: CIcon,
  cpp: CppIcon,
  csharp: CSharpIcon,
  css: CssIcon,
  go: GoIcon,
  html: HtmlIcon,
  ini: IniIcon,
  java: JavaIcon,
  javascript: JavaScriptIcon,
  json: JsonIcon,
  jsx: JsxIcon,
  markdown: MarkdownIcon,
  powershell: PowerShellIcon,
  python: PythonIcon,
  rust: RustIcon,
  shellscript: ShellScriptIcon,
  sql: SqlIcon,
  toml: TomlIcon,
  tsx: TsxIcon,
  typescript: TypeScriptIcon,
  xml: XmlIcon,
  yaml: YamlIcon
};

interface TreeNode {
  name: string;
  /** Repository-relative, forward-slashed — the same shape `changes` paths already have. */
  path: string;
  /** Present for a folder, absent for a file — what tells the two apart while rendering. */
  children?: TreeNode[];
}

/* VS Code's explorer geometry (abstractTree.ts / explorerViewer.ts), shrunk 2px across the board
 * — indent, twistie slot, its gap to the label, and the chevron glyph itself (see .file-tree
 * .tree-icon in styles.css) — so the whole tree reads smaller as one piece, not just some of it. */
const INDENT_STEP = 6;
const INDENT_BASE = 6;
/** Wide enough for a folder's chevron or a file's two-letter language badge, whichever a row
 *  has — both centred in the same box, so either way the label after it starts at the same x. */
const TWISTIE_WIDTH = 16;
const TWISTIE_GAP = 4;

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

/**
 * Every file, split on `/` into nested folders, plus any directory `files` alone wouldn't imply
 * (see `FileListing`) — inserted the same way, except its own leaf is a folder node too.
 */
function buildTree(files: string[], emptyDirs: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  const folders = new Map<string, TreeNode>();
  const ensureFolder = (folderPath: string, name: string, siblings: TreeNode[]): TreeNode => {
    let folder = folders.get(folderPath);
    if (!folder) {
      folder = { name, path: folderPath, children: [] };
      folders.set(folderPath, folder);
      siblings.push(folder);
    }
    return folder;
  };
  const insert = (entryPath: string, isDirectory: boolean): void => {
    const parts = entryPath.split("/");
    let siblings = root;
    let prefix = "";
    for (let depth = 0; depth < parts.length - 1; depth++) {
      prefix = prefix ? `${prefix}/${parts[depth]}` : parts[depth];
      siblings = ensureFolder(prefix, parts[depth], siblings).children!;
    }
    const name = parts[parts.length - 1];
    if (isDirectory) {
      ensureFolder(entryPath, name, siblings);
    } else {
      siblings.push({ name, path: entryPath });
    }
  };
  for (const file of files) {
    insert(file, false);
  }
  for (const dir of emptyDirs) {
    insert(dir, true);
  }
  sortTree(root);
  return root;
}

/** Everything up to but not including a path's own last segment — its parent folder, "" at the
 *  root. */
function parentOf(entryPath: string): string {
  const index = entryPath.lastIndexOf("/");
  return index === -1 ? "" : entryPath.slice(0, index);
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
  onContextMenu: (event: React.MouseEvent, node: TreeNode) => void;
  rows: Map<string, HTMLButtonElement>;
}

function Rows({ nodes, depth, expanded, toggle, forceExpanded, selected, onOpen, onContextMenu, rows }: RowsProps) {
  return (
    <>
      {nodes.map((node) => {
        const isFolder = node.children !== undefined;
        const open = forceExpanded || (expanded[node.path] ?? false);
        const LangIcon = isFolder ? undefined : LANGUAGE_ICONS[languageForPath(node.path) ?? ""];
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
              onContextMenu={(event) => onContextMenu(event, node)}
            >
              <span
                style={{
                  display: "flex",
                  flex: "none",
                  width: TWISTIE_WIDTH,
                  alignSelf: "stretch",
                  alignItems: "center",
                  justifyContent: "center",
                  marginRight: TWISTIE_GAP,
                }}
              >
                {isFolder ? (
                  <ChevronIcon expanded={open} className="tree-icon" scale={SMALLER} />
                ) : (
                  LangIcon && <LangIcon className="tree-icon" />
                )}
              </span>
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
                onContextMenu={onContextMenu}
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
  project: Project;
  /** Undefined while the listing is still being read — the FILES header's own bar says so. */
  files: FileListing | undefined;
  /** The open file, if any — reveals and highlights it; not itself an ↑/↓ target (see CLAUDE.md). */
  selected: string | null;
  onOpen: (path: string) => void;
  /** Runs a file-tree action, the way `ChangesList`'s own list runs a git one — the owner shows
   *  it running on its own bar. */
  act: FileAct;
  /** A create, rename or delete settled — nothing else would tell the tree to read the listing
   *  again: an empty new folder, unlike a new file, never touches git status. */
  onFilesChanged: () => void;
}

/**
 * The diff dialog's file browser: every file in the repository, not just the changed ones under
 * LOCAL CHANGES beside it — a way in for the occasional file that has no diff. No ↑/↓ (stays with
 * `ChangesList`), but otherwise GitHub Desktop's own file actions plus the handful VS Code's
 * explorer adds for a tree rather than a flat list: new file, new folder, rename, delete.
 */
export function FileTree({ project, files, selected, onOpen, act, onFilesChanged }: FileTreeProps) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; node: TreeNode | null } | null>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());

  const tree = useMemo(() => buildTree(files?.files ?? [], files?.emptyDirs ?? []), [files]);
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

  /** `act`, plus telling the FILES header to read the listing again once the action lands. */
  const run: FileAct = (action) =>
    act(() =>
      action().then((result) => {
        if (result.ok) {
          onFilesChanged();
        }
        return result;
      })
    );

  const askNewFile = async (dir: string): Promise<void> => {
    const answer = await prompt({
      title: "New File",
      label: "Name",
      detail: dir ? `Created inside ${dir}.` : "Created at the repository root.",
      value: "",
      confirmLabel: "Create"
    });
    if (answer) {
      run(() => window.tet.repository.createFile(project.id, dir ? `${dir}/${answer.value}` : answer.value));
    }
  };

  const askNewFolder = async (dir: string): Promise<void> => {
    const answer = await prompt({
      title: "New Folder",
      label: "Name",
      detail: dir ? `Created inside ${dir}.` : "Created at the repository root.",
      value: "",
      confirmLabel: "Create"
    });
    if (answer) {
      run(() => window.tet.repository.createDirectory(project.id, dir ? `${dir}/${answer.value}` : answer.value));
    }
  };

  const askRename = async (node: TreeNode): Promise<void> => {
    const answer = await prompt({ title: "Rename", label: "Name", value: node.name, confirmLabel: "Rename" });
    if (answer && answer.value !== node.name) {
      const dir = parentOf(node.path);
      run(() => window.tet.repository.renamePath(project.id, node.path, dir ? `${dir}/${answer.value}` : answer.value));
    }
  };

  const askDelete = async (node: TreeNode): Promise<void> => {
    const isFolder = node.children !== undefined;
    const answer = await confirm({
      title: isFolder ? "Delete folder" : "Delete file",
      message: `Are you sure you want to delete ${node.path}?`,
      detail: "Goes to the trash and can be restored from there.",
      confirmLabel: "Delete"
    });
    if (answer.confirmed) {
      run(() => window.tet.repository.deletePath(project.id, node.path));
    }
  };

  /** GitHub Desktop's changed-file menu (`ChangesList`'s own), minus what only makes sense for a
   *  change, plus VS Code's new/rename/delete for a tree of every file. */
  const menuEntries = (node: TreeNode | null): ContextMenuEntry[] => {
    const dir = node ? (node.children !== undefined ? node.path : parentOf(node.path)) : "";
    const isFile = node !== null && node.children === undefined;

    const openEntries: ContextMenuEntry[] = isFile
      ? [
          { label: "Open", run: () => onOpen(node.path) },
          { label: "Open in external editor", run: () => void window.tet.shell.openFileExternally(project.id, node.path) },
          SEPARATOR
        ]
      : [];
    const nodeEntries: ContextMenuEntry[] = node
      ? [
          SEPARATOR,
          { label: "Rename...", run: () => void askRename(node) },
          { label: "Delete...", run: () => void askDelete(node) },
          SEPARATOR,
          { label: revealLabel(), run: () => void window.tet.shell.revealFile(project.id, node.path) },
          {
            label: isFile ? "Copy file path" : "Copy path",
            run: () => void navigator.clipboard.writeText(absolutePath(project.path, node.path))
          },
          {
            label: isFile ? "Copy relative file path" : "Copy relative path",
            run: () => void navigator.clipboard.writeText(node.path)
          }
        ]
      : [];

    return [
      ...openEntries,
      { label: "New File...", run: () => void askNewFile(dir) },
      { label: "New Folder...", run: () => void askNewFolder(dir) },
      ...nodeEntries
    ];
  };

  return (
    <div className="file-tree">
      <div className="branch-filter">
        <SearchIcon className="branch-filter-icon" />
        <input type="text" placeholder="Filter files..." value={filter} onChange={(event) => setFilter(event.target.value)} />
      </div>
      <div
        className="tree"
        onContextMenu={(event) => {
          // A row's own handler already fired and set `event.target` to itself; reaching here
          // means the empty space below the last one was clicked instead.
          if (event.target === event.currentTarget) {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, node: null });
          }
        }}
      >
        {files !== undefined && files.files.length === 0 && files.emptyDirs.length === 0 && (
          <div className="placeholder">No files.</div>
        )}
        <Rows
          nodes={shown}
          depth={0}
          expanded={expanded}
          toggle={toggle}
          forceExpanded={filtering}
          selected={selected}
          onOpen={onOpen}
          onContextMenu={(event, node) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, node });
          }}
          rows={rows.current}
        />
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.node)} onClose={() => setMenu(null)} />}
    </div>
  );
}
