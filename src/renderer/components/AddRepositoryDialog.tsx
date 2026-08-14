import { useEffect, useRef, useState } from "react";
import type { Project } from "../../shared/types";
import { SpinnerIcon } from "./icons";
import { notify } from "./Notices";

/**
 * The three ways a repository comes in: cloned from a url, added from the filesystem, or
 * created empty. One dialog with a tab per way, SourceTree's layout in this app's clothes.
 * A fourth tab — browsing an account's repositories — waits on the providers.
 *
 * Not part of Dialog.tsx: that file puts one question with two buttons, and this is a small
 * surface with modes. Like DiffDialog it is its own overlay over the whole window.
 */
type Mode = "clone" | "add" | "create";

const MODES: { id: Mode; label: string }[] = [
  { id: "clone", label: "Clone" },
  { id: "add", label: "Add" },
  { id: "create", label: "Create" }
];

/** The folder a url clones into: git's own rule, the last path segment without ".git". */
function cloneFolder(url: string): string {
  const segment = url.replace(/[/\\]+$/, "").split(/[/\\:]/).pop() ?? "";
  return segment.replace(/\.git$/, "");
}

interface PathFieldProps {
  label: string;
  value: string;
  /** The native picker's window title, which is all the picker says about why it is open. */
  pickTitle: string;
  onChange: (value: string) => void;
  /** Where the dialog's focus effect reaches the input, when this is a mode's first field. */
  inputRef?: React.Ref<HTMLInputElement>;
}

/** A folder path, typed or picked — the Browse button fills the same field. */
function PathField({ label, value, pickTitle, onChange, inputRef }: PathFieldProps) {
  const browse = async (): Promise<void> => {
    const picked = await window.meeseek.projects.pickDirectory(pickTitle);
    if (picked) {
      onChange(picked);
    }
  };
  return (
    <label className="dialog-field">
      <span>{label}</span>
      <div className="dialog-field-row">
        <input type="text" value={value} onChange={(event) => onChange(event.target.value)} ref={inputRef} />
        <button type="button" className="button secondary" onClick={() => void browse()}>
          Browse...
        </button>
      </div>
    </label>
  );
}

interface AddRepositoryDialogProps {
  onAdded: (project: Project) => void;
  onClose: () => void;
}

export function AddRepositoryDialog({ onAdded, onClose }: AddRepositoryDialogProps) {
  const [mode, setMode] = useState<Mode>("clone");
  const [url, setUrl] = useState("");
  /** Where the new folder goes (clone and create); the folder that already exists (add). */
  const [directory, setDirectory] = useState("");
  /** null follows the url; a string is the user's own and stays. */
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);

  // The focus lands in the first field of the mode on screen — the dialog is opened to type in.
  useEffect(() => {
    firstField.current?.focus();
  }, [mode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        // Capture phase and swallowed here, so closing this can't double as an ESC keystroke
        // for the terminal that had focus before it opened.
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const folderName = name ?? cloneFolder(url);
  const ready =
    mode === "clone"
      ? url.trim() !== "" && directory.trim() !== "" && folderName.trim() !== ""
      : mode === "add"
        ? directory.trim() !== ""
        : directory.trim() !== "" && folderName.trim() !== "";

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      if (mode === "add") {
        onAdded(await window.meeseek.projects.open(directory.trim()));
        onClose();
        return;
      }
      const result =
        mode === "clone"
          ? await window.meeseek.projects.clone(url.trim(), directory.trim(), folderName.trim())
          : await window.meeseek.projects.create(directory.trim(), folderName.trim());
      if (result.project) {
        onAdded(result.project);
        onClose();
      } else {
        notify("error", result.error ?? "The repository could not be added");
      }
    } finally {
      setBusy(false);
    }
  };

  // Fields keep what was typed across a tab switch, so comparing two tabs costs nothing —
  // only the name resets with the mode, since only clone derives it.
  const switchMode = (next: Mode): void => {
    setMode(next);
    setName(null);
  };

  return (
    <div className="dialog-overlay">
      <form
        className="dialog add-repository"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !busy) {
            void submit();
          }
        }}
      >
        <div className="add-repository-tabs">
          {MODES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={mode === entry.id ? "add-repository-tab active" : "add-repository-tab"}
              onClick={() => switchMode(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="dialog-body">
          {mode === "clone" && (
            <>
              <label className="dialog-field">
                <span>Repository URL</span>
                <input
                  type="text"
                  value={url}
                  placeholder="https://github.com/owner/repository.git"
                  onChange={(event) => setUrl(event.target.value)}
                  ref={firstField}
                />
              </label>
              <PathField label="Destination" value={directory} pickTitle="Clone into" onChange={setDirectory} />
              <label className="dialog-field">
                <span>Folder name</span>
                <input type="text" value={folderName} onChange={(event) => setName(event.target.value)} />
              </label>
            </>
          )}
          {mode === "add" && (
            <PathField
              label="Repository path"
              value={directory}
              pickTitle="Add repository"
              onChange={setDirectory}
              inputRef={firstField}
            />
          )}
          {mode === "create" && (
            <>
              <PathField
                label="Destination"
                value={directory}
                pickTitle="Create in"
                onChange={setDirectory}
                inputRef={firstField}
              />
              <label className="dialog-field">
                <span>Folder name</span>
                <input type="text" value={folderName} onChange={(event) => setName(event.target.value)} />
              </label>
            </>
          )}
        </div>
        <div className="dialog-buttons">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={!ready || busy}>
            {busy && <SpinnerIcon className="spinning" />}
            <span>{MODES.find((entry) => entry.id === mode)?.label}</span>
          </button>
        </div>
      </form>
    </div>
  );
}
