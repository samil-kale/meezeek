import { useSyncExternalStore } from "react";
import type { NoticeSeverity } from "../../shared/types";
import { SeverityIcon } from "./icons";

/** Long enough to read a line, short enough not to sit in the way. VS Code's own is similar. */
const INFO_DISMISS_MS = 5000;

interface ShownNotice {
  id: number;
  severity: NoticeSeverity;
  message: string;
}

/**
 * Everything the user is told goes through here — there is no second way to say something in
 * this app, and views do not keep messages of their own. A plain function rather than a hook
 * or a prop, the way VS Code's `window.showErrorMessage` is: whatever fails, wherever, can
 * report it without a callback having been threaded to it first.
 */
let shown: ShownNotice[] = [];
const listeners = new Set<() => void>();
let nextId = 0;

function publish(next: ShownNotice[]): void {
  shown = next;
  for (const listener of listeners) {
    listener();
  }
}

export function notify(severity: NoticeSeverity, message: string): void {
  const id = ++nextId;
  // A failure that repeats (a checkout retried on the same dirty tree, say) says nothing new
  // the second time — better one message standing than a wall of identical ones.
  if (shown.some((notice) => notice.message === message && notice.severity === severity)) {
    return;
  }
  publish([...shown, { id, severity, message }]);
  if (severity === "info") {
    setTimeout(() => dismissNotice(id), INFO_DISMISS_MS);
  }
}

export function dismissNotice(id: number): void {
  publish(shown.filter((notice) => notice.id !== id));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stacked above the branch bar, newest at the bottom, each dismissed by clicking it. */
export function Notices() {
  const notices = useSyncExternalStore(subscribe, () => shown);
  if (notices.length === 0) {
    return null;
  }
  return (
    <div className="notices">
      {notices.map((notice) => (
        <button
          key={notice.id}
          className={`notice ${notice.severity}`}
          onClick={() => dismissNotice(notice.id)}
          title="Dismiss"
        >
          <SeverityIcon className="notice-icon" severity={notice.severity} />
          <span className="notice-message">{notice.message}</span>
        </button>
      ))}
    </div>
  );
}
