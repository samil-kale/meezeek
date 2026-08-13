import type { FileDiff } from "../../shared/types";

interface DiffViewProps {
  diff: FileDiff | null;
  loading: boolean;
}

export function DiffView({ diff, loading }: DiffViewProps) {
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
            <span className="diff-text">{line.text}</span>
          </div>
        ))}
        {diff.truncated && <div className="placeholder">Diff truncated — open the file in your editor to see the rest.</div>}
      </div>
    </div>
  );
}
