import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { NoticeSeverity } from "../shared/types";

/**
 * How often to check after the first, startup check. A closed tab's session and a running
 * terminal both survive an update fine — it only installs on the next quit or relaunch — so
 * there is no urgency to check more often than this.
 */
const CHECK_INTERVAL_MS = 4 * 60 * 60_000;

const RELEASES_URL = "https://github.com/samil-kale/tet/releases/latest";

/**
 * Runs only in a packaged build: electron-updater reads `app-update.yml`, which esbuild's dev
 * output never has, and would just fail every check.
 *
 * Never calls `quitAndInstall` itself — a terminal tab is a live agent session, same reason
 * this app never restarts itself elsewhere (see CLAUDE.md, "Do not restart the app yourself").
 * `autoInstallOnAppQuit` (electron-updater's default) installs the next time the user quits on
 * their own, so a downloaded update just waits.
 *
 * Two platforms can only be told, not updated, so they fall back to "update-available" plus a
 * link to the releases page instead of downloading:
 * - macOS: Squirrel.Mac refuses to replace an unsigned, unnotarized bundle, which this one is
 *   (see CLAUDE.md on code signing — deliberately skipped).
 * - Linux when not running from the AppImage: electron-updater's Linux updater only knows how
 *   to replace an AppImage (recognised by the `APPIMAGE` env var electron-builder's AppImage
 *   sets at launch); a deb install has no such mechanism, and would otherwise fail every check
 *   behind the silent error handler below, never telling that user anything.
 */
export function startAutoUpdate(
  notify: (severity: NoticeSeverity, message: string, progress?: number) => void
): void {
  if (!app.isPackaged) {
    return;
  }

  const canInstall = process.platform === "win32" || Boolean(process.env.APPIMAGE);
  autoUpdater.autoDownload = canInstall;

  if (canInstall) {
    // Ticks the same notice's progress in place rather than a fresh notice per event — see
    // Notices.tsx, which tracks the one in-flight progress notice by id for exactly this.
    autoUpdater.on("download-progress", (info) => {
      notify("info", `Downloading update ${Math.round(info.percent)}%`, info.percent);
    });
    autoUpdater.on("update-downloaded", (info) => {
      notify("info", `Update ${info.version} downloaded, installs on next restart`, 100);
    });
  } else {
    autoUpdater.on("update-available", (info) => {
      notify("info", `Update ${info.version} available: ${RELEASES_URL}`);
    });
  }
  // Silent: an offline machine or a rate-limited check would otherwise put the same notice up
  // every four hours for something nobody asked for, same reasoning as Repository.autoFetch.
  autoUpdater.on("error", () => undefined);

  void autoUpdater.checkForUpdates().catch(() => undefined);
  setInterval(() => void autoUpdater.checkForUpdates().catch(() => undefined), CHECK_INTERVAL_MS);
}
