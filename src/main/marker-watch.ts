import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Where a hook drops its markers, and where meezeek watches for them, shared by every agent
 * whose lifecycle signals arrive as hook-written files rather than an event stream: three kinds,
 * `busy` from a prompt-submitted hook and `finished` from a turn-ended hook, either end of a
 * turn, plus `waiting` from an approval/question hook for a turn that stopped part-way on a
 * question. A marker's *filename* is the whole message — nothing is read out of a file, so a
 * reader never races a half-written one, which every other file shared with another process here
 * has to be written around.
 */
export type Marker = "busy" | "finished" | "waiting";

/**
 * How often the marker directories are swept regardless of the watcher — see watchMarkers for
 * what this is a net under. Two seconds: a spinner that stops a moment late reads as the agent
 * finishing, while one that never stops reads as a broken app.
 */
const MARKER_SWEEP_MS = 2000;

export function markerDir(storageDir: string, kind: Marker): string {
  return path.join(storageDir, kind);
}

/**
 * The meezeek half of a hook-driven agent's markers: reports every session marked with `kind`
 * and takes the marker away again. From then on the state lives in the tab, so a file left lying
 * around would report the same turn again on the next start.
 *
 * Whatever is already in there at startup is therefore deleted *without* being reported: those
 * turns ended before this window existed, and every tab is freshly opened at that point.
 */
export function watchMarkers(
  storageDir: string,
  kind: Marker,
  onMarker: (sessionId: string) => void
): () => void {
  const dir = markerDir(storageDir, kind);
  let stopped = false;

  const drain = async (report: boolean): Promise<void> => {
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      // The hook has never run here, or its setup failed — nothing to report either way.
      return;
    }
    for (const name of names) {
      try {
        // Not `force`: a marker gone by now raises ENOENT here, and an unlink that did not
        // happen is not a turn to report.
        await fs.promises.unlink(path.join(dir, name));
      } catch {
        continue;
      }
      if (report && !stopped) {
        onMarker(name);
      }
    }
  };

  // One drain at a time, in order: the startup drain's own unlinks fire the watcher, and a
  // drain started by that would race it for the next stale marker — and report it.
  let draining = Promise.resolve();
  const queueDrain = (report: boolean): void => {
    draining = draining.then(() => drain(report)).catch(() => undefined);
  };
  queueDrain(false);
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(dir, () => queueDrain(true));
  } catch (error) {
    console.error(`[meezeek] could not watch ${kind} markers in ${dir}:`, error);
  }
  // The watcher alone is not enough, and this was measured rather than feared: a marker sat in
  // `finished/` for seven minutes while the process that should have picked it up was running
  // and healthy — the next write drained it along with the fresh one. On win32 fs.watch can
  // fire before the new name is in the directory listing, and nothing fires a second time, so
  // one lost event strands a turn *forever*: the spinner never stops and the mark never lands.
  // A readdir on an all-but-always-empty directory is a syscall, not a process, so the net
  // costs nothing; the watcher stays because it is what makes the common case immediate.
  const sweep = setInterval(() => queueDrain(true), MARKER_SWEEP_MS);
  return () => {
    stopped = true;
    clearInterval(sweep);
    watcher?.close();
  };
}
