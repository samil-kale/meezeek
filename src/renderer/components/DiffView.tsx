import { useEffect, useMemo, useRef, useState } from "react";
import type { ThemedToken } from "shiki/core";
import type { DiffLine, FileDiff, ImageDiff } from "../../shared/types";
import { highlightDiff } from "../diff-highlight";
import { UnfoldIcon, WhitespaceIcon } from "./icons";

interface DiffViewProps {
  /** Whose diff this is; the view reads the file itself when a gap is opened. */
  projectId: string;
  diff: FileDiff | null;
  loading: boolean;
  /**
   * Reports both waits this view goes through — reading the diff and coloring it — so the tab
   * strip can show them. It is the only place that knows when the second one is over.
   */
  onBusy: (busy: boolean) => void;
  ignoreWhitespace: boolean;
  onIgnoreWhitespace: (ignore: boolean) => void;
}

/** Context lines a gap was filled with, keyed by the index of the hunk header it sits above. */
type OpenedGaps = Record<number, DiffLine[]>;

/** Where the lines missing in front of a hunk header start and end, in the new file. */
function gapBefore(lines: readonly DiffLine[], index: number): { from: number; to: number } | undefined {
  const header = lines[index];
  if (header.newLine === undefined) {
    return undefined;
  }
  // The last numbered line before this header is where the file was left off; without one,
  // this is the first hunk and the gap starts at the top of the file.
  let previous = 0;
  for (let before = index - 1; before >= 0; before--) {
    const line = lines[before];
    if (line.type !== "hunk" && line.newLine !== undefined) {
      previous = line.newLine;
      break;
    }
  }
  const from = previous + 1;
  const to = header.newLine - 1;
  return to >= from ? { from, to } : undefined;
}

function ImageView({ image }: { image: ImageDiff }) {
  if (!image.before && !image.after) {
    return <div className="placeholder">Image too large to show.</div>;
  }
  // GitHub Desktop's two-up view: the committed version beside the current one, and only the
  // one that exists when the file was added or deleted.
  return (
    <div className="image-diff">
      {image.before && (
        <figure>
          <img src={image.before} alt="" />
          <figcaption>Before</figcaption>
        </figure>
      )}
      {image.after && (
        <figure>
          <img src={image.after} alt="" />
          <figcaption>After</figcaption>
        </figure>
      )}
    </div>
  );
}

