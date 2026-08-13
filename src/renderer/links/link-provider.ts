import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { URL_BODY_CHAR } from "../../shared/urls";
import { isModifierHeld, isModifierKey } from "../platform";

/**
 * How many rows below a cut-off url are considered as its continuation. A long url in a
 * narrow terminal runs over more than the two or three rows a wide one needs, and the
 * walk only happens once the agent has already reported a longer url for what's visible.
 */
const MAX_CONTINUATION_ROWS = 8;

/**
 * Completes a url the agent's own line wrapping cut off, from what the agent recorded
 * printing (see AgentDefinition.resolveUrlPrefix). Deliberately split into a synchronous
 * lookup and a fire-and-forget request: provideLinks runs on every render while the
 * mouse is over the terminal, so the answer may only ever be read from a cache, never
 * waited for. It lands there in time for the next render.
 */
export interface WrappedUrlResolver {
  /** The full url for a fragment, null once known to have none, undefined if not asked yet. */
  lookup(fragment: string): string | null | undefined;
  /** Asks the host. Must be cheap to call repeatedly — it is called until an answer lands. */
  request(fragment: string): void;
}

/**
 * How many rows the search for a wrapped token may walk in each direction. The character
 * budget below it can't bound this on its own: a row that trims to nothing contributes
 * zero to it, and isContinuation() reports every isWrapped row as one — so a run of blank
 * rows written by autowrap (what a TUI's start screen produces) would let the walk run to
 * the end of the scrollback, on every render. A wrapped token spans a handful of rows.
 */
const MAX_WINDOW_ROWS = 20;

interface LinkSegment {
  row: number;
  /** 0-based cell the segment starts at. */
  sx: number;
  /** 0-based cell one past its end. */
  ex: number;
}

/**
 * A regex-based xterm link provider where links are only clickable — and only show
 * their hover underline/pointer cursor — while Ctrl (Cmd on macOS) is held. This
 * avoids the link's click stealing input from CLIs that dynamically enable their own
 * xterm mouse tracking (e.g. interactive selection lists), which a plain click would
 * otherwise disrupt.
 */
export function createModifierGatedLinkProvider(
  terminal: Terminal,
  regex: RegExp,
  onActivate: (text: string) => void,
  resolveWrapped?: WrappedUrlResolver
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      callback(computeLinks(bufferLineNumber, terminal, regex, onActivate, resolveWrapped));
    }
  };
}

function computeLinks(
  y: number,
  terminal: Terminal,
  regex: RegExp,
  onActivate: (text: string) => void,
  resolveWrapped?: WrappedUrlResolver
): ILink[] {
  const rex = new RegExp(regex.source, (regex.flags || "") + "g");
  const [lines, startLineIndex, offsets] = getWindowedLineStrings(y - 1, terminal);
  const line = lines.join("");

  const result: ILink[] = [];
  let match;
  while ((match = rex.exec(line))) {
    const text = match[0];

    // Map string positions back to buffer positions (values are 0-based, right side excluding).
    const [startY, startX] = mapStrIdx(terminal, startLineIndex, offsets[0] ?? 0, match.index, startLineIndex, offsets);
    const [endY, endX] = mapStrIdx(terminal, startY, startX, text.length, startLineIndex, offsets);

    if (startY === -1 || startX === -1 || endY === -1 || endX === -1) {
      continue;
    }

    // Where the match actually has characters, row by row — what gets underlined.
    const segments: LinkSegment[] = [];
    for (let row = startY; row <= endY; row++) {
      const sx = row === startY ? startX : (offsets[row - startLineIndex] ?? 0);
      const ex = row === endY ? endX : rowTextEnd(terminal, row);
      // Skips the empty tail segment mapStrIdx yields when a match ends exactly at a
      // row's right edge (it reports the position as the start of the row below).
      if (ex > sx) {
        segments.push({ row, sx, ex });
      }
    }
    const first = segments[0];
    if (!first) {
      continue;
    }

    // Stitching rows by geometry (see getWindowedLineStrings) only catches a wrap that ran
    // into the right edge. opencode breaks a long token at the last "." before its wrap
    // width instead, leaving nothing in the buffer to recognize it by — such a row looks
    // exactly like one that simply ends in a url. So the agent is asked what it printed,
    // and the answer is only believed if the rows below spell it out.
    const linkText = completeWrapped(terminal, line, match.index, text, segments, resolveWrapped);

    // One link for the whole match, spanning every row it covers: xterm keeps only one
    // link per column of the queried row (Linkifier._removeIntersectingLinks projects each
    // link onto that row's columns and drops whatever overlaps), so a link per row would
    // have its later rows silently dropped and stay unclickable. The range decides what is
    // clickable; the underline is drawn from `segments` instead (see buildLink).
    // Read back rather than reusing the earlier last: a completed url appends further rows.
    const end = segments[segments.length - 1];
    // range expects values 1-based, right side including, thus +1 except for ex.
    const range = {
      start: { x: first.sx + 1, y: first.row + 1 },
      end: { x: end.ex, y: end.row + 1 }
    };

    result.push(buildLink(terminal, range, segments, linkText, onActivate));
  }

  return result;
}

