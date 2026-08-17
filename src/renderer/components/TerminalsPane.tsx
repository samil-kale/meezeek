import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentInfo, Project, TerminalDescriptor } from "../../shared/types";
import { disposeTerminal, setRevealHandler } from "../terminal-views";
import { PANE_IDS, layoutStorageKey } from "../pane-layout";
import type { PaneId, ProjectLayout, SplitPreset } from "../pane-layout";
import { MIN_PANE_HEIGHT, MIN_PANE_WIDTH, PERSIST_MS, Sash } from "./Sash";
import { Pane, type PaneChrome } from "./Pane";

/**
 * A divider's position as a *share* of the room it divides, not a pixel count — `usePaneSize`'s
 * unit, which is right for a sidebar, is wrong here. A size stored in pixels is only ever
 * correct for the container it was dragged against; a split has to stay proportional when the
 * window, the sidebar or the git pane change the room it has, and keeping a pixel size in step
 * with that meant rescaling every stored value on every resize — bookkeeping that could drift
 * from an even split for reasons it never saw. A fraction needs none of it: `renderGrid`
 * multiplies it by `.panes-grid`'s own current measurement on every render, so a divider nobody
 * has dragged is an exact even split at any size (the default alone does that — nothing has to
 * know whether it was ever touched), and a dragged one stays exactly the share it was set to. A
 * drag reports itself in pixels, the only unit `Sash` deals in, and is turned back into a
 * fraction of the room it was dragged against before it gets here — see `divider` below.
 *
 * Restored on the next start, under the project like the layout itself (`layoutStorageKey`).
 * Anything but a fraction strictly between 0 and 1 is ignored on both ends: read back, since
 * the value is a file the user can edit, and written, since a room too small for two minimum
 * panes has no valid share to store.
 */
