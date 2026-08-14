import { exec } from "node:child_process";
import * as path from "node:path";
import { buildNotifyCommand } from "../../main/os-notify";
import type { NotificationSettings } from "../notifications";

/**
 * Fires the OS notifications for opencode. No hooks and no generated plugin are involved:
 * the server's own event stream carries what a notification would be about, and meezeek is
 * already subscribed to it for everything else — opencode's configuration stays untouched.
 */
export function createOpencodeNotifier(
  storageDir: string,
  cwd: string,
  displayName: string,
  notifications: NotificationSettings
): (eventType: string) => void {
  const repositoryName = path.basename(cwd);
  const commands = new Map<string, string>();

  if (notifications.finished) {
    const command = buildNotifyCommand(
      storageDir,
      "stop",
      `${displayName}: Finished`,
      `Finished in ${repositoryName}`
    );
    commands.set("session.idle", command);
  }
  if (notifications.needsYou) {
    const command = buildNotifyCommand(
      storageDir,
      "needs-you",
      `${displayName}: Action needed`,
      `Waiting for input in ${repositoryName}`
    );
    for (const type of ["permission.asked", "question.asked", "session.error"]) {
      commands.set(type, command);
    }
  }

  return (eventType) => {
    const command = commands.get(eventType);
    if (command) {
      exec(command, () => {
        // Notification failures must never disturb the session.
      });
    }
  };
}
