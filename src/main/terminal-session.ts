import { spawn } from "node:child_process";
import type { IPty } from "node-pty";
import type { TerminalStatus } from "../shared/types";
import { resolveCommand, spawnAgentProcess } from "./pty";

export interface SessionCallbacks {
  onOutput: (data: string) => void;
  onStatusChange: (status: TerminalStatus) => void;
}

export function checkAgentInstalled(executable: string, versionArgs: string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { command, args } = resolveCommand(executable, versionArgs);
    const check = spawn(command, args, { cwd, windowsHide: true });
    let resolved = false;
    const finish = (installed: boolean) => {
      if (!resolved) {
        resolved = true;
        resolve(installed);
      }
    };
    check.on("error", () => finish(false));
    check.on("exit", (code) => finish(code === 0));
  });
}

/** One agent process behind one tab: spawned lazily, at the size the view actually has. */
export class TerminalSession {
  private process: IPty | undefined;
  private status: TerminalStatus = "missing";
  private intentionalStop = false;
  private installed = false;
  private pendingDims: { cols: number; rows: number } | undefined;

  constructor(
    private readonly executable: string,
    private readonly cwd: string,
    private readonly env: Record<string, string> | undefined,
    private readonly callbacks: SessionCallbacks,
    private readonly args: string[] = [],
    /** A saved command's own variables, which outrank the ones inherited from the machine. */
    private readonly envOverride?: Record<string, string>
  ) {}

  getStatus(): TerminalStatus {
    return this.status;
  }

  private setStatus(status: TerminalStatus): void {
    this.status = status;
    this.callbacks.onStatusChange(status);
  }

  markInstalled(installed: boolean): void {
    this.installed = installed;
    if (!installed) {
      this.setStatus("missing");
      return;
    }
    this.setStatus("ready");
    // The view may have reported its dimensions while the version check was still
    // running — start with those now instead of waiting for the next resize.
    if (this.pendingDims) {
      const { cols, rows } = this.pendingDims;
      this.pendingDims = undefined;
      this.start(cols, rows);
    }
  }

  /**
   * Called with the terminal's real dimensions (from the renderer). Starts the agent on
   * the first call so it never renders for a size the view doesn't have; afterwards it
   * just forwards resizes.
   */
  ensureStarted(cols: number, rows: number): void {
    if (this.process) {
      this.process.resize(cols, rows);
      return;
    }
    if (!this.installed) {
      this.pendingDims = { cols, rows };
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
      console.error(`[meeseek] failed to spawn ${this.executable}:`, error);
      this.callbacks.onOutput(`\r\n[meeseek] failed to spawn ${this.executable}:\r\n${String(error)}\r\n`);
      this.setStatus("error");
      return;
    }

    this.setStatus("running");
    this.process.onData((data) => this.callbacks.onOutput(data));
    this.process.onExit(({ exitCode }) => {
      this.process = undefined;
      if (!this.intentionalStop) {
        this.callbacks.onOutput(`\r\n[meeseek] ${this.executable} exited with code ${exitCode}\r\n`);
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