function useDividerFraction(projectId: string, name: string, initial: number): [number, (fraction: number) => void] {
  const storageKey = layoutStorageKey(projectId, `divider.${name}`);
  const [fraction, setFraction] = useState(() => {
    const stored = Number(localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored > 0 && stored < 1 ? stored : initial;
  });
  // Stored once the drag has settled rather than per pointer move, on `usePaneSize`'s own clock
  // and for its reason: the write is synchronous, and a drag delivers a size per move.
  const persist = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const set = useCallback(
    (next: number) => {
      if (!(next > 0 && next < 1)) {
        return;
      }
      setFraction(next);
      clearTimeout(persist.current);
      persist.current = setTimeout(() => localStorage.setItem(storageKey, String(next)), PERSIST_MS);
    },
    [storageKey]
  );
  return [fraction, set];
}

/**
 * The pixel size a divider is rendered at: `fraction` of `containerSize`, floored at `min` and
 * capped so the pane on the other side keeps `minOther` — the same bounds `Sash` applies to a
 * drag, applied here to a stored share too, since a share stored against a wider room can ask
 * for more than a narrower one has. `null` while the grid has not been measured yet gives
 * `min`, corrected the moment `gridSize` arrives — see the `useLayoutEffect` below for why that
 * is before the first paint, not one after it.
 */
function clampPixels(pixels: number, min: number, minOther: number, containerSize: number): number {
  return Math.min(Math.max(pixels, min), Math.max(min, containerSize - minOther));
}

function pixelsFor(fraction: number, min: number, minOther: number, containerSize: number | null): number {
  return containerSize === null ? min : clampPixels(Math.round(containerSize * fraction), min, minOther, containerSize);
}

/** The tabs of a pane that has none — one shared instance, so an empty pane's prop is stable. */
const NO_PANE_TABS: TerminalDescriptor[] = [];

/** `next` unless `previous` already holds the same tabs — then that one, identity and all. */
function sameTabs(previous: TerminalDescriptor[] | undefined, next: TerminalDescriptor[]): TerminalDescriptor[] {
  if (next.length === 0) {
    return NO_PANE_TABS;
  }
  return previous && previous.length === next.length && previous.every((tab, i) => tab === next[i]) ? previous : next;
}

interface TerminalsPaneProps {
  project: Project;
  /** This project's tabs. Held by App, since the project list needs every project's. */
  tabs: TerminalDescriptor[];
  visible: boolean;
  /** Whether the git pane beside this one is open; the button in the strip shows which. */
  gitOpen: boolean;
  onToggleGit: () => void;
  /** Anything slow in this project — an agent starting, a branch command, a diff being read — for the one bar. */
  externalBusy: boolean;
  /** A file ctrl-clicked in a terminal; it opens over everything as a diff. */
  onOpenDiff: (projectId: string, path: string) => void;
  /** This project's split state — preset, focus, and which pane every tab and its selection live in. */
  layout: ProjectLayout;
  onActivateTab: (projectId: string, tabId: string, paneId?: PaneId) => void;
  onFocusPane: (projectId: string, paneId: PaneId) => void;
  onPresetChange: (projectId: string, preset: SplitPreset) => void;
  /** Tabs whose finished turn is still waiting to be looked at — App decides, this draws it. */
  markedTabIds: string[];
  /** Tabs stopped mid-turn on an unanswered question — decided in App for the same reason. */
  waitingTabIds: string[];
}

/**
 * One project's terminals: its panes, laid out by its preset, with a `Sash` between each pair.
 * The panes themselves are `Pane`; this is what decides how many there are, how big, and which
 * tabs each one holds — see "Split view" in CLAUDE.md.
 */
export const TerminalsPane = memo(function TerminalsPane({
  project,
  tabs,
  visible,
  gitOpen,
  onToggleGit,
  externalBusy,
  onOpenDiff,
  layout,
  onActivateTab,
  onFocusPane,
  onPresetChange,
  markedTabIds,
  waitingTabIds
}: TerminalsPaneProps) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  /** Which pane a dragged tab is over right now, if any — what decides which dividers border it. */
  const [dragOverPane, setDragOverPane] = useState<PaneId | null>(null);
  const knownTabs = useRef<TerminalDescriptor[]>([]);

  useEffect(() => {
    void window.meezeek.agents.list().then(setAgents);
  }, []);

  // Ctrl+clicking a changed file in a terminal opens that file's diff over everything.
  useEffect(() => setRevealHandler(project.id, (path) => onOpenDiff(project.id, path)), [project.id, onOpenDiff]);

  // The xterm instances live outside React, keyed by tab id — a tab gone for good (not just
  // moved to another pane) is where they are let go of.
  useEffect(() => {
    const previous = knownTabs.current;
    knownTabs.current = tabs;
    const ids = new Set(tabs.map((tab) => tab.tabId));
    for (const tab of previous) {
      if (!ids.has(tab.tabId)) {
        disposeTerminal(project.id, tab.tabId);
      }
    }
  }, [tabs, project.id]);

  // Every possible divider's own share of its container — declared unconditionally, since
  // hooks cannot follow which preset happens to be active. Only the ones the current preset
  // actually renders a Sash for ever change or get read.
  const [cols2Fraction, setCols2Fraction] = useDividerFraction(project.id, "cols2", 1 / 2);
  const [cols3AFraction, setCols3AFraction] = useDividerFraction(project.id, "cols3-a", 1 / 3);
  // Of what is left once "a" has its third — half of it, so all three come out even.
  const [cols3BFraction, setCols3BFraction] = useDividerFraction(project.id, "cols3-b", 1 / 2);
  const [splitRightColFraction, setSplitRightColFraction] = useDividerFraction(project.id, "split-right-col", 1 / 2);
  const [splitRightRowFraction, setSplitRightRowFraction] = useDividerFraction(project.id, "split-right-row", 1 / 2);
  const [gridColFraction, setGridColFraction] = useDividerFraction(project.id, "grid2x2-col", 1 / 2);
  const [gridRowAFraction, setGridRowAFraction] = useDividerFraction(project.id, "grid2x2-row-a", 1 / 2);
  const [gridRowBFraction, setGridRowBFraction] = useDividerFraction(project.id, "grid2x2-row-b", 1 / 2);

  const gridRef = useRef<HTMLDivElement>(null);
  /**
   * `.panes-grid`'s own last measured size — what every divider's fraction is multiplied by in
   * `renderGrid`. Nothing here ever writes a divider's own stored value: a fraction already
   * means the same thing at any size, so keeping it in step with a resize is `renderGrid` simply
   * running again with a new `gridSize`, not something this effect has to do.
   *
   * `useLayoutEffect`, not `useEffect`, and seeded with a synchronous `getBoundingClientRect()`
   * rather than waiting on the observer's own first callback: that callback is inherently
   * asynchronous (part of the spec, not an implementation detail to work around), so a plain
   * effect would let the browser paint once with `gridSize` still null before correcting itself.
   * Measuring synchronously here means React has the real number *before* that first paint, so a
   * project whose persisted preset is already "cols2" the moment it opens shows an even split
   * immediately rather than flashing the wrong one first.
   */
  const [gridSize, setGridSize] = useState<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const element = gridRef.current;
    if (!element) {
      return;
    }
    const seed = element.getBoundingClientRect();
    if (seed.width > 0 && seed.height > 0) {
      setGridSize({ width: seed.width, height: seed.height });
    }
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      // Zero while this project's tab is hidden (`display: none`) — not a real size.
      if (width > 0 && height > 0) {
        setGridSize({ width, height });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Everything a `Pane` takes is kept stable across renders that do not change it, or its memo
  // would be switched off — a focus change, a spinner starting in another pane, a resize of the
  // grid all re-render this component, and none of them should re-render a pane they leave alone.
  const onPresetChangeHere = useCallback(
    (preset: SplitPreset) => onPresetChange(project.id, preset),
    [onPresetChange, project.id]
  );
  const chrome = useMemo<PaneChrome>(
    () => ({ gitOpen, onToggleGit, showProgress: externalBusy, onPresetChange: onPresetChangeHere }),
    [gitOpen, onToggleGit, externalBusy, onPresetChangeHere]
  );
  const onActivate = useCallback(
    (paneId: PaneId, tabId: string) => onActivateTab(project.id, tabId, paneId),
    [onActivateTab, project.id]
  );
  const onFocus = useCallback((paneId: PaneId) => onFocusPane(project.id, paneId), [onFocusPane, project.id]);

  // Left as `over` clears whatever pane it names, and only that one: a stale "left" arriving
  // after the pointer has already crossed into its neighbour must not blank the new one out.
  const onDragOverChange = useCallback((paneId: PaneId, over: boolean) => {
    setDragOverPane((current) => (over ? paneId : current === paneId ? null : current));
  }, []);

  // Each pane's tabs, in the project's own order — by identity where the answer did not change,
  // for the same reason `App` does that for the mark lists it hands down. Keyed on the two
  // fields `paneOf` reads rather than the layout: the focused pane only matters for a tab not in
  // `tabPane` yet (the one render between its push arriving and `normalizeLayout` writing its
  // entry), and a selection change must not hand every pane a fresh list.
  const { tabPane, focusedPane } = layout;
  const paneTabsRef = useRef<Partial<Record<PaneId, TerminalDescriptor[]>>>({});
  const paneTabs = useMemo(() => {
    const next: Partial<Record<PaneId, TerminalDescriptor[]>> = {};
    for (const paneId of PANE_IDS) {
      next[paneId] = sameTabs(
        paneTabsRef.current[paneId],
        tabs.filter((tab) => (tabPane[tab.tabId] ?? focusedPane) === paneId)
      );
    }
    paneTabsRef.current = next;
    return next;
  }, [tabs, tabPane, focusedPane]);

  const renderPane = (paneId: PaneId, size: { width?: number; height?: number }, first: boolean) => (
    <Pane
      key={paneId}
      projectId={project.id}
      paneId={paneId}
      preset={layout.preset}
      tabs={paneTabs[paneId] ?? NO_PANE_TABS}
      activeTabId={layout.activeTab[paneId] ?? null}
      agents={agents}
      visible={visible}
      focused={layout.focusedPane === paneId}
      width={size.width}
      height={size.height}
      onActivate={onActivate}
      onFocus={onFocus}
      markedTabIds={markedTabIds}
      waitingTabIds={waitingTabIds}
      chrome={first ? chrome : undefined}
      dragOver={dragOverPane === paneId}
      onDragOverChange={onDragOverChange}
    />
  );

  // Highlighted only while the dragged tab is over one of the panes this particular divider
  // actually borders — not every divider in the grid, which read as "everything is a target"
  // rather than pointing at the one pane that is.
  const divider = (
    orientation: "vertical" | "horizontal",
    pixels: number,
    min: number,
    minOther: number,
    containerSize: number | null,
    commit: (fraction: number) => void,
    adjacent: PaneId[]
  ) => (
    <Sash
      orientation={orientation}
      size={pixels}
      min={min}
      minOther={minOther}
      // A drag reports itself in pixels — turned back into a fraction of the same room
      // `pixelsFor` measured it against, and through the same bounds, so the two never disagree
      // about what "half" means and a share never gets stored that the room cannot show.
      onResize={(next) => {
        if (containerSize !== null && containerSize > 0) {
          commit(clampPixels(next, min, minOther, containerSize) / containerSize);
        }
      }}
      highlighted={dragOverPane !== null && adjacent.includes(dragOverPane)}
    />
  );

  const renderGrid = () => {
    const width = gridSize?.width ?? null;
    const height = gridSize?.height ?? null;
    switch (layout.preset) {
      case "single":
        return renderPane("a", {}, true);
      case "cols2": {
        const a = pixelsFor(cols2Fraction, MIN_PANE_WIDTH, MIN_PANE_WIDTH, width);
        return (
          <>
            {renderPane("a", { width: a }, true)}
            {divider("vertical", a, MIN_PANE_WIDTH, MIN_PANE_WIDTH, width, setCols2Fraction, ["a", "b"])}
            {renderPane("b", {}, false)}
          </>
        );
      }
      case "cols3": {
        const a = pixelsFor(cols3AFraction, MIN_PANE_WIDTH, MIN_PANE_WIDTH * 2, width);
        // "b"'s own fraction is of whatever is left once "a" has taken its share.
        const remaining = width === null ? null : width - a;
        const b = pixelsFor(cols3BFraction, MIN_PANE_WIDTH, MIN_PANE_WIDTH, remaining);
        return (
          <>
            {renderPane("a", { width: a }, true)}
            {divider("vertical", a, MIN_PANE_WIDTH, MIN_PANE_WIDTH * 2, width, setCols3AFraction, ["a", "b"])}
            {renderPane("b", { width: b }, false)}
            {divider("vertical", b, MIN_PANE_WIDTH, MIN_PANE_WIDTH, remaining, setCols3BFraction, ["b", "c"])}
            {renderPane("c", {}, false)}
          </>
        );
      }
      case "split-right": {
        const a = pixelsFor(splitRightColFraction, MIN_PANE_WIDTH, MIN_PANE_WIDTH, width);
        // The right column takes the grid's full height, so "b" is a fraction of that directly.
        const b = pixelsFor(splitRightRowFraction, MIN_PANE_HEIGHT, MIN_PANE_HEIGHT, height);
        return (
          <>
            {renderPane("a", { width: a }, true)}
            {divider(
              "vertical",
              a,
              MIN_PANE_WIDTH,
              MIN_PANE_WIDTH,
              width,
              setSplitRightColFraction,
              // "a" runs the column's full height, so its right edge borders both of them.
              ["a", "b", "c"]
            )}
            <div className="panes-column fill">
              {renderPane("b", { height: b }, false)}
              {divider("horizontal", b, MIN_PANE_HEIGHT, MIN_PANE_HEIGHT, height, setSplitRightRowFraction, [
                "b",
                "c"
              ])}
              {renderPane("c", {}, false)}
            </div>
          </>
        );
      }
      case "grid2x2": {
        const col = pixelsFor(gridColFraction, MIN_PANE_WIDTH, MIN_PANE_WIDTH, width);
        // Both columns run the grid's full height, so each is a fraction of that directly.
        const left = pixelsFor(gridRowAFraction, MIN_PANE_HEIGHT, MIN_PANE_HEIGHT, height);
        const right = pixelsFor(gridRowBFraction, MIN_PANE_HEIGHT, MIN_PANE_HEIGHT, height);
        return (
          <>
            <div className="panes-column" style={{ width: col }}>
              {renderPane("a", { height: left }, true)}
              {divider("horizontal", left, MIN_PANE_HEIGHT, MIN_PANE_HEIGHT, height, setGridRowAFraction, [
                "a",
                "c"
              ])}
              {renderPane("c", {}, false)}
            </div>
            {divider(
              "vertical",
              col,
              MIN_PANE_WIDTH,
              MIN_PANE_WIDTH,
              width,
              setGridColFraction,
              // The spine between both columns — every pane in the grid touches it on one side.
              ["a", "b", "c", "d"]
            )}
            <div className="panes-column fill">
              {renderPane("b", { height: right }, false)}
              {divider("horizontal", right, MIN_PANE_HEIGHT, MIN_PANE_HEIGHT, height, setGridRowBFraction, [
                "b",
                "d"
              ])}
              {renderPane("d", {}, false)}
            </div>
          </>
        );
      }
    }
  };

  return (
    <div className={`terminals-pane${visible ? "" : " pane-hidden"}`}>
      <div className="panes-grid" ref={gridRef}>
        {renderGrid()}
      </div>
    </div>
  );
});
