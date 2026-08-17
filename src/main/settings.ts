import * as fs from "node:fs";
import * as path from "node:path";
import type { AppSettings } from "../shared/types";

/** What tet does before anyone has said otherwise; sbc's own defaults. */
const DEFAULTS: AppSettings = {
  notifications: {
    finished: true,
    needsYou: true,
    idleReminder: false
  }
};

/**
 * The settings dialog's values, persisted in tet's own userData. Written whole from memory
 * like the projects next to it, and read back defensively: a file someone edited by hand is
 * still a file, so a key of the wrong type falls back to its default rather than reaching an
 * agent as `undefined`.
 */
export class SettingsStore {
  private readonly file: string;
  private settings: AppSettings = DEFAULTS;

  constructor(userDataPath: string) {
    this.file = path.join(userDataPath, "settings.json");
    this.load();
  }

  get(): AppSettings {
    return this.settings;
  }

  save(settings: AppSettings): void {
    this.settings = { notifications: booleans(settings.notifications) };
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.settings, null, 2), "utf8");
    } catch (error) {
      console.error("[tet] could not persist settings:", error);
    }
  }

  private load(): void {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        this.settings = { notifications: booleans((parsed as AppSettings).notifications) };
      }
    } catch {
      // No file yet (first start) or unreadable — the defaults stand.
      this.settings = DEFAULTS;
    }
  }
}

/** Every switch that is not a boolean in the file is the one the defaults name. */
function booleans(notifications: Partial<AppSettings["notifications"]> | undefined): AppSettings["notifications"] {
  const defaults = DEFAULTS.notifications;
  return {
    finished: typeof notifications?.finished === "boolean" ? notifications.finished : defaults.finished,
    needsYou: typeof notifications?.needsYou === "boolean" ? notifications.needsYou : defaults.needsYou,
    idleReminder:
      typeof notifications?.idleReminder === "boolean" ? notifications.idleReminder : defaults.idleReminder
  };
}
