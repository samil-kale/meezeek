import { useRef, useState, type PointerEvent } from "react";

/**
 * Where a dragged pane size is kept. Layout describes the window rather than any one
 * repository, so it lives in the renderer's own storage instead of the project store, and
 * every project sees the same one.
 */
const STORAGE_PREFIX = "meeseex.layout.";

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
  /** Current size of the pane in front of the sash — the one it resizes. */
  size: number;
  /** How small that pane may be dragged. */
  min: number;
  /** How much of the container has to be left over for everything behind the sash. */
  minOther: number;
  onResize: (size: number) => void;
}

/**
 * The draggable divider between two panes, VS Code's "sash". It sizes the pane in front of it
 * and lets the rest of the container absorb the difference, so of the two sides only one ever
 * carries a size of its own.
 */
export function Sash({ orientation, size, min, minOther, onResize }: SashProps) {
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
    onResize(Math.max(min, Math.min(start.size + moved, start.total - minOther)));
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
