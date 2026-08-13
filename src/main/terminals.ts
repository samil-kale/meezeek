import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import { getAgent } from "../agents";
import type { AgentId, Project, TerminalDescriptor, TerminalStatus } from "../shared/types";
import { spawnAgentProcess } from "./pty";

export interface TerminalCallbacks {
  onOutput: (terminalId: string, data: string) => void;
  onStatus: (terminalId: string, status: TerminalStatus) => void;
}

class Terminal {
  private process: IPty | undefined;
  private intentionalStop = false;

  constructor(
    readonly descriptor: TerminalDescriptor,
    private readonly cwd: string,
    private readonly callbacks: TerminalCallbacks
  ) {}

  private setStatus(status: TerminalStatus): void {
    this.descriptor.status = status;
    this.callbacks.onStatus(this.descriptor.id, status);
  }

  /**
   * Called with the terminal's real dimensions from the renderer. Starts the process on
   * the first call so it never renders for a size the view does not have; afterwards it
   * just forwards resizes.
   */
  ensureStarted(cols: number, rows: number): void {
    if (this.process) {
      this.process.resize(cols, rows);
      return;
    }

    const agent = getAgent(this.descriptor.agentId);
    const executable = agent.executable();
    try {
      this.process = spawnAgentProcess(executable, agent.args ?? [], {
        cwd: this.cwd,
        cols,
        rows,
        env: agent.env
      });
    } catch (error) {
      this.callbacks.onOutput(this.descriptor.id, `\r\n[meeseex] failed to spawn ${executable}:\r\n${String(error)}\r\n`);
      this.setStatus("error");
      return;
    }

    this.setStatus("running");
    this.process.onData((data) => this.callbacks.onOutput(this.descriptor.id, data));
    this.process.onExit(({ exitCode }) => {
      this.process = undefined;
      if (!this.intentionalStop) {
        this.callbacks.onOutput(this.descriptor.id, `\r\n[meeseex] ${executable} exited with code ${exitCode}\r\n`);
        this.setStatus("exited");
      }
    });
  }

  write(data: string): void {
    this.process?.write(data);
  }

  dispose(): void {
    if (this.process) {
      this.intentionalStop = true;
      this.process.kill();
      this.process = undefined;
    }
  }
}

export class TerminalService {
  private readonly terminals = new Map<string, Terminal>();

  constructor(private readonly callbacks: TerminalCallbacks) {}

  list(projectId: string): TerminalDescriptor[] {
    return [...this.terminals.values()]
      .filter((terminal) => terminal.descriptor.projectId === projectId)
      .map((terminal) => terminal.descriptor);
  }

  create(project: Project, agentId: AgentId): TerminalDescriptor {
    const descriptor: TerminalDescriptor = {
      id: randomUUID(),
      projectId: project.id,
      agentId,
      title: this.nextTitle(project.id, agentId),
      status: "starting"
    };
    this.terminals.set(descriptor.id, new Terminal(descriptor, project.path, this.callbacks));
    return descriptor;
  }

  input(terminalId: string, data: string): void {
    this.terminals.get(terminalId)?.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.terminals.get(terminalId)?.ensureStarted(cols, rows);
  }

  close(terminalId: string): void {
    this.terminals.get(terminalId)?.dispose();
    this.terminals.delete(terminalId);
  }

  closeProject(projectId: string): void {
    for (const terminal of this.list(projectId)) {
      this.close(terminal.id);
    }
  }

  disposeAll(): void {
    for (const terminal of this.terminals.values()) {
      terminal.dispose();
    }
    this.terminals.clear();
  }

  /** "Claude", then "Claude 2" — the lowest number this project does not use yet. */
  private nextTitle(projectId: string, agentId: AgentId): string {
    const { displayName } = getAgent(agentId);
    const taken = new Set(this.list(projectId).map((descriptor) => descriptor.title));
    if (!taken.has(displayName)) {
      return displayName;
    }
    for (let index = 2; ; index++) {
      const title = `${displayName} ${index}`;
      if (!taken.has(title)) {
        return title;
      }
    }
  }
}
