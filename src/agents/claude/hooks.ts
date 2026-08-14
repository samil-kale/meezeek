import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildNotifyCommand,
  powershellSingleQuote,
  shellSingleQuote,
  WIN_BOM,
  writePosixScript
} from "../../main/os-notify";
import type { NotificationSettings } from "../../shared/types";

/**
 * The directory the Stop hook drops a finished session's marker into, and the one meezeek
 * watches for them. Its *filenames* are the whole message — nothing is read out of a file, so
 * a reader never races a half-written one, which every other file shared with another process
 * here has to be written around.
 */
function finishedDir(storageDir: string): string {
  return path.join(storageDir, "finished");
}

/**
 * The meezeek half of the hook above: reports every session it marked as finished and takes
 * the marker away again. From then on the mark lives in the tab's own state, so a file left
 * lying around would report the same turn again on the next start.
 *
 * Whatever is already in there at startup is therefore deleted *without* being reported: those
 * turns ended before this window existed, and every tab is freshly opened at that point.
 */
export function watchFinished(storageDir: string, onFinished: (sessionId: string) => void): () => void {
  const dir = finishedDir(storageDir);
  let stopped = false;

  const drain = async (report: boolean): Promise<void> => {
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      // The hook has never run here, or its setup failed — nothing to report either way.
      return;
    }
    for (const name of names) {
      try {
        // Deliberately not `force`: a marker a concurrent drain already took raises ENOENT
        // here, and that is what keeps one turn from being reported twice.
        await fs.promises.unlink(path.join(dir, name));
      } catch {
        continue;
      }
      if (report && !stopped) {
        onFinished(name);
      }
    }
  };

  void drain(false);
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(dir, () => void drain(true));
  } catch (error) {
    console.error("[meezeek] could not watch Claude's finished sessions:", error);
  }
  return () => {
    stopped = true;
    watcher?.close();
  };
}

/**
 * Builds the Stop hook: it records that the session finished a turn — a file named after its
 * id — and then notifies, where notifications are on. Both are guarded by the same condition,
 * since both answer the one question of whether the turn is actually over.
 *
 * Stop fires on every turn boundary, including one that merely launches a background subagent
 * or shell command and returns at once — so unguarded, "Finished" shows up while that work is
 * still running.
 *
 * The Stop payload carries a `background_tasks` array for exactly this: every still pending
 * job, each with an `id`, a `type` (`subagent` for Task/Agent runs, `shell` for Bash calls
 * made with run_in_background) and a `status`.
 *
 * Deliberately narrow: it suppresses only on `status: running`. An unknown status therefore
 * reports rather than staying silent — a spurious mark is a far better failure than a job
 * stuck in the list silencing every future one.
 */
function buildStopCommand(storageDir: string, notifyCommand: string | undefined): string {
  const marks = finishedDir(storageDir);
  fs.mkdirSync(marks, { recursive: true });
  if (process.platform === "win32") {
    const scriptFile = path.join(storageDir, "stop-guard.ps1");
    fs.writeFileSync(
      scriptFile,
      WIN_BOM +
        `try {
  $json = [Console]::In.ReadToEnd() | ConvertFrom-Json
  # The @() must wrap the whole pipeline, not just the input: PowerShell 5.1 returns a bare
  # object rather than a 1-element array when Where-Object matches exactly once, and a bare
  # object has no .Count - so $running.Count yields $null and the comparison below turns
  # false. That is the single-subagent case, i.e. the common one. The $_ test drops the lone
  # $null that piping an absent field would pass on.
  $running = @($json.background_tasks | Where-Object { $_ -and $_.status -eq "running" })
  if ($running.Count -gt 0) {
    exit 0
  }
  # Matched before it is used as a path: the id is a uuid and nothing else may become a
  # filename here. -Force so a session that finishes twice overwrites its own marker
  # rather than erroring - the file is empty, there is nothing in it to lose.
  $id = [string]$json.session_id
  if ($id -match '^[0-9a-fA-F-]+$') {
    New-Item -ItemType File -Force -Path (Join-Path ${powershellSingleQuote(marks)} $id) -ErrorAction SilentlyContinue | Out-Null
  }
} catch {}
${notifyCommand ?? ""}
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
# Only the uuid characters are captured, so nothing else can ever become a filename below.
id=$(printf '%s' "$json" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([0-9a-fA-F-]*\\)".*/\\1/p')
# touch rather than a ">" redirection: ":" is a special built-in, and POSIX has a failed
# redirection on one of those end the whole shell - which would take the notification below
# with it the one time the directory is missing.
if [ -n "$id" ]; then
  touch ${shellSingleQuote(marks)}/"$id" 2>/dev/null || true
fi
${notifyCommand ?? ""}
`
  );
  return `sh "${scriptFile}"`;
}

/**
 * Builds the UserPromptSubmit-hook command that prints the context file — its stdout is
 * attached to every user prompt as context.
 *
 * Which shell Claude Code uses for hook commands on win32 is environment-dependent (PowerShell,
 * cmd.exe and Git Bash were all observed in sbc), so builtins like `type` are unreliable. An
 * explicit `powershell -File` invocation is parsed identically by all three.
 */
function buildReadContextCommand(storageDir: string, contextFile: string): string {
  if (process.platform !== "win32") {
    return `cat ${shellSingleQuote(contextFile)}`;
  }
  const scriptFile = path.join(storageDir, "read-context.ps1");
  // Quoted the literal way in both shells: every path we generate has the user's own name in
  // it, and a "$" in that would otherwise be read as a variable rather than as a character.
  fs.writeFileSync(
    scriptFile,
    WIN_BOM +
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\nGet-Content -Raw ${powershellSingleQuote(contextFile)}\n`
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

  // Registered whatever the notification settings say: the same hook is what marks the tab,
  // and that mark is not a notification the user can turn off — it is how a session that
  // finished out of sight is found again. Only the toast inside it is optional.
  const notify = notifications.finished
    ? buildNotifyCommand(storageDir, "stop", `${displayName}: Finished`, `Finished in ${repositoryName}`)
    : undefined;
  hooks.Stop = [{ hooks: [{ type: "command", command: buildStopCommand(storageDir, notify) }] }];

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

  // The context block points at a file in meezeek's own storage — outside the repository,
  // where reads are denied unless granted. Scoped to that one file rather than the whole
  // directory, which also holds the notify scripts and this settings file.
  const permissions = { allow: context.contextReadPaths.map((file) => `Read(${file})`) };

  const settingsFile = path.join(storageDir, "meezeek-hooks-settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks, permissions }, null, 2));
  return ["--settings", settingsFile];
}
