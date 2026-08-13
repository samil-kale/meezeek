import { useCallback, useState } from "react";
import type { Notice, NoticeSeverity } from "../../shared/types";
import { SeverityIcon } from "./icons";

/** Long enough to read a line, short enough not to sit in the way. VS Code's own is similar. */
const INFO_DISMISS_MS = 5000;

interface ShownNotice extends Notice {
  id: number;
}

let nextId = 0;

/**
 * The one place anything transient is said to the user. Everything that used to set a single
 * error string goes through here instead, so a second message no longer replaces the first.
 */
export function useNotices(): {
  notices: ShownNotice[];
  notify: (severity: NoticeSeverity, message: string) => void;
  dismiss: (id: number) => void;
} {
  const [notices, setNotices] = useState<ShownNotice[]>([]);

  const dismiss = useCallback((id: number) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  const notify = useCallback(
    (severity: NoticeSeverity, message: string) => {
      const id = ++nextId;
      setNotices((current) =>
        // A failure that repeats (a checkout retried on the same dirty tree, say) says nothing
        // new the second time — better one message standing than a wall of identical ones.
        current.some((notice) => notice.message === message && notice.severity === severity)
          ? current
          : [...current, { id, severity, message }]
      );
      if (severity === "info") {
        setTimeout(() => dismiss(id), INFO_DISMISS_MS);
      }
    },
    [dismiss]
  );

  return { notices, notify, dismiss };
}

/** Stacked above the branch bar, newest at the bottom, each dismissed by clicking it. */
export function Notices({ notices, onDismiss }: { notices: ShownNotice[]; onDismiss: (id: number) => void }) {
  if (notices.length === 0) {
    return null;
  }
  return (
    <div className="notices">
      {notices.map((notice) => (
        <button
          key={notice.id}
          className={`notice ${notice.severity}`}
          onClick={() => onDismiss(notice.id)}
          title="Dismiss"
        >
          <SeverityIcon className="notice-icon" severity={notice.severity} />
          <span className="notice-message">{notice.message}</span>
        </button>
      ))}
    </div>
  );
}
