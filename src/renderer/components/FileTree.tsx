import { useEffect, useMemo, useRef, useState } from "react";
import { languageForPath } from "../diff-highlight";
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