/**
 * Extends `segments` over the rows a cut-off url continues on and returns the url to open.
 * Falls back to `text` unchanged whenever anything doesn't line up, so the worst case is
 * the behaviour without a resolver at all.
 */
function completeWrapped(
  terminal: Terminal,
  line: string,
  matchIndex: number,
  text: string,
  segments: LinkSegment[],
  resolveWrapped: WrappedUrlResolver | undefined
): string {
  const last = segments[segments.length - 1];
  // The file-link provider shares this function and passes no resolver.
  if (!resolveWrapped) {
    return text;
  }
  // No modifier gate: the resolver is asked once per distinct fragment and the answer is
  // cached (including "nothing"), so hovering costs a Map lookup either way.
  //
  // The url as it stands on screen: the match plus whatever non-space characters follow
  // it. That tail is what URL_REGEX refuses to end a match on ("." and friends) and is
  // exactly where opencode cuts a url — so it belongs to the fragment being completed.
  // Deliberately not "up to the end of the row": opencode keeps a status column over on
  // the right, so a row's own text is rarely the last thing on it.
  const trailing = /^\S*/.exec(line.slice(matchIndex + text.length))?.[0] ?? "";
  const visible = text + trailing;
  const known = resolveWrapped.lookup(visible);
  if (known === undefined) {
    resolveWrapped.request(visible);
    return text;
  }
  if (known === null || known.length <= visible.length) {
    return text;
  }
  // The agent knows a longer url — believed only if the rows below actually spell it out,
  // so a line that merely ends in a shorter url can't pick up a longer one.
  const rows = continuationRows(terminal, last.row);
  const candidate = visible + rows.map((row) => row.text).join("");
  if (!candidate.startsWith(known)) {
    return text;
  }
  // Extend the underline over `trailing` only — not to the row's last visible cell, which
  // with opencode's status column showing sits far to the right of this row's own text.
  // Clamped anyway, in case the match ended right at a row boundary of the window.
  last.ex = Math.min(last.ex + trailing.length, rowTextEnd(terminal, last.row));
  let pending = known.length - visible.length;
  for (const row of rows) {
    if (pending <= 0) {
      break;
    }
    const taken = Math.min(pending, row.text.length);
    segments.push({ row: row.row, sx: row.offset, ex: row.offset + taken });
    pending -= taken;
  }
  return known;
}

/**
 * What the rows below `fromRow` could contribute to a url cut off at its end: each row's
 * leading run of url characters, with the indent a CLI puts in front of a wrapped line
 * dropped. A candidate only — the caller checks it against what the agent reports.
 */
function continuationRows(terminal: Terminal, fromRow: number): { row: number; offset: number; text: string }[] {
  const rows: { row: number; offset: number; text: string }[] = [];
  for (let row = fromRow + 1; row <= fromRow + MAX_CONTINUATION_ROWS; row++) {
    const line = terminal.buffer.active.getLine(row);
    if (!line) {
      break;
    }
    const content = line.translateToString(true);
    const unindented = content.replace(/^ +/, "");
    let end = 0;
    while (end < unindented.length && URL_BODY_CHAR.test(unindented[end])) {
      end++;
    }
    if (end === 0) {
      break;
    }
    rows.push({ row, offset: content.length - unindented.length, text: unindented.slice(0, end) });
    // Deliberately no "stop once the row continues with something no url could contain":
    // with opencode's status column showing, every row continues with something. Whether
    // these rows really belong to the url is decided by matching the agent's own record
    // against them, and a row that contributes junk makes that match fail — which is the
    // outcome we want anyway.
  }
  return rows;
}

