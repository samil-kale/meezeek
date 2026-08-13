import * as fs from "node:fs";
import * as path from "node:path";
import { buildNotifyCommand, WIN_BOM, writePosixScript } from "../../main/os-notify";
import type { NotificationSettings } from "../notifications";

/**
 * Wraps a Stop notify command so it only runs once nothing the turn kicked off is still
 * working. Stop fires on every turn boundary — including one that merely launches a
 * background subagent or shell command and returns immediately — so unguarded, "Finished"
 * shows up while that work is still running.
 *
 * The Stop payload carries a `background_tasks` array for exactly this: every still pending
 * job, each with an `id`, a `type` (`subagent` for Task/Agent runs, `shell` for Bash calls
 * made with run_in_background) and a `status`.
 *
 * Deliberately narrow: it suppresses only on `status: running`. An unknown status therefore
 * notifies rather than staying silent — a spurious notification is a far better failure than
 * a job stuck in the list silencing every future one.
 */
function buildStopGuardCommand(storageDir: string, notifyCommand: string): string {
  if (process.platform === "win32") {
    const scriptFile = path.join(storageDir, "stop-guard.ps1");
    fs.writeFileSync(
      scriptFile,
      WIN_BOM +
        `try {
  $json = [Console]::In.ReadToEnd() | ConvertFrom-Json
  # The @() must wrap the whole pipeline, not just the input: PowerShell 5.1 returns a
  # bare object rather than a 1-element array when Where-Object matches exactly once,
  # and a bare object has no .Count - so $running.Count silently yields $null and the
  # comparison below turns false. That is the single-subagent case, i.e. the common
  # one. The $_ test drops the lone $null that piping an absent field would pass on.
  $running = @($json.background_tasks | Where-Object { $_ -and $_.status -eq "running" })
  if ($running.Count -gt 0) {
    exit 0
  }
} catch {}
${notifyCommand}
`
    );
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`;
  }
  const scriptFile = path.join(storageDir, "stop-guard.sh");
  writePosixScript(
    scriptFile,
    `#!/bin/sh
json=$(cat)
# Isolate the background_tasks array before matching, so a "status":"running" that merely
# appears in some other field (last_assistant_message quoting the payload shape, say)
# cannot suppress the notification. Task objects hold no nested arrays, so stopping at the
# first ] is safe.
tasks=$(printf '%s' "$json" | sed -n 's/.*"background_tasks"[[:space:]]*:[[:space:]]*\\(\\[[^]]*\\]\\).*/\\1/p')
if printf '%s' "$tasks" | grep -q '"status"[[:space:]]*:[[:space:]]*"running"'; then
  exit 0
fi
${notifyCommand}
`
  );
  return `sh "${scriptFile}"`;
}

/**
 * Builds the UserPromptSubmit-hook command that prints the context file — its stdout is
 * attached to every user prompt as context.
 *
 * Which shell Claude Code uses for hook commands on win32 is environment-dependent
 * (PowerShell, cmd.exe and Git Bash were all observed in sbc), so shell builtins like `type`
 * are unreliable. An explicit `powershell -File` invocation is parsed identically by all
 * three, so route the file read through a small script.
 */
function buildReadContextCommand(storageDir: string, contextFile: string): string {
  if (process.platform !== "win32") {
    return `cat "${contextFile}"`;
  }
  const scriptFile = path.join(storageDir, "read-context.ps1");
  fs.writeFileSync(
    scriptFile,
    WIN_BOM + `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\nGet-Content -Raw "${contextFile}"\n`
  );
  return `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`;
}

/**
 * Generates the settings file that registers Claude Code's hooks, and returns the arguments
 * that point the CLI at it. Everything is scoped to that per-repository file and passed with
 * `--settings`, which Claude Code layers on top of its own configuration — the user's
 * `~/.claude/settings.json` is never read, written or replaced here.
 */
export function setupClaudeHooks(
  storageDir: string,
  cwd: string,
  displayName: string,
  notifications: NotificationSettings,
  context: { contextFile: string; contextReadPaths: string[] }
): string[] {
  const hooks: Record<string, unknown> = {
    UserPromptSubmit: [
      { hooks: [{ type: "command", command: buildReadContextCommand(storageDir, context.contextFile) }] }
    ]
  };
  const repositoryName = path.basename(cwd);

  if (notifications.finished) {
    const notify = buildNotifyCommand(
      storageDir,
      "stop",
      `${displayName}: Finished`,
      `Finished in ${repositoryName}`
    );
    hooks.Stop = [{ hooks: [{ type: "command", command: buildStopGuardCommand(storageDir, notify) }] }];
  }

  const notificationMatchers: { id: string; matcher: string; title: string; body: string }[] = [];
  if (notifications.needsYou) {
    notificationMatchers.push({
      id: "needs-you",
      matcher: "permission_prompt|elicitation_dialog",
      title: `${displayName}: Action needed`,
      body: `Waiting for input in ${repositoryName}`
    });
  }
  if (notifications.idleReminder) {
    notificationMatchers.push({
      id: "idle",
      matcher: "idle_prompt",
      title: `${displayName}: Still waiting`,
      body: `No response yet in ${repositoryName}`
    });
  }
  if (notificationMatchers.length > 0) {
    hooks.Notification = notificationMatchers.map(({ id, matcher, title, body }) => ({
      matcher,
      hooks: [{ type: "command", command: buildNotifyCommand(storageDir, id, title, body) }]
    }));
  }

  if (notifications.needsYou) {
    const notify = buildNotifyCommand(
      storageDir,
      "question",
      `${displayName}: Question`,
      `Waiting for your answer in ${repositoryName}`
    );
    hooks.PreToolUse = [{ matcher: "AskUserQuestion", hooks: [{ type: "command", command: notify }] }];
  }

  // The context block points at a file in meeseek's own storage — outside the repository,
  // where reads are denied unless granted. Scoped to that one file rather than the whole
  // directory, which also holds the notify scripts and this settings file.
  const permissions = { allow: context.contextReadPaths.map((file) => `Read(${file})`) };

  const settingsFile = path.join(storageDir, "meeseek-hooks-settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks, permissions }, null, 2));
  return ["--settings", settingsFile];
}
