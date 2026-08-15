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
 * Where a hook drops its markers, and where meezeek watches for them. Three kinds: `busy` from
 * UserPromptSubmit and `finished` from Stop, either end of a turn, plus `waiting` from
 * Notification and PreToolUse for a turn that stopped part-way on a question. A marker's
 * *filename* is the whole message — nothing is read out of a file, so a reader never races a
 * half-written one, which every other file shared with another process here has to be written
 * around.
 */
type Marker = "busy" | "finished" | "waiting";

/**
 * How often the marker directories are swept regardless of the watcher — see watchMarkers for
 * what this is a net under. Two seconds: a spinner that stops a moment late reads as the agent
 * finishing, while one that never stops reads as a broken app.
 */
const MARKER_SWEEP_MS = 2000;

function markerDir(storageDir: string, kind: Marker): string {
  return path.join(storageDir, kind);
}

/**
 * The meezeek half of the hooks below: reports every session marked with `kind` and takes the
 * marker away again. From then on the state lives in the tab, so a file left lying around would
 * report the same turn again on the next start.
 *
 * Whatever is already in there at startup is therefore deleted *without* being reported: those
 * turns ended before this window existed, and every tab is freshly opened at that point.
 */
export function watchMarkers(
  storageDir: string,
  kind: Marker,
  onMarker: (sessionId: string) => void
): () => void {
  const dir = markerDir(storageDir, kind);
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
        // Not `force`: a marker gone by now raises ENOENT here, and an unlink that did not
        // happen is not a turn to report.
        await fs.promises.unlink(path.join(dir, name));
      } catch {
        continue;
      }
      if (report && !stopped) {
        onMarker(name);
      }
    }
  };

  // One drain at a time, in order: the startup drain's own unlinks fire the watcher, and a
  // drain started by that would race it for the next stale marker — and report it.
  let draining = Promise.resolve();
  const queueDrain = (report: boolean): void => {
    draining = draining.then(() => drain(report)).catch(() => undefined);
  };
  queueDrain(false);
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(dir, () => queueDrain(true));
  } catch (error) {
    console.error(`[meezeek] could not watch Claude's ${kind} sessions:`, error);
  }
  // The watcher alone is not enough, and this was measured rather than feared: a marker sat in
  // `finished/` for seven minutes while the process that should have picked it up was running
  // and healthy — the next write drained it along with the fresh one. On win32 fs.watch can
  // fire before the new name is in the directory listing, and nothing fires a second time, so
  // one lost event strands a turn *forever*: the spinner never stops and the mark never lands.
  // A readdir on an all-but-always-empty directory is a syscall, not a process, so the net
  // costs nothing; the watcher stays because it is what makes the common case immediate.
  const sweep = setInterval(() => queueDrain(true), MARKER_SWEEP_MS);
  return () => {
    stopped = true;
    clearInterval(sweep);
    watcher?.close();
  };
}

/**
 * The lines that turn the payload's session id into a marker file, in each shell. Shared by
 * both hooks so the one thing that has to be exactly right — that nothing but a session id can
 * ever become a filename — is written once. `$json` (win32) / `$json` (sh) must be in scope.
 */
function markPowershell(dir: string): string {
  return `  # Matched before it is used as a path: the id is a uuid and nothing else may become
  # a filename here. -Force so a session that reaches this twice overwrites its own marker
  # rather than erroring - the file is empty, there is nothing in it to lose.
  $id = [string]$json.session_id
  if ($id -match '^[0-9a-fA-F-]+$') {
    New-Item -ItemType File -Force -Path (Join-Path ${powershellSingleQuote(dir)} $id) -ErrorAction SilentlyContinue | Out-Null
  }`;
}

function markPosix(dir: string): string {
  return `# Only the uuid characters are captured, so nothing else can ever become a filename below.
id=$(printf '%s' "$json" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([0-9a-fA-F-]*\\)".*/\\1/p')
# touch rather than a ">" redirection: ":" is a special built-in, and POSIX has a failed
# redirection on one of those end the whole shell - which would take whatever follows with it
# the one time the directory is missing.
if [ -n "$id" ]; then
  touch ${shellSingleQuote(dir)}/"$id" 2>/dev/null || true
fi`;
}

/**
 * Builds the UserPromptSubmit hook that records the session as working: the other end of the
 * turn from the Stop hook below, and what puts the spinner on its tab. It has no guard of its
 * own — a prompt was submitted, so the agent is busy, full stop.
 *
 * It shares UserPromptSubmit with the command that prints the context file, whose stdout is
 * appended to the prompt, so this one has to stay **silent**; and it must exit 0 whatever
 * happens, since a non-zero UserPromptSubmit hook can hold the prompt back.
 */
