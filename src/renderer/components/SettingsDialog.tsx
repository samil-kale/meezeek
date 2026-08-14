import { useEffect, useState } from "react";
import type { AppInfo, AppSettings, NotificationSettings } from "../../shared/types";

interface SettingsDialogProps {
  onClose: () => void;
}

type SettingsTab = "notifications" | "info";

/** The dialog's panes, in the order they are worth opening. */
const TABS: { id: SettingsTab; label: string }[] = [
  { id: "notifications", label: "Notifications" },
  { id: "info", label: "Info" }
];

/** One switch per line, in the order they matter: the turn ended, it is stuck, it is idle. */
const SWITCHES: { key: keyof NotificationSettings; label: string }[] = [
  { key: "finished", label: "Finished — the turn ended and nothing it started is still running" },
  { key: "needsYou", label: "Action needed — waiting on a permission prompt or a question" },
  { key: "idleReminder", label: "Still waiting — no new prompt for a while" }
];

/** The Info tab's rows, in the order the versions nest: meezeek, then what it runs on. */
const INFO_ROWS: { key: keyof AppInfo; label: string }[] = [
  { key: "version", label: "Meezeek" },
  { key: "electron", label: "Electron" },
  { key: "chromium", label: "Chromium" },
  { key: "node", label: "Node" },
  { key: "os", label: "Platform" }
];

/**
 * Everything meezeek keeps about itself rather than about one repository. Opened from the title
 * bar, over the whole window like the diff.
 *
 * Not part of Dialog.tsx: that file puts *questions* and is built around a form with two
 * buttons. This asks nothing — every switch applies the moment it is flipped, the way VS Code's
 * own settings do, so there is nothing to confirm and nothing to take back.
 */
export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>("notifications");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    void window.meezeek.settings.get().then(setSettings);
    // Asked alongside the settings rather than when the Info tab is first opened: none of it can
    // change while the process runs, so there is nothing a later read would catch.
    void window.meezeek.app.info().then(setInfo);
  }, []);

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

  const flip = (key: keyof NotificationSettings, value: boolean): void => {
    if (!settings) {
      return;
    }
    const next: AppSettings = { ...settings, notifications: { ...settings.notifications, [key]: value } };
    setSettings(next);
    void window.meezeek.settings.save(next);
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
              <p className="dialog-detail">
                What the OS is told about an agent. The mark on a tab that finished out of sight is
                not one of these and stays either way.
              </p>
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
                  its notification setup when it starts — Claude Code as the settings file it reads
                  once, opencode as what its event stream is wired to — and neither can be reached
                  afterwards. */}
              <p className="dialog-detail">
                An agent is handed these when it starts, so a change reaches the terminals that are
                already open only after meezeek is restarted.
              </p>
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