function buildLink(
  terminal: Terminal,
  range: ILink["range"],
  segments: LinkSegment[],
  text: string,
  onActivate: (text: string) => void
): ILink {
  let onKeyDown: ((event: KeyboardEvent) => void) | undefined;
  let onKeyUp: ((event: KeyboardEvent) => void) | undefined;
  let underlines: HTMLElement[] = [];

  const clearUnderline = () => {
    for (const element of underlines) {
      element.remove();
    }
    underlines = [];
  };

  /**
   * xterm's own link underline follows the text from the range's start to its end, which
   * across rows also covers the gap left of a row's right edge and the indent in front of
   * a wrapped one. Drawing one rule per segment instead puts it exactly under the
   * characters.
   *
   * Hand-placed rather than via terminal.registerDecoration(), which would do the same job
   * against buffer markers: those are hidden outright while the alternate screen is active
   * (`display = altBufferIsActive ? "none" : "block"` in xterm's BufferDecorationRenderer),
   * and a full-screen agent TUI is exactly that case. Nothing here outlives the hover, so
   * not tracking the buffer costs nothing — a scroll ends the hover and clears it.
   */
  const drawUnderline = () => {
    clearUnderline();
    const screen = terminal.element?.querySelector(".xterm-screen");
    if (!(screen instanceof HTMLElement)) {
      return;
    }
    // xterm sizes the screen to exactly cols x rows cells (it absorbs the remainder into
    // letter-spacing), so dividing gives the cell size back without measuring a glyph.
    const cellWidth = screen.clientWidth / terminal.cols;
    const cellHeight = screen.clientHeight / terminal.rows;
    for (const segment of segments) {
      const viewportRow = segment.row - terminal.buffer.active.viewportY;
      if (viewportRow < 0 || viewportRow >= terminal.rows) {
        continue;
      }
      const element = document.createElement("div");
      element.style.position = "absolute";
      element.style.left = `${segment.sx * cellWidth}px`;
      element.style.top = `${(viewportRow + 1) * cellHeight - 1}px`;
      element.style.width = `${(segment.ex - segment.sx) * cellWidth}px`;
      element.style.height = "1px";
      element.style.backgroundColor = "currentColor";
      // The link's own range already handles hit testing — an element on top of the
      // cells must not swallow the clicks meant for it.
      element.style.pointerEvents = "none";
      screen.appendChild(element);
      underlines.push(element);
    }
  };

  const link: ILink = {
    range,
    text,
    // Hidden by default — only shown while the modifier is held (see hover() below).
    // `underline` stays off for good: the one drawn in drawUnderline() replaces it.
    decorations: { pointerCursor: false, underline: false },
    activate(event) {
      // A plain click is a no-op: the running CLI may have its own xterm mouse
      // tracking enabled and handle the click itself, and we must not interfere.
      if (isModifierHeld(event)) {
        onActivate(text);
      }
    },
    dispose: clearUnderline,
    hover(event) {
      const setDecorations = (held: boolean) => {
        if (link.decorations) {
          link.decorations.pointerCursor = held;
        }
        if (held) {
          drawUnderline();
        } else {
          clearUnderline();
        }
      };
      // xterm calls this hover() callback before it replaces link.decorations with
      // its own live-tracked proxy object, so a synchronous mutation here would be
      // silently discarded. Defer to the next microtask, by which point the proxy
      // is installed and the mutation actually takes effect.
      queueMicrotask(() => setDecorations(isModifierHeld(event)));
      onKeyDown = (e) => {
        if (isModifierKey(e)) {
          setDecorations(true);
        }
      };
      onKeyUp = (e) => {
        if (isModifierKey(e)) {
          setDecorations(false);
        }
      };
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup", onKeyUp);
    },
    leave() {
      if (onKeyDown) {
        window.removeEventListener("keydown", onKeyDown);
      }
      if (onKeyUp) {
        window.removeEventListener("keyup", onKeyUp);
      }
      onKeyDown = undefined;
      onKeyUp = undefined;
      clearUnderline();
    }
  };
  return link;
}

// Adapted from @xterm/addon-web-links's LinkComputer (not publicly exported, so not
// importable directly). Stitches together wrapped lines so a token that visually
// wraps across terminal columns is still matched as one string, and maps a regex
// match's string index back to buffer cell coordinates.
//
// Extended beyond the original, which only ever stitched xterm's own soft wrap
// (`isWrapped`, set when xterm itself had to wrap because a cell was written past the
// last column). A CLI that wraps its output itself instead — Claude Code's Ink renderer
// does, writing each visual row followed by a real newline — leaves `isWrapped` false on
// every row, so a url too long for the terminal width was split into rows the original
// never joined and stayed unclickable. `isContinuation()` below treats a row whose
// predecessor was filled to the last column as a continuation too, and `readLine()` drops
// the indent such a CLI puts in front of continuation rows (Claude Code aligns wrapped
// prose under its marker).

