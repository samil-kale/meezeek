import type { NoticeSeverity } from "../../shared/types";

interface IconProps {
  className?: string;
}

/**
 * The share of its box a finished icon's drawing covers. Every icon is cut to this, so the box
 * an icon is given is finally the same thing as the size it appears at.
 */
const TARGET_EXTENT = 12.8;
const GRID = 16;

/**
 * How an icon is fitted, given how much of its own grid it actually draws on.
 *
 * The problem this solves: a box is not a size. Measured with `getBBox`, the icons in this file
 * covered anywhere from 59% of their grid (the chevron) to 100% (Claude's mark), so identical
 * `width`s produced visibly different icons — which is exactly what kept being reported as one
 * of them being too big. Rather than redraw two dozen paths, each declares the extent it was
 * measured at, and the viewBox is cropped to put that extent at TARGET_EXTENT of the box.
 *
 * `strokeWidth` is scaled by the same factor, or a cropped viewBox would thicken the stroke of
 * every icon it enlarges — the drawings would match and their weights would not.
 *
 * The extents are tuned to the icon's **geometric mean**, not its longer side. Normalising the
 * long side alone left the lopsided ones looking small next to the square ones — a shape 12
 * wide and 9 tall carries far less ink than one 12 by 12 — and that is what the branch icon,
 * the sync arrows, the sparkle and Claude's mark were all reported for. Each is capped at about
 * 87% of its box in the long axis: a chevron or a row of dots is narrow by nature and must not
 * grow out of its place trying to average out.
 *
 * Re-measure when a path changes; the numbers are observations, not intentions. The audit is a
 * page that renders every icon and reads `getBBox()` on each child, grown by half a stroke.
 */
function geometry(extent: number, cx: number, cy: number, grid: number, stroke: number) {
  const side = (extent * grid) / ((TARGET_EXTENT / GRID) * grid);
  return {
    viewBox: `${cx - side / 2} ${cy - side / 2} ${side} ${side}`,
    strokeWidth: (stroke * side) / grid
  };
}

/** The same fitting for an icon that brings its own grid — see agent-icons.tsx. */
export function fitIcon(extent: number, cx: number, cy: number, grid: number, stroke = 0): string {
  return geometry(extent, cx, cy, grid, stroke).viewBox;
}

export function fitStroke(extent: number, grid: number, stroke: number): number {
  return geometry(extent, 0, 0, grid, stroke).strokeWidth;
}

/**
 * How much smaller than the rest an icon is drawn when it asks to be. Two pixels off the shared
 * `--icon-size`, as a ratio so it holds whatever that size is set to. The box does not change —
 * only the drawing inside it — so nothing shifts in the row around it.
 */
const SMALLER = 11 / 13;

/** The same two pixels the other way, for an icon that asks to read larger — see agent-icons.tsx. */
export const LARGER = 15 / 13;

/**
 * `extent` is how much of the 16 grid this icon draws on, stroke included, and `cx`/`cy` where
 * that drawing is centred. All three are measured.
 *
 * `scale` is the one number here that is a *choice* rather than an observation: it says this
 * icon should read smaller than its neighbours. Keeping it separate is the point — a measured
 * extent stays re-measurable, and an intention stays visible as one.
 */
function Svg({
  children,
  className,
  extent = TARGET_EXTENT,
  cx = 8,
  cy = 8,
  scale = 1
}: IconProps & {
  children: React.ReactNode;
  extent?: number;
  cx?: number;
  cy?: number;
  scale?: number;
}) {
  // Dividing widens the crop, which leaves the drawing smaller inside an unchanged box.
  const { viewBox, strokeWidth } = geometry(extent / scale, cx, cy, GRID, 1.5);
  return (
    <svg
      className={className}
      // The shared icon size, and the same one `--icon-size` states in CSS. It is CSS that
      // actually decides — a flex container renders over these attributes (see .icon-button) —
      // so this is the fallback for a site that forgot to, and it must not disagree with it.
      width="13"
      height="13"
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Svg {...props} extent={13.58}>
      <path d="M8 2v12M2 8h12" />
    </Svg>
  );
}

/** Drawn smaller than the rest: it closes what it sits on, and never leads a row. */
export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props} extent={10.22} scale={SMALLER}>
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
    <Svg {...props} extent={13.58}>
      <circle cx="8" cy="8" r="6" />
      {severity === "error" && <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" />}
      {severity === "warning" && <path d="M8 4.6v4.2M8 11.1v.4" />}
      {severity === "info" && <path d="M8 7.4v4M8 4.9v.4" />}
    </Svg>
  );
}

export function BranchIcon(props: IconProps) {
  return (
    <Svg {...props} extent={12.54}>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M11.5 7v.5a3 3 0 0 1-3 3H6" />
    </Svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props} extent={10.79} cx={8.25} cy={8.25}>
      <circle cx="7" cy="7" r="3.5" />
      <path d="M9.6 9.6L13 13" />
    </Svg>
  );
}

