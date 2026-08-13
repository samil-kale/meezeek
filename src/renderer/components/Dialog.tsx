import { useEffect, useSyncExternalStore } from "react";

export interface ConfirmOptions {
  title: string;
  /** The question itself, in one line. */
  message: string;
  /** What it means, when that is not obvious from the question. */
  detail?: string;
  /** The button that goes through with it; "Cancel" is always the other one. */
  confirmLabel: string;
  /** An option the question carries along, e.g. "delete it on the remote too". */
  checkboxLabel?: string;
}

export interface ConfirmAnswer {
  confirmed: boolean;
  /** Whether the checkbox was ticked; always false when the question had none. */
  checked: boolean;
}

interface PendingDialog extends ConfirmOptions {
  answer: (answer: ConfirmAnswer) => void;
}

/**
 * Asking the user something, the way `notify` tells them something: one function anything can
 * call, and one component mounted once that draws whatever is pending. Rendered in the window
 * rather than through Electron's `dialog.showMessageBox`, so a question looks like the rest of
 * the app instead of like the OS.
 *
 * Only ask before something that cannot be undone — a question the user answers the same way
 * every time is a question not worth asking.
 */
let pending: PendingDialog | null = null;
const listeners = new Set<() => void>();

function publish(next: PendingDialog | null): void {
  pending = next;
  for (const listener of listeners) {
    listener();
  }
}

export function confirm(options: ConfirmOptions): Promise<ConfirmAnswer> {
  // One at a time: the overlay swallows the clicks that could start a second question, and a
  // stack of them would hide the one that is actually being answered.
  if (pending) {
    return Promise.resolve({ confirmed: false, checked: false });
  }
  return new Promise((resolve) => {
    publish({
      ...options,
      answer: (answer) => {
        publish(null);
        resolve(answer);
      }
    });
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Mounted once, next to `Notices`; draws nothing until something asks. */
export function Dialogs() {
  const dialog = useSyncExternalStore(subscribe, () => pending);

  useEffect(() => {
    if (!dialog) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        // Capture phase and swallowed here, so dismissing the question can't double as an
        // ESC keystroke for the terminal that had focus before it opened.
        event.preventDefault();
        event.stopPropagation();
        dialog.answer({ confirmed: false, checked: false });
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [dialog]);

  if (!dialog) {
    return null;
  }

  return (
    <div className="dialog-overlay">
      {/* A form, so Enter answers from wherever the focus sits — including the checkbox. */}
      <form
        className="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          const checkbox = event.currentTarget.elements.namedItem("dialog-checkbox");
          dialog.answer({ confirmed: true, checked: checkbox instanceof HTMLInputElement && checkbox.checked });
        }}
      >
        <div className="dialog-title">{dialog.title}</div>
        <div className="dialog-body">
          <p className="dialog-message">{dialog.message}</p>
          {dialog.detail && <p className="dialog-detail">{dialog.detail}</p>}
          {dialog.checkboxLabel && (
            <label className="dialog-checkbox">
              <input type="checkbox" name="dialog-checkbox" />
              <span>{dialog.checkboxLabel}</span>
            </label>
          )}
        </div>
        <div className="dialog-buttons">
          <button
            type="button"
            className="button secondary"
            onClick={() => dialog.answer({ confirmed: false, checked: false })}
          >
            Cancel
          </button>
          <button type="submit" className="button" autoFocus>
            {dialog.confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
