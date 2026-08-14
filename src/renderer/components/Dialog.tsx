import { useEffect, useRef, useState, useSyncExternalStore } from "react";

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

export interface PromptOptions {
  title: string;
  /** What the field holds, above it. */
  label: string;
  /** What it is for, when the label alone does not say — the branch a new one starts from. */
  detail?: string;
  /** What the field starts out with, selected so typing replaces it. */
  value: string;
  confirmLabel: string;
  maxLength?: number;
  /**
   * Further fields, for a question whose optional parts sit next to its answer — a saved
   * command's name, folder and environment next to it. Empty is a valid answer for each of
   * them; the answer's own field is the one that must be filled in.
   */
  extras?: { label: string; placeholder?: string; value?: string }[];
  /**
   * Where the answer's own field sits among the extras, first by default. A saved command's
   * name is the one that goes above it: it is what the row will be called, and a label reads
   * as the heading of what it names rather than as a note under it.
   */
  valueIndex?: number;
}

export interface PromptAnswer {
  value: string;
  /** The extra fields' values in the order they were declared, "" where one was left blank. */
  extras: string[];
}

type Pending =
  | ({ kind: "confirm"; answer: (answer: ConfirmAnswer) => void } & ConfirmOptions)
  | ({ kind: "prompt"; answer: (answer: PromptAnswer | null) => void } & PromptOptions);

/**
 * Asking the user something, the way `notify` tells them something: one function anything can
 * call, and one component mounted once that draws whatever is pending. Rendered in the window
 * rather than through Electron's `dialog.showMessageBox`, so a question looks like the rest of
 * the app instead of like the OS.
 *
 * `confirm` is for something that cannot be undone — a question the user answers the same way
 * every time is one not worth asking. `prompt` is for a name, and is where every rename in the
 * app happens.
 */
let pending: Pending | null = null;
const listeners = new Set<() => void>();

function publish(next: Pending | null): void {
  pending = next;
  for (const listener of listeners) {
    listener();
  }
}

/** One at a time: the overlay swallows the clicks that could start a second question. */
function ask<T>(build: (answer: (value: T) => void) => Pending, cancelled: T): Promise<T> {
  if (pending) {
    return Promise.resolve(cancelled);
  }
  return new Promise((resolve) => {
    // Answered once. A second call — an Escape that lands in the moment between the click and
    // the listener coming down — would otherwise clear whatever dialog is up by then, which
    // may already be the next one.
    let answered = false;
    publish(
      build((value) => {
        if (answered) {
          return;
        }
        answered = true;
        publish(null);
        resolve(value);
      })
    );
  });
}

export function confirm(options: ConfirmOptions): Promise<ConfirmAnswer> {
  return ask<ConfirmAnswer>(
    (answer) => ({ kind: "confirm", ...options, answer }),
    { confirmed: false, checked: false }
  );
}

/** Resolves to what the user typed, or null when they cancelled. */
export function prompt(options: PromptOptions): Promise<PromptAnswer | null> {
  return ask<PromptAnswer | null>((answer) => ({ kind: "prompt", ...options, answer }), null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

interface FrameProps {
  title: string;
  confirmLabel: string;
  /** Nothing to go through with yet — an empty name, say. */
  disabled?: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}

function Frame({ title, confirmLabel, disabled, onSubmit, onCancel, children }: FrameProps) {
  return (
    <div className="dialog-overlay">
      {/* A form, so Enter answers from wherever the focus sits — the field or the checkbox. */}
      <form
        className="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled) {
            onSubmit();
          }
        }}
      >
        <div className="dialog-title">{title}</div>
        <div className="dialog-body">{children}</div>
        <div className="dialog-buttons">
          <button type="button" className="button secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={disabled}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

function ConfirmDialog({ dialog }: { dialog: Extract<Pending, { kind: "confirm" }> }) {
  const [checked, setChecked] = useState(false);
  return (
    <Frame
      title={dialog.title}
      confirmLabel={dialog.confirmLabel}
      onSubmit={() => dialog.answer({ confirmed: true, checked })}
      onCancel={() => dialog.answer({ confirmed: false, checked: false })}
    >
      <p className="dialog-message">{dialog.message}</p>
      {dialog.detail && <p className="dialog-detail">{dialog.detail}</p>}
      {dialog.checkboxLabel && (
        <label className="dialog-checkbox">
          <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
          <span>{dialog.checkboxLabel}</span>
        </label>
      )}
    </Frame>
  );
}

function PromptDialog({ dialog }: { dialog: Extract<Pending, { kind: "prompt" }> }) {
  const [value, setValue] = useState(dialog.value);
  const [extras, setExtras] = useState<string[]>(() => (dialog.extras ?? []).map((field) => field.value ?? ""));
  const field = useRef<HTMLInputElement>(null);

  // The focus has to land in the first field, not on a button: a rename is opened to type in.
  // Once, on the way in — selecting on every render would swallow each keystroke after it.
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  // Optional by construction: only the answer's own field can hold the dialog back, wherever
  // `valueIndex` puts it among them.
  const fields = (dialog.extras ?? []).map((entry, index) => (
    <label key={entry.label} className="dialog-field">
      <span>{entry.label}</span>
      <input
        type="text"
        value={extras[index] ?? ""}
        placeholder={entry.placeholder}
        onChange={(event) =>
          setExtras((current) => current.map((held, position) => (position === index ? event.target.value : held)))
        }
      />
    </label>
  ));
  fields.splice(
    dialog.valueIndex ?? 0,
    0,
    <label key="value" className="dialog-field">
      <span>{dialog.label}</span>
      <input
        type="text"
        value={value}
        maxLength={dialog.maxLength}
        onChange={(event) => setValue(event.target.value)}
        ref={field}
      />
    </label>
  );

  return (
    <Frame
      title={dialog.title}
      confirmLabel={dialog.confirmLabel}
      disabled={value.trim().length === 0}
      onSubmit={() => dialog.answer({ value: value.trim(), extras: extras.map((entry) => entry.trim()) })}
      onCancel={() => dialog.answer(null)}
    >
      {fields}
      {dialog.detail && <p className="dialog-detail">{dialog.detail}</p>}
    </Frame>
  );
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
        if (dialog.kind === "confirm") {
          dialog.answer({ confirmed: false, checked: false });
        } else {
          dialog.answer(null);
        }
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [dialog]);

  if (!dialog) {
    return null;
  }
  return dialog.kind === "confirm" ? <ConfirmDialog dialog={dialog} /> : <PromptDialog dialog={dialog} />;
}
