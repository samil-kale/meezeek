import { useEffect, useState } from "react";
import type { AppInfo, AppSettings, FileSortOrder, FileViewSettings, NotificationSettings, Project } from "../../shared/types";
import { ChevronIcon } from "./icons";
import { KEYBINDING_PRESETS } from "../keybinding-presets";
import { notify } from "./Notices";
import { SHORTCUTS, shortcutLabel } from "../shortcuts";
import { useEscape } from "./use-escape";

interface SettingsDialogProps {
  /** Whose tet.json the Editor tab's FILES view settings read and write; null hides that part. */
  activeProject: Project | null;
  onClose: () => void;
}

type SettingsTab = "notifications" | "shortcuts" | "editor" | "info";

/** The dialog's panes, in the order they are worth opening. */
const TABS: { id: SettingsTab; label: string }[] = [
  { id: "notifications", label: "Notifications" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "editor", label: "Files" },
  { id: "info", label: "Info" }
];

/** One switch per line, in the order they matter: the turn ended, it is stuck, it is idle. */
const SWITCHES: { key: keyof NotificationSettings; label: string }[] = [
  { key: "finished", label: "Finished — the turn ended and nothing it started is still running" },
  { key: "needsYou", label: "Action needed — waiting on a permission prompt or a question" },
  { key: "idleReminder", label: "Still waiting — no new prompt for a while" }
];

/**
 * The Editor tab's sort-order picker. `foldersNestsFiles` is left out on purpose: the FILES
 * tree has no file nesting to turn off, so it sorts identically to `default` and would be a
 * second, indistinguishable entry — a hand-written tet.json can still hold it.
 */
const SORT_ORDERS: { id: FileSortOrder; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "mixed", label: "Mixed" },
  { id: "filesFirst", label: "Files First" },
  { id: "type", label: "Type" },
  { id: "modified", label: "Modified" }
];

/** The Info tab's rows, in the order the versions nest: tet, then what it runs on. */
const INFO_ROWS: { key: keyof AppInfo; label: string }[] = [
  { key: "version", label: "TET" },
  { key: "electron", label: "Electron" },
  { key: "chromium", label: "Chromium" },
  { key: "node", label: "Node" },
  { key: "os", label: "Platform" }
];

/**
 * Everything tet keeps about itself rather than about one repository. Opened from the title
 * bar, over the whole window like the diff.
 *
 * Not part of Dialog.tsx: that file puts *questions* and is built around a form with two
 * buttons. This asks nothing — every switch applies the moment it is flipped, the way VS Code's
 * own settings do, so there is nothing to confirm and nothing to take back.
 */
