import { memo, useEffect, useRef, useState } from "react";
import type { FileChange, FileDiff, Project } from "../../shared/types";
import { ChangesList, type FileAct } from "./ChangesList";
import { DiffView } from "./DiffView";
import { CloseIcon, WhitespaceIcon } from "./icons";
import { notify } from "./Notices";
import { useEscape } from "./use-escape";
import { ProgressBar } from "./ProgressBar";
import { MIN_CONTENT_WIDTH, MIN_PANE_WIDTH, Sash, usePaneSize } from "./Sash";

interface DiffDialogProps {
  project: Project;
  /** Repository-relative path of the file being looked at. */
  path: string;
  /** What the diff depends on besides the file — a change to it reloads while the dialog is open. */
  version: string;
  /** The repository's changed files, listed beside the diff so another one is a click away. */
  changes: FileChange[];
  /** The list's own choice of file — the same call the git pane's list makes. */
  onOpenDiff: (projectId: string, path: string) => void;
  onClose: () => void;
}

/**
 * One file's diff, over the whole window. A dialog rather than a pane because the git view sits
 * beside the terminals and has no room for it, and because looking at a diff is something you
 * come out of again, unlike the branch list next to it. The changed files stand beside it,
 * the same list as under LOCAL CHANGES, so moving on to the next file doesn't mean leaving.
 *
 * Not part of Dialog.tsx: that file puts *questions* (confirm, prompt) and is built around a
 * form with two buttons. This asks nothing.
 */
export const DiffDialog = memo(function DiffDialog({
  project,
  path,
  version,
  changes,
  onOpenDiff,
  onClose
}: DiffDialogProps) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  /** Reading the diff and colouring it, `DiffView`'s own two waits — this dialog's own bar. */
  const [busy, setBusy] = useState(false);
  /** A file action started from the list beside the diff — that pane's own bar. */
  const [acting, setActing] = useState(false);
  const [filesWidth, setFilesWidth] = usePaneSize("diff-files", 260, MIN_PANE_WIDTH);
  const root = useRef<HTMLDivElement>(null);

  // Reloads whenever the file, the repository state or the whitespace switch changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.tet.repository.diff(project.id, path, { ignoreWhitespace }).then((result) => {
      if (cancelled) {
        return;
      }
      if (result.error) {
        notify("error", `${result.path}: ${result.error}`);
      }
      setDiff(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [project.id, path, version, ignoreWhitespace]);

  // Takes the keyboard while it is up and hands it back on the way out: ↑/↓ step through the
  // files, and the terminal a path was ctrl-clicked in would otherwise still be the one
  // getting them — xterm swallows every key it is given, arrows first of all.
  useEffect(() => {
    const previous = document.activeElement;
    root.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) {
        previous.focus();
      }
    };
  }, []);

  useEscape(onClose);

  const act: FileAct = (action) => {
    setActing(true);
    void action()
      .then((result) => {
        if (!result.ok) {
          notify("error", result.error ?? "Git command failed");
        }
      })
      .finally(() => setActing(false));
  };

  return (
    <div className="diff-overlay">
      <div className="diff-dialog" ref={root} tabIndex={-1}>
        <div className="diff-files" style={{ width: filesWidth }}>
          <div className="sidebar-header">
            <span>
              LOCAL CHANGES <span className="count">({changes.length})</span>
            </span>
            {/* This pane's own bar — a discard or an ignore from its list. */}
            {acting && <ProgressBar />}
          </div>
          <ChangesList
            project={project}
            changes={changes}
            act={act}
            onOpenDiff={(next) => onOpenDiff(project.id, next)}
            active={path}
          />
        </div>
        <Sash
          orientation="vertical"
          size={filesWidth}
          min={MIN_PANE_WIDTH}
          minOther={MIN_CONTENT_WIDTH}
          onResize={setFilesWidth}
        />
        <div className="diff-main">
          <div className="diff-dialog-bar">
            <span className="diff-dialog-path">{path}</span>
            {diff && !diff.binary && (
              <button
                className={`icon-button${ignoreWhitespace ? " active" : ""}`}
                title={ignoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
                onClick={() => setIgnoreWhitespace(!ignoreWhitespace)}
              >
                <WhitespaceIcon />
              </button>
            )}
            <button className="icon-button" title="Close" onClick={onClose}>
              <CloseIcon />
            </button>
            {busy && <ProgressBar />}
          </div>
          <DiffView
            projectId={project.id}
            diff={diff}
            loading={loading}
            onBusy={setBusy}
            ignoreWhitespace={ignoreWhitespace}
          />
        </div>
      </div>
    </div>
  );
});
