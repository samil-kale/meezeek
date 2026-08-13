import { useEffect, useState } from "react";
import type { ThemedToken } from "shiki/core";
import type { FileDiff } from "../../shared/types";
import { highlightDiff } from "../diff-highlight";

interface DiffViewProps {
  diff: FileDiff | null;
  loading: boolean;
  /**
   * Reports both waits this view goes through — reading the diff and coloring it — so the tab
   * strip can show them. It is the only place that knows when the second one is over.
   */
  onBusy: (busy: boolean) => void;
}

export function DiffView({ diff, loading, onBusy }: DiffViewProps) {
  /** One token list per line of `diff`, once the grammar has been loaded and run. */
  const [colored, setColored] = useState<(ThemedToken[] | undefined)[]>([]);
  const [highlighting, setHighlighting] = useState(false);

  // Colors arrive after the diff itself: bringing up the highlighter and its grammar is
  // asynchronous, so the diff is on screen as plain text first and repaints once.
  useEffect(() => {
    setColored([]);
    setHighlighting(diff !== null);
    if (!diff) {
      return;
    }
    let cancelled = false;
    void highlightDiff(diff).then((tokens) => {
      if (cancelled) {
        return;
      }
      if (tokens) {
        setColored(tokens);
      }
      setHighlighting(false);
    });
    return () => {
      cancelled = true;
    };
  }, [diff]);

  useEffect(() => onBusy(loading || highlighting), [loading, highlighting, onBusy]);

  if (loading) {
    return <div className="placeholder">Loading diff...</div>;
  }
  if (!diff) {
    return <div className="placeholder">Select a file to see its diff.</div>;
  }
  if (diff.error) {
    return <div className="placeholder error">{diff.error}</div>;
  }
  if (diff.binary) {
    return <div className="placeholder">Binary file.</div>;
  }
  if (diff.lines.length === 0) {
    return <div className="placeholder">No textual changes.</div>;
  }

  return (
    <div className="diff">
      <div className="diff-path">{diff.path}</div>
      <div className="diff-body">
        {diff.lines.map((line, index) => (
          <div key={index} className={`diff-line ${line.type}`}>
            <span className="diff-gutter">{line.oldLine ?? ""}</span>
            <span className="diff-gutter">{line.newLine ?? ""}</span>
            <span className="diff-marker">{line.type === "add" ? "+" : line.type === "del" ? "-" : ""}</span>
            <span className="diff-text">
              {colored[index]?.map((token, position) => (
                <span key={position} style={{ color: token.color }}>
                  {token.content}
                </span>
              )) ?? line.text}
            </span>
          </div>
        ))}
        {diff.truncated && <div className="placeholder">Diff truncated — open the file in your editor to see the rest.</div>}
      </div>
    </div>
  );
}