export function SettingsDialog({ activeProject, onClose }: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>("notifications");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [fileView, setFileView] = useState<FileViewSettings | null>(null);

  useEffect(() => {
    void window.tet.settings.get().then(setSettings);
    // Asked alongside the settings rather than when the Info tab is first opened: none of it can
    // change while the process runs, so there is nothing a later read would catch.
    void window.tet.app.info().then(setInfo);
  }, []);

  // The active project's FILES view settings — read on open and again whenever its tet.json
  // changes underneath, whoever wrote it (the tree's own menu, an editor, an agent).
  useEffect(() => {
    if (!activeProject) {
      setFileView(null);
      return;
    }
    const projectId = activeProject.id;
    void window.tet.repository.fileView(projectId).then(setFileView);
    return window.tet.commands.onChanged((payload) => {
      if (payload.projectId === projectId) {
        void window.tet.repository.fileView(projectId).then(setFileView);
      }
    });
  }, [activeProject]);

  useEscape(onClose);

  const flip = (key: keyof NotificationSettings, value: boolean): void => {
    if (!settings) {
      return;
    }
    const next: AppSettings = { ...settings, notifications: { ...settings.notifications, [key]: value } };
    setSettings(next);
    void window.tet.settings.save(next);
  };

  const applyPreset = (id: string): void => {
    if (!settings) {
      return;
    }
    const next: AppSettings = { ...settings, editorKeybindingPreset: id };
    setSettings(next);
    void window.tet.settings.save(next);
  };

  const setExcludeGitIgnore = (value: boolean): void => {
    if (!activeProject || !fileView) {
      return;
    }
    setFileView({ ...fileView, excludeGitIgnore: value });
    void window.tet.repository.setExcludeGitIgnore(activeProject.id, value).then((result) => {
      if (!result.ok) {
        notify("error", result.error ?? "Could not update tet.json");
      }
    });
  };

  const setCompactFolders = (value: boolean): void => {
    if (!activeProject || !fileView) {
      return;
    }
    setFileView({ ...fileView, compactFolders: value });
    void window.tet.repository.setCompactFolders(activeProject.id, value).then((result) => {
      if (!result.ok) {
        notify("error", result.error ?? "Could not update tet.json");
      }
    });
  };

  const setSortOrder = (value: FileSortOrder): void => {
    if (!activeProject || !fileView) {
      return;
    }
    setFileView({ ...fileView, sortOrder: value });
    void window.tet.repository.setSortOrder(activeProject.id, value).then((result) => {
      if (!result.ok) {
        notify("error", result.error ?? "Could not update tet.json");
      }
    });
  };

  return (
    <div className="dialog-overlay">
      <div className="dialog wide settings-dialog">
        {/* The tabs head the dialog instead of a title, as in the add-repository dialog: the
            selected one names what is below it, and "Settings" is what the button that opened
            this says. */}
        <div className="dialog-tabs">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={tab === entry.id ? "dialog-tab active" : "dialog-tab"}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="dialog-body">
          {tab === "notifications" && (
            <>
              <p className="dialog-detail">Desktop notifications for agent activity</p>
              {settings &&
                SWITCHES.map(({ key, label }) => (
                  <label key={key} className="dialog-checkbox">
                    <input
                      type="checkbox"
                      checked={settings.notifications[key]}
                      onChange={(event) => flip(key, event.target.checked)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              {/* Said out loud because it is not what a switch usually promises: an agent is handed
                  its notification setup once per project, when its first terminal there starts —
                  Claude Code as the settings file it reads once, opencode as what its event stream
                  is wired to — and neither can be reached afterwards. */}
              <p className="dialog-detail">
                Handed to an agent when its first terminal in a project starts - a change reaches
                already-open projects only after tet is restarted.
              </p>
            </>
          )}
          {tab === "shortcuts" && (
            <div className="settings-shortcuts">
              {SHORTCUTS.map(({ id, description }) => (
                <div key={id} className="settings-shortcut-row">
                  <span>{shortcutLabel(id)}</span>
                  <span>{description}</span>
                </div>
              ))}
            </div>
          )}
          {tab === "editor" && (
            <>
              <p className="dialog-detail">
                {activeProject ? `FILES tree, for ${activeProject.name}` : "FILES tree - open a project to edit it"}
              </p>
              {activeProject && fileView && (
                <>
                  <label className="dialog-checkbox">
                    <input
                      type="checkbox"
                      checked={fileView.excludeGitIgnore}
                      onChange={(event) => setExcludeGitIgnore(event.target.checked)}
                    />
                    <span>Hide what git ignores too</span>
                  </label>
                  <label className="dialog-checkbox">
                    <input
                      type="checkbox"
                      checked={fileView.compactFolders}
                      onChange={(event) => setCompactFolders(event.target.checked)}
                    />
                    <span>Compact folders that only contain another folder into one row</span>
                  </label>
                  <label className="dialog-field">
                    <span>Sort order</span>
                    <div className="select-field">
                      <select
                        value={fileView.sortOrder}
                        onChange={(event) => setSortOrder(event.target.value as FileSortOrder)}
                      >
                        {SORT_ORDERS.map((order) => (
                          <option key={order.id} value={order.id}>
                            {order.label}
                          </option>
                        ))}
                      </select>
                      <ChevronIcon expanded className="select-arrow" />
                    </div>
                  </label>
                </>
              )}
              <p className="dialog-detail">Presets from popular editors and IDEs - only for what the file editor supports</p>
              <div className="select-field">
                <select
                  value={settings?.editorKeybindingPreset ?? KEYBINDING_PRESETS[0].id}
                  onChange={(event) => applyPreset(event.target.value)}
                >
                  {KEYBINDING_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
                <ChevronIcon expanded className="select-arrow" />
              </div>
            </>
          )}
          {tab === "info" && info && (
            <div className="settings-info">
              {INFO_ROWS.map(({ key, label }) => (
                <div key={key} className="settings-info-row">
                  <span>{label}</span>
                  <span>{info[key]}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="dialog-buttons">
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
