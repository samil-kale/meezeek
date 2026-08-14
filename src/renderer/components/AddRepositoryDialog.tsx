import { useEffect, useRef, useState } from "react";
import type { Project, ProviderAccount, ProviderId, RemoteRepository } from "../../shared/types";
import { confirm } from "./Dialog";
import { CloseIcon, PlusIcon, SpinnerIcon } from "./icons";
import { notify } from "./Notices";

/**
 * The four ways a repository comes in: picked off an account's list, cloned from a url, added
 * from the filesystem, or created empty. One dialog with a tab per way, SourceTree's layout in
 * this app's clothes.
 *
 * Not part of Dialog.tsx: that file puts one question with two buttons, and this is a small
 * surface with modes. Like DiffDialog it is its own overlay over the whole window.
 */
type Mode = "remote" | "clone" | "add" | "create";

const MODES: { id: Mode; label: string }[] = [
  { id: "remote", label: "Remote" },
  { id: "clone", label: "Clone" },
  { id: "add", label: "Add" },
  { id: "create", label: "Create" }
];

const PROVIDER_LABEL: Record<ProviderId, string> = { github: "GitHub", gitlab: "GitLab" };
const DEFAULT_HOST: Record<ProviderId, string> = { github: "github.com", gitlab: "gitlab.com" };

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
    const picked = await window.meezeek.projects.pickDirectory(pickTitle);
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

interface AccountFormProps {
  onAdded: (account: ProviderAccount) => void;
}

