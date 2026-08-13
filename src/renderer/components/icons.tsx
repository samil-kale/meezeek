import type { NoticeSeverity } from "../../shared/types";

interface IconProps {
  className?: string;
}

function Svg({ children, className }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      // Drawn on a 16 grid but rendered at 18, so the paths keep their proportions and the
      // strokes still land on whole pixels at the usual scale factors.
      width="18"
      height="18"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/**
 * Drawn to the full 2–14 box. An upright cross only ever reaches the edges at four points,
 * while a diagonal one spreads into the corners — so to read as the same size as the close
 * icon beside it, the plus has to be measurably the larger drawing.
 */
export function PlusIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2v12M2 8h12" />
    </Svg>
  );
}

/** Kept inside 3.5–12.5: its diagonals still span as far as the plus's arms do. */
export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </Svg>
  );
}

/**
 * The three shapes VS Code uses for a notification: a cross for an error, an exclamation for a
 * warning, an "i" for information — each in the circle they share, so a glance at the outline
 * alone does not have to carry the meaning that the color does.
 */
export function SeverityIcon({ severity, ...props }: IconProps & { severity: NoticeSeverity }) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="6" />
      {severity === "error" && <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" />}
      {severity === "warning" && <path d="M8 4.6v4.2M8 11.1v.4" />}
      {severity === "info" && <path d="M8 7.4v4M8 4.9v.4" />}
    </Svg>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13 2.5V5h-2.5" />
    </Svg>
  );
}

export function BranchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M11.5 7v.5a3 3 0 0 1-3 3H6" />
    </Svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="7" cy="7" r="3.5" />
      <path d="M9.6 9.6L13 13" />
    </Svg>
  );
}

export function ChevronIcon({ expanded, ...props }: IconProps & { expanded: boolean }) {
  return <Svg {...props}>{expanded ? <path d="M4 6l4 4 4-4" /> : <path d="M6 4l4 4-4 4" />}</Svg>;
}

/**
 * A ring with a gap in it, which only reads as progress while it turns — pair it with the
 * `spinning` class. Takes the place of the icon whose action is running.
 */
export function SpinnerIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="5.5" strokeDasharray="26 9" />
    </Svg>
  );
}

/**
 * Two sparkles, the mark every tool puts on "a model worked this out for you". Filled: at this
 * size the outline of a four-pointed star is mostly its own stroke.
 */
export function SparkleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.6 2.6L8.1 6.8 12.3 8.3 8.1 9.8 6.6 14 5.1 9.8 0.9 8.3 5.1 6.8z" fill="currentColor" stroke="none" />
      <path d="M12.7 1.2L13.4 3.1 15.3 3.8 13.4 4.5 12.7 6.4 12 4.5 10.1 3.8 12 3.1z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Filled, not outlined: at this size a hollow triangle reads as a stray corner. */
export function PlayIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 2.8l8.2 5.2-8.2 5.2z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** A tag: the label on a string that git's own icon sets draw for one. */
export function TagIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 7.7V3a.5.5 0 0 1 .5-.5h4.7a1 1 0 0 1 .7.3l5.1 5.1a1 1 0 0 1 0 1.4l-4.4 4.4a1 1 0 0 1-1.4 0L2.8 8.4a1 1 0 0 1-.3-.7z" />
      <circle cx="5.6" cy="5.6" r="1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** A stash: work set aside in a box, the way an inbox tray is drawn. */
export function StashIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 9.5l1.8-5A1 1 0 0 1 4.8 4h6.4a1 1 0 0 1 1 .5L14 9.5" />
      <path d="M2 9.5h3.2l.8 1.6h4l.8-1.6H14v2A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />
    </Svg>
  );
}

/** What is waiting to be pushed, and the button that pushes it. */
export function ArrowUpIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
    </Svg>
  );
}

export function ArrowDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 3v10M3.5 8.5L8 13l4.5-4.5" />
    </Svg>
  );
}

/** Fetch: the two arrows chasing each other that every git client draws for it. */
export function SyncIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9M13.5 8a5.5 5.5 0 0 1-9.4 3.9" />
      <path d="M12 1.5v3h-3M4 14.5v-3h3" />
    </Svg>
  );
}

/** Two arrows pushed apart, VS Code's own "unfold" — the lines hidden in a gap. */
export function UnfoldIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5.5 5L8 2.5 10.5 5M5.5 11l2.5 2.5L10.5 11M3 8h10" />
    </Svg>
  );
}

/**
 * The whitespace toggle: the row of dots an editor puts where the spaces are. A paragraph mark
 * was the first try and is unreadable at this size — too much line in too little room.
 */
export function WhitespaceIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="3.6" cy="8" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12.4" cy="8" r="1.6" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function RemoteIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="5" />
      <path d="M3 8h10M8 3c1.5 1.7 1.5 8.3 0 10M8 3c-1.5 1.7-1.5 8.3 0 10" />
    </Svg>
  );
}
