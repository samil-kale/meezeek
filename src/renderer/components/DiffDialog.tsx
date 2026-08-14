import { useEffect, useState } from "react";
import type { FileDiff } from "../../shared/types";
import { DiffView } from "./DiffView";
import { CloseIcon } from "./icons";
import { notify } from "./Notices";

interface DiffDialogProps {
  projectId: string;
  /** Repository-relative path of the file being looked at. */
  path: string;
  /** The repository state, so an agent editing this file while it is open reloads the diff. */
  version: unknown;
  onClose: () => void;
  /** Reading and colouring the diff, reported into the one progress bar like everything else. */
  onBusy: (busy: boolean) => void;
}

/**
 * One file's diff, over the whole window. It is a dialog rather than a pane because the git
 * view sits beside the terminals now and has no room for it — and because looking at a diff is
 * something you come out of again, unlike the branch list next to it.
 *
 * Not part of Dialog.tsx: that file puts *questions* (confirm, prompt) and is built around a
 * form with two buttons. This asks nothing.
 */
export function DiffDialog({ projectId, path, version, onClose, onBusy }: DiffDialogProps) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);

  // Reloads whenever the file, the repository state or the whitespace switch changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.meezeek.repository.diff(projectId, path, { ignoreWhitespace }).then((result) => {
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        // Capture phase and swallowed here, so closing this can't double as an ESC keystroke
        // for the terminal that had focus before it opened.
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div className="diff-overlay">
      <div className="diff-dialog">
        <div className="diff-dialog-bar">
          <span className="diff-dialog-path">{path}</span>
          <button className="icon-button" title="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <DiffView
          projectId={projectId}
          diff={diff}
          loading={loading}
          onBusy={onBusy}
          ignoreWhitespace={ignoreWhitespace}
          onIgnoreWhitespace={setIgnoreWhitespace}
        />
      </div>
    </div>
  );
}