export function ChevronIcon({ expanded, ...props }: IconProps & { expanded: boolean }) {
  return <Svg {...props} extent={8.34}>{expanded ? <path d="M4 6l4 4 4-4" /> : <path d="M6 4l4 4-4 4" />}</Svg>;
}

/**
 * A ring with a gap in it, which only reads as progress while it turns — pair it with the
 * `spinning` class. Takes the place of the icon whose action is running.
 *
 * The dash pattern is the circumference: 2π·5 ≈ 31, an arc of 23 and a gap of 8. Re-cut it
 * whenever the radius moves, or the gap changes width along with it.
 */
export function SpinnerIcon(props: IconProps) {
  return (
    <Svg {...props} extent={11.34}>
      <circle cx="8" cy="8" r="5" strokeDasharray="23 8" />
    </Svg>
  );
}

/**
 * Two sparkles, the mark every tool puts on "a model worked this out for you". Filled: at this
 * size the outline of a four-pointed star is mostly its own stroke.
 */
export function SparkleIcon(props: IconProps) {
  return (
    <Svg {...props} extent={13.6} cx={8.1} cy={7.6}>
      <path d="M6.6 2.6L8.1 6.8 12.3 8.3 8.1 9.8 6.6 14 5.1 9.8 0.9 8.3 5.1 6.8z" fill="currentColor" stroke="none" />
      <path d="M12.7 1.2L13.4 3.1 15.3 3.8 13.4 4.5 12.7 6.4 12 4.5 10.1 3.8 12 3.1z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/**
 * Filled, not outlined: at this size a hollow triangle reads as a stray corner. Drawn smaller
 * than the rest — a solid shape carries more weight than an outline of the same measurement.
 */
export function PlayIcon(props: IconProps) {
  return (
    <Svg {...props} extent={9.6} cx={8.6} scale={SMALLER}>
      <path d="M4.5 2.8l8.2 5.2-8.2 5.2z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** A tag: the label on a string that git's own icon sets draw for one. */
export function TagIcon(props: IconProps) {
  return (
    <Svg {...props} extent={12.9} cx={8.14} cy={8.24}>
      <path d="M2.5 7.7V3a.5.5 0 0 1 .5-.5h4.7a1 1 0 0 1 .7.3l5.1 5.1a1 1 0 0 1 0 1.4l-4.4 4.4a1 1 0 0 1-1.4 0L2.8 8.4a1 1 0 0 1-.3-.7z" />
      <circle cx="5.6" cy="5.6" r="1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/**
 * A commit: a node on the line of history, VS Code's own git-commit glyph. Wide and flat, so
 * the extent is the long-side cap rather than the geometric mean (14.5 by 7.5 with stroke).
 */
export function CommitIcon(props: IconProps) {
  return (
    <Svg {...props} extent={13.33}>
      <circle cx="8" cy="8" r="3" />
      <path d="M1.5 8H5" />
      <path d="M11 8h3.5" />
    </Svg>
  );
}

/** A stash: work set aside in a box, the way an inbox tray is drawn. */
export function StashIcon(props: IconProps) {
  return (
    <Svg {...props} extent={12.54} cy={8.5}>
      <path d="M2 9.5l1.8-5A1 1 0 0 1 4.8 4h6.4a1 1 0 0 1 1 .5L14 9.5" />
      <path d="M2 9.5h3.2l.8 1.6h4l.8-1.6H14v2A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />
    </Svg>
  );
}

/**
 * Throwing local changes away. A bin rather than VS Code's discard mark, which is the refresh
 * arrow turned the other way and reads as one at a glance. It also says what happens: a file
 * git does not track goes to the system trash, not away. Next to the stash box, the pair reads
 * as "put away" and "throw away".
 */
export function DiscardIcon(props: IconProps) {
  return (
    <Svg {...props} extent={12.75} cy={8.25}>
      <path d="M2.5 4h11" />
      <path d="M6 4V2.5h4V4" />
      <path d="M4 4.5l.6 8.6a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9L12 4.5" />
    </Svg>
  );
}

/** What is waiting to be pushed, and the button that pushes it. */
export function ArrowUpIcon(props: IconProps) {
  return (
    <Svg {...props} extent={10.81}>
      <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
    </Svg>
  );
}

export function ArrowDownIcon(props: IconProps) {
  return (
    <Svg {...props} extent={10.81}>
      <path d="M8 3v10M3.5 8.5L8 13l4.5-4.5" />
    </Svg>
  );
}

/** Fetch: the two arrows chasing each other that every git client draws for it. */
export function SyncIcon(props: IconProps) {
  return (
    <Svg {...props} extent={13.68}>
      <path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9M13.5 8a5.5 5.5 0 0 1-9.4 3.9" />
      <path d="M12 1.5v3h-3M4 14.5v-3h3" />
    </Svg>
  );
}

/** Two arrows pushed apart, VS Code's own "unfold" — the lines hidden in a gap. */
export function UnfoldIcon(props: IconProps) {
  return (
    <Svg {...props} extent={11.94}>
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
    <Svg {...props} extent={11.08}>
      <circle cx="3.6" cy="8" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12.4" cy="8" r="1.6" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/**
 * A session stopped mid-turn on a question nobody has answered — on its tab and on its
 * project's row. A question mark rather than a second bubble: it stands next to the bubble and
 * the spinner in the one slot each of those uses, so the three have to be told apart at a
 * glance, and both things that raise it (a permission prompt, an `AskUserQuestion`) are
 * literally questions.
 */
export function QuestionIcon(props: IconProps) {
  return (
    <Svg {...props} extent={9.32} cx={8.05} cy={7.45}>
      <path d="M5.35 5.5a2.7 2.7 0 1 1 2.7 2.85v1.35" />
      <circle cx="8.05" cy="12.15" r="0.35" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/**
 * A tab whose agent cannot start at all — sits in the same mark slot as the question mark and
 * the spinner, so it is drawn in the same family of shape, not a circle-and-cross like a
 * `SeverityIcon`. Its own color, not `--vscode-focusBorder`: see `.session-mark-error`.
 */
export function ExclamationIcon(props: IconProps) {
  return (
    <Svg {...props} extent={9.95} cy={7.86}>
      <path d="M8 3.2v6.3" />
      <circle cx="8" cy="12.1" r="0.42" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** A session answered and nobody has looked yet — on its tab and on its project's row. */
export function CommentIcon(props: IconProps) {
  return (
    <Svg {...props} extent={10.22} cy={7.5}>
      <path d="M3.5 3h9v6.5H7L4.5 12V9.5h-1z" />
    </Svg>
  );
}

export function RemoteIcon(props: IconProps) {
  return (
    <Svg {...props} extent={11.34}>
      <circle cx="8" cy="8" r="5" />
      <path d="M3 8h10M8 3c1.5 1.7 1.5 8.3 0 10M8 3c-1.5 1.7-1.5 8.3 0 10" />
    </Svg>
  );
}

/**
 * The settings, beside the layout picker. Six teeth rather than the eight a gear usually has: at
 * this size the flanks of eight sit less than a stroke width apart and fill in, so what is left
 * of the drawing is a disc with a bumpy edge. The outline is straight segments only, so its box
 * is exactly its vertices' span — 2.2 to 13.8 on both axes — plus one stroke width: 13.1.
 */
export function GearIcon(props: IconProps) {
  return (
    <Svg {...props} extent={13.1}>
      <path d="M6.23 4.03 L6.45 2.2 L9.55 2.2 L9.77 4.03 L10.56 4.48 L12.24 3.76 L13.8 6.45 L12.33 7.55 L12.33 8.45 L13.8 9.55 L12.24 12.24 L10.56 11.52 L9.77 11.97 L9.55 13.8 L6.45 13.8 L6.23 11.97 L5.44 11.52 L3.76 12.24 L2.2 9.55 L3.67 8.45 L3.67 7.55 L2.2 6.45 L3.76 3.76 L5.44 4.48Z" />
      <circle cx="8" cy="8" r="2.2" />
    </Svg>
  );
}

/**
 * The five split-layout presets: a rounded frame plus whatever dividers a preset adds — the same
 * shape as the reference mockup's own preview tiles. All five share one frame and one `extent`,
 * so they read as one family even though each was not run through the `getBBox` audit page this
 * file's own comment calls for (no browser in the environment that drew these) — re-measure them
 * that way before trusting the number, the same as any other icon here.
 */
export function LayoutSingleIcon(props: IconProps) {
  return (
    <Svg {...props} extent={14} cx={8} cy={8}>
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
    </Svg>
  );
}

export function LayoutCols2Icon(props: IconProps) {
  return (
    <Svg {...props} extent={14} cx={8} cy={8}>
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
      <path d="M8 3v10" />
    </Svg>
  );
}

export function LayoutCols3Icon(props: IconProps) {
  return (
    <Svg {...props} extent={14} cx={8} cy={8}>
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
      <path d="M5.83 3v10M10.17 3v10" />
    </Svg>
  );
}

export function LayoutSplitRightIcon(props: IconProps) {
  return (
    <Svg {...props} extent={14} cx={8} cy={8}>
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
      <path d="M8 3v10M8 8h6.5" />
    </Svg>
  );
}

export function LayoutGrid2x2Icon(props: IconProps) {
  return (
    <Svg {...props} extent={14} cx={8} cy={8}>
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
      <path d="M8 3v10M1.5 8h13" />
    </Svg>
  );
}
