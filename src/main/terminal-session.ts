import { spawn } from "node:child_process";
import type { IPty } from "node-pty";
import type { TerminalStatus } from "../shared/types";
import { resolveCommand, spawnAgentProcess } from "./pty";

export interface SessionCallbacks {
  onOutput: (data: string) => void;
  onStatusChange: (status: TerminalStatus) => void;
}

/**
 * The last answer per executable. Whether a CLI is installed is a fact about the machine, not
 * about a project, and a program installed while the app runs is not on this process's PATH
 * anyway — so every project opened after the first takes the answer already given, instead of
 * spawning `--version` for every agent again (on win32 through cmd.exe, two processes each).
 */
const installedChecks = new Map<string, Promise<boolean>>();

/** Always spawns the check — what the requirements dialog's re-check needs — and remembers the answer. */
export function checkAgentInstalled(executable: string, versionArgs: string[], cwd: string): Promise<boolean> {
  const check = new Promise<boolean>((resolve) => {
    const { command, args } = resolveCommand(executable, versionArgs);
    const process = spawn(command, args, { cwd, windowsHide: true });
    let resolved = false;
    const finish = (installed: boolean) => {
      if (!resolved) {
        resolved = true;
        resolve(installed);
      }
    };
    process.on("error", () => finish(false));
    process.on("exit", (code) => finish(code === 0));
  });
  installedChecks.set(`${executable}\0${versionArgs.join("\0")}`, check);
  return check;
}

/** The remembered answer where there is one, otherwise the check. */
export function isAgentInstalled(executable: string, versionArgs: string[], cwd: string): Promise<boolean> {
  return installedChecks.get(`${executable}\0${versionArgs.join("\0")}`) ?? checkAgentInstalled(executable, versionArgs, cwd);
}

/** One agent process behind one tab: spawned lazily, at the size the view actually has. */
export class TerminalSession {
  private process: IPty | undefined;
  private status: TerminalStatus = "missing";
  private intentionalStop = false;

  constructor(
    private readonly executable: string,
    private readonly cwd: string,
    private readonly env: Record<string, string> | undefined,
    private readonly callbacks: SessionCallbacks,
    private readonly args: string[] = [],
    /** A saved command's own variables, which outrank the ones inherited from the machine. */
    private readonly envOverride?: Record<string, string>
  ) {}

  private setStatus(status: TerminalStatus): void {
    this.status = status;
    this.callbacks.onStatusChange(status);
  }

  /** Settled before the first `ensureStarted`: only a "ready" session ever spawns. */
  markInstalled(installed: boolean): void {
    this.setStatus(installed ? "ready" : "missing");
  }

  /**
   * Called with the terminal's real dimensions (from the renderer). Starts the agent on the
   * first call, so it never renders for a size the view does not have; afterwards it only
   * forwards resizes.
   */
  ensureStarted(cols: number, rows: number): void {
    if (this.process) {
      // A pty that has just died is still held here until node-pty's own exit event arrives,
      // and resizing one throws rather than reporting anything — which took the whole main
      // process with it. A saved command whose program does not exist dies inside exactly that
      // window: it is spawned by the first resize and gone before the second one lands.
      try {
        this.process.resize(cols, rows);
      } catch {
        // The exit handler is on its way and is what sets the status; there is nothing to do
        // for a size the process will never draw at.
      }
      return;
    }
    this.start(cols, rows);
  }

  private start(cols: number, rows: number): void {
    // "ready" is the state a session is in before its first spawn and never again: after one
    // it is running, and once the process is gone it is stopped or errored. Without that
    // check any later resize — switching tabs is one — would spawn a second process for a
    // terminal the user closed with `exit`, or bring a crashed agent back unasked.
    if (this.process || this.status !== "ready") {
      return;
    }

    try {
      this.process = spawnAgentProcess(this.executable, this.args, {
        cwd: this.cwd,
        cols,
        rows,
        env: this.env,
        envOverride: this.envOverride
      });
    } catch (error) {
      console.error(`[meezeek] failed to spawn ${this.executable}:`, error);
      this.callbacks.onOutput(`\r\n[meezeek] failed to spawn ${this.executable}:\r\n${String(error)}\r\n`);
      this.setStatus("error");
      return;
    }

    this.setStatus("running");
    this.process.onData((data) => this.callbacks.onOutput(data));
    this.process.onExit(({ exitCode }) => {
      this.process = undefined;
      if (!this.intentionalStop) {
        this.callbacks.onOutput(`\r\n[meezeek] ${this.executable} exited with code ${exitCode}\r\n`);
      }
      // What the process said, not merely that it is gone: a saved command ends by itself every
      // time it is run, and a build that passed is not an error. Killed by us is "stopped"
      // whatever the code, since that code is our doing rather than the command's.
      this.setStatus(this.intentionalStop || exitCode === 0 ? "stopped" : "error");
      this.intentionalStop = false;
    });
  }

  write(data: string): void {
    this.process?.write(data);
  }

  stop(): void {
    if (this.process) {
      this.intentionalStop = true;
      this.process.kill();
    }
  }
}