/** Provider, host and token; the token is validated on the way in and never shown again. */
function AccountForm({ onAdded }: AccountFormProps) {
  const [provider, setProvider] = useState<ProviderId>("github");
  const [host, setHost] = useState(DEFAULT_HOST.github);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  /** Switching the provider replaces the host only while it is still the other one's default. */
  const pick = (next: ProviderId): void => {
    setProvider(next);
    setHost((current) =>
      current === "" || current === DEFAULT_HOST.github || current === DEFAULT_HOST.gitlab
        ? DEFAULT_HOST[next]
        : current
    );
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await window.meezeek.providers.addAccount(provider, host.trim(), token.trim());
      if (result.account) {
        onAdded(result.account);
      } else {
        notify("error", result.error ?? "The account could not be added");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="account-form">
      <div className="dialog-field">
        <span>Provider</span>
        <div className="dialog-field-row">
          {(Object.keys(PROVIDER_LABEL) as ProviderId[]).map((id) => (
            <button
              key={id}
              type="button"
              className={provider === id ? "button" : "button secondary"}
              onClick={() => pick(id)}
            >
              {PROVIDER_LABEL[id]}
            </button>
          ))}
        </div>
      </div>
      <label className="dialog-field">
        <span>Host</span>
        <input type="text" value={host} onChange={(event) => setHost(event.target.value)} />
      </label>
      <label className="dialog-field">
        <span>Personal access token</span>
        <input type="password" value={token} onChange={(event) => setToken(event.target.value)} />
      </label>
      {/* Its own row rather than the dialog's: the dialog's Cancel closes the whole thing,
          while leaving this form is done by clicking an account on the left. */}
      <div className="dialog-buttons">
        <button
          type="button"
          className="button"
          disabled={host.trim() === "" || token.trim() === "" || busy}
          onClick={() => void submit()}
        >
          {busy && <SpinnerIcon className="spinning" />}
          <span>Add account</span>
        </button>
      </div>
    </div>
  );
}

interface RemoteTabProps {
  /** Jumps to the clone tab with the repository's url, name and account filled in. */
  onClone: (repo: RemoteRepository, accountId: string) => void;
}

function RemoteTab({ onClone }: RemoteTabProps) {
  /** null while the stored accounts are still being asked for. */
  const [accounts, setAccounts] = useState<ProviderAccount[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Loaded lists by account, for the lifetime of the dialog. */
  const [repos, setRepos] = useState<Record<string, RemoteRepository[]>>({});
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void window.meezeek.providers.accounts().then((list) => {
      setAccounts(list);
      setSelectedId(list[0]?.id ?? null);
      // Straight into the form when there is nothing yet — it is the only thing to do here.
      setAdding(list.length === 0);
    });
  }, []);

  useEffect(() => {
    if (selectedId === null || repos[selectedId]) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    void window.meezeek.providers.repos(selectedId).then((result) => {
      if (cancelled) {
        return;
      }
      setLoading(false);
      const list = result.repos;
      if (list) {
        setRepos((current) => ({ ...current, [selectedId]: list }));
      } else {
        notify("error", result.error ?? "The repositories could not be listed");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, repos]);

  const accountAdded = (account: ProviderAccount): void => {
    // Replacing, not just appending: entering a fresh token answers with the same account id.
    setAccounts((current) => [
      ...(current ?? []).filter((entry) => entry.id !== account.id),
      account
    ]);
    // A re-entered token may reach further than the old one did — the cached list is stale.
    setRepos((current) => {
      const next = { ...current };
      delete next[account.id];
      return next;
    });
    setSelectedId(account.id);
    setAdding(false);
  };

  const removeAccount = async (account: ProviderAccount): Promise<void> => {
    const answer = await confirm({
      title: "Remove account",
      message: `Remove ${account.user} on ${account.host}?`,
      detail: "The stored token is deleted with it.",
      confirmLabel: "Remove"
    });
    if (!answer.confirmed) {
      return;
    }
    await window.meezeek.providers.removeAccount(account.id);
    const remaining = (accounts ?? []).filter((entry) => entry.id !== account.id);
    setAccounts(remaining);
    setSelectedId((current) => (current === account.id ? (remaining[0]?.id ?? null) : current));
  };

  const list = selectedId !== null ? repos[selectedId] : undefined;
  const query = filter.trim().toLowerCase();
  const filtered = (list ?? []).filter((repo) => repo.fullName.toLowerCase().includes(query));

  return (
    <div className="remote-tab">
      <div className="remote-accounts">
        {(accounts ?? []).map((account) => (
          <div
            key={account.id}
            className={account.id === selectedId && !adding ? "remote-account active" : "remote-account"}
            onClick={() => {
              setSelectedId(account.id);
              setAdding(false);
            }}
          >
            <div className="remote-account-label">
              <span className="remote-account-user">{account.user}</span>
              <span className="remote-account-host">
                {PROVIDER_LABEL[account.provider]} · {account.host}
              </span>
            </div>
            <button
              className="icon-button"
              title="Remove account"
              onClick={(event) => {
                event.stopPropagation();
                void removeAccount(account);
              }}
            >
              <CloseIcon />
            </button>
          </div>
        ))}
        <button type="button" className="remote-add-account" onClick={() => setAdding(true)}>
          <PlusIcon />
          <span>Add account...</span>
        </button>
      </div>
      <div className="remote-main">
        {adding ? (
          <AccountForm onAdded={accountAdded} />
        ) : selectedId === null ? (
          <div className="placeholder">No account yet — add one to browse its repositories.</div>
        ) : (
          <>
            <input
              type="text"
              className="remote-filter"
              placeholder="Search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <div className="remote-repos">
              {loading && (
                <div className="remote-loading">
                  <SpinnerIcon className="spinning" />
                </div>
              )}
              {!loading &&
                filtered.map((repo) => (
                  <div className="remote-repo" key={repo.fullName}>
                    <span className="remote-repo-name">{repo.fullName}</span>
                    {repo.private && <span className="remote-repo-private">Private</span>}
                    <button
                      type="button"
                      className="button secondary remote-repo-clone"
                      onClick={() => onClone(repo, selectedId)}
                    >
                      Clone
                    </button>
                  </div>
                ))}
              {!loading && list && filtered.length === 0 && <div className="placeholder">No repositories.</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface AddRepositoryDialogProps {
  onAdded: (project: Project) => void;
  onClose: () => void;
}

export function AddRepositoryDialog({ onAdded, onClose }: AddRepositoryDialogProps) {
  const [mode, setMode] = useState<Mode>("remote");
  const [url, setUrl] = useState("");
  /** Where the new folder goes (clone and create); the folder that already exists (add). */
  const [directory, setDirectory] = useState("");
  /** null follows the url; a string is the user's own and stays. */
  const [name, setName] = useState<string | null>(null);
  /** The account whose token authenticates the clone — set by the remote tab's rows only. */
  const [accountId, setAccountId] = useState<string | null>(null);
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
        : mode === "create"
          ? directory.trim() !== "" && folderName.trim() !== ""
          : false;

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      if (mode === "add") {
        onAdded(await window.meezeek.projects.open(directory.trim()));
        onClose();
        return;
      }
      const result =
        mode === "clone"
          ? await window.meezeek.projects.clone(
              url.trim(),
              directory.trim(),
              folderName.trim(),
              accountId ?? undefined
            )
          : await window.meezeek.projects.create(directory.trim(), folderName.trim());
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

  /** A remote row's Clone: the clone tab, filled in, with the account's token along. */
  const cloneFromRemote = (repo: RemoteRepository, fromAccountId: string): void => {
    setUrl(repo.cloneUrl);
    setName(repo.name);
    setAccountId(fromAccountId);
    setMode("clone");
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
          {mode === "remote" && <RemoteTab onClone={cloneFromRemote} />}
          {mode === "clone" && (
            <>
              <label className="dialog-field">
                <span>Repository URL</span>
                <input
                  type="text"
                  value={url}
                  placeholder="https://github.com/owner/repository.git"
                  onChange={(event) => {
                    setUrl(event.target.value);
                    // Edited by hand, so the account the remote tab picked no longer applies —
                    // its token must not be offered to whatever host this now names.
                    setAccountId(null);
                  }}
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
          {mode !== "remote" && (
            <button type="submit" className="button" disabled={!ready || busy}>
              {busy && <SpinnerIcon className="spinning" />}
              <span>{MODES.find((entry) => entry.id === mode)?.label}</span>
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
