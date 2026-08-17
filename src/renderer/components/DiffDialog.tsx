import { memo, useEffect, useState } from "react";
import type { FileDiff } from "../../shared/types";
import { DiffView } from "./DiffView";
import { CloseIcon, WhitespaceIcon } from "./icons";
import { notify } from "./Notices";
import { useEscape } from "./use-escape";
import { ProgressBar } from "./ProgressBar";

interface DiffDialogProps {
  projectId: string;
  /** Repository-relative path of the file being looked at. */
  path: string;
  /** What the diff depends on besides the file — a change to it reloads while the dialog is open. */
  version: string;
  onClose: () => void;
}

/**
 * One file's diff, over the whole window. A dialog rather than a pane because the git view sits
 * beside the terminals and has no room for it, and because looking at a diff is something you
 * come out of again, unlike the branch list next to it.
 *
 * Not part of Dialog.tsx: that file puts *questions* (confirm, prompt) and is built around a
 * form with two buttons. This asks nothing.
 */
export const DiffDialog = memo(function DiffDialog({ projectId, path, version, onClose }: DiffDialogProps) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  /** Reading the diff and colouring it, `DiffView`'s own two waits — this dialog's own bar. */
  const [busy, setBusy] = useState(false);

  // Reloads whenever the file, the repository state or the whitespace switch changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.tet.repository.diff(projectId, path, { ignoreWhitespace }).then((result) => {
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
  }, [projectId, path, version, ignoreWhitespace]);

  useEscape(onClose);

  return (
    <div className="diff-overlay">
      <div className="diff-dialog">
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
          projectId={projectId}
          diff={diff}
          loading={loading}
          onBusy={setBusy}
          ignoreWhitespace={ignoreWhitespace}
        />
      </div>
    </div>
  );
});
