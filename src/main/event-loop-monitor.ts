import * as fs from "node:fs";
import * as util from "node:util";

/**
 * What switches this on: `NODE_DEBUG=meeseek-perf npm start`. Node's own mechanism for a
 * diagnostic that is off in normal runs — `util.debuglog` hands back a no-op until its section
 * is named, and `enabled` says so before anything has been set up.
 */
const DEBUG_SECTION = "meeseek-perf";
/**
 * How often the loop is sampled. A keystroke on its way to a pty waits in the same queue as
 * this timer, so how late the timer runs is how late the keystroke would be.
 */
const SAMPLE_MS = 20;
/** Below this, a late sample is scheduling noise rather than something a typist could feel. */
const STALL_MS = 50;
/** A stall this long is worth a line of its own, not just a tally. */
const LOUD_STALL_MS = 200;
/** One summary per interval, and only when there was something to report. */
const REPORT_MS = 60_000;

/**
 * The main process's continuous work, in the places it happens. Nothing here is a guess about
 * cost — the point is to find out which of them the loop is actually sitting in.
 */
export type Activity = "output" | "input" | "sse" | "reconcile" | "git";

const counts = new Map<Activity, number>();
/**
 * What ran last. A stall is only noticed by the sample that follows it, so whatever was
 * running just before is the likeliest thing to have blocked it.
 */
let lastActivity: Activity | undefined;

export function countActivity(activity: Activity): void {
  counts.set(activity, (counts.get(activity) ?? 0) + 1);
  lastActivity = activity;
}

function tally(): string {
  const entries = [...counts].sort((a, b) => b[1] - a[1]);
  return entries.length === 0 ? "nothing counted" : entries.map(([activity, n]) => `${activity} ${n}`).join(", ");
}

/**
 * Records how long the main process's event loop is blocked and what was running when it was.
 * Writes to a file rather than only to the console: the app is normally started from a
 * shortcut, where stdout goes nowhere.
 *
 * Does nothing unless `NODE_DEBUG` names this monitor: it is what the git and terminal layers
 * were measured with rather than something a normal run needs, and a sample every 20ms for the
 * lifetime of the window is not worth paying while nothing is being investigated. Everything it
 * reads is still collected — `countActivity` stays where it is, so the tally is right again the
 * moment it is switched back on.
 */
export function startEventLoopMonitor(logFile: string): void {
  if (!util.debuglog(DEBUG_SECTION).enabled) {
    return;
  }
  try {
    fs.writeFileSync(logFile, `# meeseek event loop, from ${new Date().toISOString()}\n`);
  } catch (error) {
    console.error("[meeseek] could not open the event loop log:", error);
    return;
  }
  const append = (line: string): void => {
    console.log(`[meeseek] ${line}`);
    fs.appendFile(logFile, `${new Date().toISOString().slice(11, 23)} ${line}\n`, () => undefined);
  };

  let expected = Date.now() + SAMPLE_MS;
  let reportAt = Date.now() + REPORT_MS;
  let stalls = 0;
  let stalledMs = 0;
  let worst = 0;
  let worstAfter: Activity | undefined;

  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - expected;
    expected = now + SAMPLE_MS;

    if (lag >= STALL_MS) {
      stalls += 1;
      stalledMs += lag;
      if (lag > worst) {
        worst = lag;
        worstAfter = lastActivity;
      }
      if (lag >= LOUD_STALL_MS) {
        append(`loop blocked ${lag}ms after ${lastActivity ?? "nothing"} | ${tally()}`);
      }
    }

    if (now >= reportAt) {
      reportAt = now + REPORT_MS;
      if (stalls > 0) {
        append(
          `loop: ${stalls} stalls in ${REPORT_MS / 1000}s, ${stalledMs}ms lost,` +
            ` worst ${worst}ms after ${worstAfter ?? "nothing"} | ${tally()}`
        );
      }
      stalls = 0;
      stalledMs = 0;
      worst = 0;
      worstAfter = undefined;
      counts.clear();
    }
  }, SAMPLE_MS);
  // Diagnostics must not be the reason the process stays alive.
  timer.unref();
}
