import { useEffect, useState } from "react";
import type { AppSettings, NotificationSettings } from "../../shared/types";

interface SettingsDialogProps {
  onClose: () => void;
}

/** One switch per line, in the order they matter: the turn ended, it is stuck, it is idle. */
const SWITCHES: { key: keyof NotificationSettings; label: string }[] = [
  { key: "finished", label: "Finished — the turn ended and nothing it started is still running" },
  { key: "needsYou", label: "Action needed — waiting on a permission prompt or a question" },
  { key: "idleReminder", label: "Still waiting — no new prompt for a while" }
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
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    void window.meezeek.settings.get().then(setSettings);
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
      <div className="dialog">
        <div className="dialog-title">Settings</div>
        <div className="dialog-body">
          <div className="settings-group">Notifications</div>
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
