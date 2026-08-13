import { useRef, useState, type PointerEvent } from "react";

/**
 * Where a dragged pane size is kept. Layout describes the window rather than any one
 * repository, so it lives in the renderer's own storage instead of the project store, and
 * every project sees the same one.
 */
const STORAGE_PREFIX = "meeseek.layout.";

/** A pane size the user can drag, restored on the next start. */
export function usePaneSize(key: string, initial: number): [number, (size: number) => void] {
  const [size, setSize] = useState(() => {
    const stored = Number(localStorage.getItem(STORAGE_PREFIX + key));
    return Number.isFinite(stored) && stored > 0 ? stored : initial;
  });
  return [
    size,
    (next: number) => {
      setSize(next);
      localStorage.setItem(STORAGE_PREFIX + key, String(next));
    }
  ];
}

interface SashProps {
  /** A vertical sash is dragged left and right, a horizontal one up and down. */
  orientation: "vertical" | "horizontal";
  /** Current size of the pane it resizes. */
  size: number;
  /** How small that pane may be dragged, in pixels. */
  min: number;
  /**
   * The same bound as a share of the container, which is what a pane sized in percent needs —
   * a pixel floor would mean something different in every window size. Wins over `min`.
   */
  minFraction?: number;
  /** How much of the container has to be left over for the pane on the other side. */
  minOther: number;
  /**
   * The pane it sizes is the one *behind* it, not in front — dragging towards it makes it
   * smaller. What the git console needs, since it is the bottom one that keeps its height.
   */
  reverse?: boolean;
  onResize: (size: number) => void;
}

/**
 * The draggable divider between two panes, VS Code's "sash". It sizes the pane in front of it
 * and lets the rest of the container absorb the difference, so of the two sides only one ever
 * carries a size of its own.
 */
export function Sash({ orientation, size, min, minFraction, minOther, reverse, onResize }: SashProps) {
  const vertical = orientation === "vertical";
  const drag = useRef<{ origin: number; size: number; total: number } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);

  const begin = (event: PointerEvent<HTMLDivElement>): void => {
    const container = event.currentTarget.parentElement;
    if (event.button !== 0 || !container) {
      return;
    }
    // Capturing the pointer keeps the moves coming while it is over a terminal, over the diff,
    // or outside the window entirely — no document-level listeners to install and remove.
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      origin: vertical ? event.clientX : event.clientY,
      size,
      // Negative margins pull the sash out of the layout, so the container's own size is what
      // the two panes have to share. Measured once per drag: it cannot change during one.
      total: vertical ? container.clientWidth : container.clientHeight
    };
    setDragging(true);
  };

  const move = (event: PointerEvent<HTMLDivElement>): void => {
    const start = drag.current;
    if (!start) {
      return;
    }
    // Clamped here rather than only in the layout, so dragging back from an edge responds at
    // once instead of first working off an overshoot the user never saw.
    const moved = (vertical ? event.clientX : event.clientY) - start.origin;
    const next = reverse ? start.size - moved : start.size + moved;
    const floor = minFraction === undefined ? min : start.total * minFraction;
    onResize(Math.round(Math.max(floor, Math.min(next, start.total - minOther))));
  };

  const end = (): void => {
    drag.current = undefined;
    setDragging(false);
  };

  return (
    <div
      className={`sash ${orientation}${dragging ? " dragging" : ""}`}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    />
  );
}