export function DiffView({
  projectId,
  diff,
  loading,
  onBusy,
  ignoreWhitespace,
  onIgnoreWhitespace
}: DiffViewProps) {
  /** One token list per line of the diff, once the grammar has been loaded and run. */
  const [colored, setColored] = useState<(ThemedToken[] | undefined)[]>([]);
  const [highlighting, setHighlighting] = useState(false);
  const [opened, setOpened] = useState<OpenedGaps>({});
  /** The diff on screen, for a gap that was still being read when it was replaced. */
  const current = useRef(diff);

  // A gap belongs to the diff it was opened in — a reload, or another file, closes it again.
  useEffect(() => {
    current.current = diff;
    setOpened({});
  }, [diff]);

  /** Where the hunk headers sit in the diff git reported, in order. */
  const hunkIndices = useMemo(
    () => (diff?.lines ?? []).flatMap((line, index) => (line.type === "hunk" ? [index] : [])),
    [diff]
  );

  /** The diff as it is on screen: what git reported, with the opened gaps filled in. */
  const shown = useMemo<FileDiff | null>(() => {
    if (!diff || Object.keys(opened).length === 0) {
      return diff;
    }
    const lines: DiffLine[] = [];
    diff.lines.forEach((line, index) => {
      lines.push(...(opened[index] ?? []), line);
    });
    return { ...diff, lines };
  }, [diff, opened]);

  // Colors arrive after the diff itself: bringing up the highlighter and its grammar is
  // asynchronous, so the diff is on screen as plain text first and repaints once. Opening a
  // gap goes through here as well, so the lines it added are colored like the rest.
  useEffect(() => {
    setColored([]);
    setHighlighting(shown !== null);
    if (!shown) {
      return;
    }
    let cancelled = false;
    void highlightDiff(shown).then((tokens) => {
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
  }, [shown]);

  // Taken back when this view goes: the dialog can be closed while the diff is still being
  // read or coloured, and a "busy" nobody is left to clear would keep the one progress bar
  // running for the rest of the session.
  useEffect(() => {
    onBusy(loading || highlighting);
    return () => onBusy(false);
  }, [loading, highlighting, onBusy]);

  /**
   * Fills the gap in front of a hunk header with the file's own lines. Context lines are the
   * same in both versions, so the working tree holds all of them; the offset between the two
   * line numbers is whatever it is at the hunk that follows.
   */
  const openGap = async (index: number, from: number, to: number): Promise<void> => {
    if (!diff) {
      return;
    }
    const header = diff.lines[index];
    const offset = (header.oldLine ?? 1) - (header.newLine ?? 1);
    const texts = await window.meeseek.repository.fileLines(projectId, diff.path, from, to);
    // Reading them took a moment, and in it the file on screen may have become another one —
    // or the same one reloaded. `index` then points into a diff these lines are not from.
    if (texts.length === 0 || current.current !== diff) {
      return;
    }
    setOpened((current) => ({
      ...current,
      [index]: texts.map((text, line) => ({
        type: "context" as const,
        oldLine: from + line + offset,
        newLine: from + line,
        text
      }))
    }));
  };

  // Empty while one is being read, and nothing that says so: the one progress bar under the
  // tab strip is what reports that.
  if (loading) {
    return null;
  }
  if (!diff || !shown) {
    return <div className="placeholder">Select a file to see its diff.</div>;
  }

  const body = (): React.ReactNode => {
    if (diff.error) {
      // The reason went out as a notice when the diff was read; the pane only says that there
      // is nothing to show, so a message the user dismissed does not linger here.
      return <div className="placeholder">Diff unavailable.</div>;
    }
    if (diff.image) {
      return <ImageView image={diff.image} />;
    }
    if (diff.binary) {
      return <div className="placeholder">Binary file.</div>;
    }
    if (shown.lines.length === 0) {
      return (
        <div className="placeholder">
          {ignoreWhitespace ? "No changes beyond whitespace." : "No textual changes."}
        </div>
      );
    }

    // Hunk headers come in the same order in both lists, so counting them off is all it takes
    // to know which line of the original diff a rendered header is.
    let hunk = 0;
    let source = -1;
    return (
      <div className="diff-body">
        {shown.lines.map((line, index) => {
          if (line.type === "hunk") {
            source = hunkIndices[hunk++];
          }
          const gap = line.type === "hunk" && !opened[source] ? gapBefore(diff.lines, source) : undefined;
          return (
            <div key={index} className={`diff-line ${line.type}`}>
              {gap ? (
                <button
                  className="diff-unfold"
                  title={`Show lines ${gap.from} to ${gap.to}`}
                  onClick={() => void openGap(source, gap.from, gap.to)}
                >
                  <UnfoldIcon />
                </button>
              ) : (
                <span className="diff-gutter">{line.type === "hunk" ? "" : (line.oldLine ?? "")}</span>
              )}
              <span className="diff-gutter">{line.type === "hunk" ? "" : (line.newLine ?? "")}</span>
              <span className="diff-marker">{line.type === "add" ? "+" : line.type === "del" ? "-" : ""}</span>
              <span className="diff-text">
                {colored[index]?.map((token, position) => (
                  <span key={position} style={{ color: token.color }}>
                    {token.content}
                  </span>
                )) ?? line.text}
              </span>
            </div>
          );
        })}
        {diff.truncated && (
          <div className="placeholder">Diff truncated — open the file in your editor to see the rest.</div>
        )}
      </div>
    );
  };

  return (
    <div className="diff">
      <div className="diff-header">
        <span className="diff-path">{diff.path}</span>
        {!diff.binary && (
          <button
            className={`icon-button${ignoreWhitespace ? " active" : ""}`}
            title={ignoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
            onClick={() => onIgnoreWhitespace(!ignoreWhitespace)}
          >
            <WhitespaceIcon />
          </button>
        )}
      </div>
      {body()}
    </div>
  );
}