/** Whether the row at `lineIndex` continues the text of the row above it. */
function isContinuation(terminal: Terminal, lineIndex: number): boolean {
  const line = terminal.buffer.active.getLine(lineIndex);
  if (!line) {
    return false;
  }
  if (line.isWrapped) {
    return true;
  }
  const previous = terminal.buffer.active.getLine(lineIndex - 1);
  // translateToString(true) trims trailing whitespace, so a result still as wide as the
  // row means its last cell holds text — i.e. it ran into the right edge and whatever
  // follows on the next row is where it continues.
  return !!previous && previous.translateToString(true).length >= previous.length;
}

/** Cell index one past the row's last non-blank cell. */
function rowTextEnd(terminal: Terminal, lineIndex: number): number {
  const line = terminal.buffer.active.getLine(lineIndex);
  return line ? line.translateToString(true).length : 0;
}

/** The row's text plus the cell offset that text starts at (non-zero if an indent was dropped). */
function readLine(terminal: Terminal, lineIndex: number): [string, number] {
  const line = terminal.buffer.active.getLine(lineIndex);
  if (!line) {
    return ["", 0];
  }
  const content = line.translateToString(true);
  // Only a CLI's own hard break can carry an inserted indent — xterm's soft wrap never
  // adds one, so leading spaces on an isWrapped row are real content and stay.
  if (line.isWrapped || !isContinuation(terminal, lineIndex)) {
    return [content, 0];
  }
  const unindented = content.replace(/^ +/, "");
  return [unindented, content.length - unindented.length];
}

function getWindowedLineStrings(lineIndex: number, terminal: Terminal): [string[], number, number[]] {
  let topIdx = lineIndex;
  let bottomIdx = lineIndex;
  let length: number;
  let rows: number;
  let content: string;
  let offset: number;
  const lines: string[] = [];
  const offsets: number[] = [];

  if (terminal.buffer.active.getLine(lineIndex)) {
    const [currentContent, currentOffset] = readLine(terminal, lineIndex);

    // Expand top, stop on whitespace, length > 2048 or MAX_WINDOW_ROWS rows.
    if (isContinuation(terminal, lineIndex) && currentContent[0] !== " ") {
      length = 0;
      rows = 0;
      while (terminal.buffer.active.getLine(--topIdx) && length < 2048 && ++rows <= MAX_WINDOW_ROWS) {
        [content, offset] = readLine(terminal, topIdx);
        length += content.length;
        lines.push(content);
        offsets.push(offset);
        if (!isContinuation(terminal, topIdx) || content.indexOf(" ") !== -1) {
          break;
        }
      }
      lines.reverse();
      offsets.reverse();
    }

    lines.push(currentContent);
    offsets.push(currentOffset);

    // Expand bottom, stop on whitespace, length > 2048 or MAX_WINDOW_ROWS rows.
    length = 0;
    rows = 0;
    while (
      isContinuation(terminal, bottomIdx + 1) &&
      terminal.buffer.active.getLine(++bottomIdx) &&
      length < 2048 &&
      ++rows <= MAX_WINDOW_ROWS
    ) {
      [content, offset] = readLine(terminal, bottomIdx);
      length += content.length;
      lines.push(content);
      offsets.push(offset);
      if (content.indexOf(" ") !== -1) {
        break;
      }
    }
  }
  return [lines, topIdx, offsets];
}

function mapStrIdx(
  terminal: Terminal,
  lineIndex: number,
  rowIndex: number,
  stringIndex: number,
  startLineIndex: number,
  offsets: number[]
): [number, number] {
  const buf = terminal.buffer.active;
  const cell = buf.getNullCell();
  let start = rowIndex;
  while (stringIndex) {
    const line = buf.getLine(lineIndex);
    if (!line) {
      return [-1, -1];
    }
    for (let i = start; i < line.length; ++i) {
      line.getCell(i, cell);
      const chars = cell.getChars();
      const width = cell.getWidth();
      if (width) {
        stringIndex -= chars.length || 1;

        // Correct stringIndex for early wrapped wide chars:
        // - currently only happens at last cell
        // - cells to the right are reset with chars='' and width=1 in InputHandler.print
        // - follow-up line must be wrapped and contain wide char at first cell
        // --> if all these conditions are met, correct stringIndex by +1
        if (i === line.length - 1 && chars === "") {
          const nextLine = buf.getLine(lineIndex + 1);
          if (nextLine && nextLine.isWrapped) {
            nextLine.getCell(0, cell);
            if (cell.getWidth() === 2) {
              stringIndex += 1;
            }
          }
        }
      }
      if (stringIndex < 0) {
        return [lineIndex, i];
      }
    }
    lineIndex++;
    // Resume at the cell the next row's text starts at, skipping an indent readLine()
    // dropped — the string being walked doesn't contain those cells.
    start = offsets[lineIndex - startLineIndex] ?? 0;
  }
  return [lineIndex, start];
}