function buildBusyCommand(storageDir: string): string {
  const marks = markerDir(storageDir, "busy");
  fs.mkdirSync(marks, { recursive: true });
  if (process.platform === "win32") {
    const scriptFile = path.join(storageDir, "busy.ps1");
    fs.writeFileSync(
      scriptFile,
      WIN_BOM +
        `try {
  $json = [Console]::In.ReadToEnd() | ConvertFrom-Json
${markPowershell(marks)}
} catch {}
exit 0
`
    );
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`;
  }
  const scriptFile = path.join(storageDir, "busy.sh");
  writePosixScript(
    scriptFile,
    `#!/bin/sh
json=$(cat)
${markPosix(marks)}
exit 0
`
  );
  return `sh "${scriptFile}"`;
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
  const marks = markerDir(storageDir, "finished");
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
${markPowershell(marks)}
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
${markPosix(marks)}
${notifyCommand ?? ""}
`
  );
  return `sh "${scriptFile}"`;
}

/**
 * Builds a hook command that records the session as waiting on the user, and then notifies
 * where notifications are on. Built exactly like the Stop command and for the same reason: the
 * marker is what puts the mark on the tab, and that mark is not a notification the user can
 * turn off — it is how a session blocked out of sight is found again. Only the toast is
 * optional.
 *
 * No guard of its own, unlike Stop's `background_tasks` check: Claude Code raises these events
 * only when it has actually stopped for an answer, so there is no "it merely looks stopped"
 * case to rule out. It carries no turn state either — the turn is still open, and `waiting`
 * says where it stopped, not that it ended.
 *
 * `id` names the script file, because the two callers want different toast wording and a
 * shared file would have the second overwrite the first.
 */
function buildWaitingCommand(storageDir: string, id: string, notifyCommand: string | undefined): string {
  const marks = markerDir(storageDir, "waiting");
  fs.mkdirSync(marks, { recursive: true });
  if (process.platform === "win32") {
    const scriptFile = path.join(storageDir, `${id}.ps1`);
    fs.writeFileSync(
      scriptFile,
      WIN_BOM +
        `try {
  $json = [Console]::In.ReadToEnd() | ConvertFrom-Json
${markPowershell(marks)}
} catch {}
${notifyCommand ?? ""}
`
    );
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`;
  }
  const scriptFile = path.join(storageDir, `${id}.sh`);
  writePosixScript(
    scriptFile,
    `#!/bin/sh
json=$(cat)
${markPosix(marks)}
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
    // Two commands on the one event: the context file's contents become part of the prompt,
    // and the marker says the session has started working. Order matters only in that the
    // second must print nothing — everything a UserPromptSubmit hook writes is appended to
    // the prompt itself.
    UserPromptSubmit: [
      {
        hooks: [
          { type: "command", command: buildReadContextCommand(storageDir, context.contextFile) },
          { type: "command", command: buildBusyCommand(storageDir) }
        ]
      }
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

  // A turn that stopped on a question, registered on the same terms as Stop above: the command
  // marks the tab whatever the settings say, and only the toast inside it is optional. The
  // matcher is the pair of Notification events that mean Claude Code is actually blocked —
  // `idle_prompt` is deliberately not among them, since that one fires *after* a turn ended and
  // is already what the bubble stands for.
  const notificationHooks: { matcher: string; hooks: { type: string; command: string }[] }[] = [
    {
      matcher: "permission_prompt|elicitation_dialog",
      hooks: [
        {
          type: "command",
          command: buildWaitingCommand(
            storageDir,
            "needs-you",
            notifications.needsYou
              ? buildNotifyCommand(
                  storageDir,
                  "needs-you",
                  `${displayName}: Action needed`,
                  `Waiting for input in ${repositoryName}`
                )
              : undefined
          )
        }
      ]
    }
  ];
  if (notifications.idleReminder) {
    notificationHooks.push({
      matcher: "idle_prompt",
      hooks: [
        {
          type: "command",
          command: buildNotifyCommand(
            storageDir,
            "idle",
            `${displayName}: Still waiting`,
            `No response yet in ${repositoryName}`
          )
        }
      ]
    });
  }
  hooks.Notification = notificationHooks;

  // `AskUserQuestion` is a tool rather than a Notification event, so the same condition needs a
  // second hook to be seen at all.
  hooks.PreToolUse = [
    {
      matcher: "AskUserQuestion",
      hooks: [
        {
          type: "command",
          command: buildWaitingCommand(
            storageDir,
            "question",
            notifications.needsYou
              ? buildNotifyCommand(
                  storageDir,
                  "question",
                  `${displayName}: Question`,
                  `Waiting for your answer in ${repositoryName}`
                )
              : undefined
          )
        }
      ]
    }
  ];

  // The context block points at a file in meezeek's own storage — outside the repository,
  // where reads are denied unless granted. Scoped to that one file rather than the whole
  // directory, which also holds the notify scripts and this settings file.
  const permissions = { allow: context.contextReadPaths.map((file) => `Read(${file})`) };

  const settingsFile = path.join(storageDir, "meezeek-hooks-settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks, permissions }, null, 2));
  return ["--settings", settingsFile];
}
