import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentId, Project } from "../shared/types";

/** The open repositories, persisted so the window comes back with the same project tabs. */
export class ProjectStore {
  private readonly file: string;
  private projects: Project[] = [];

  constructor(userDataPath: string) {
    this.file = path.join(userDataPath, "projects.json");
    this.load();
  }

  list(): Project[] {
    return this.projects;
  }

  get(projectId: string): Project | undefined {
    return this.projects.find((project) => project.id === projectId);
  }

  /** Adds the folder, or returns the existing project when it is already open. */
  add(directory: string): Project {
    const normalized = path.resolve(directory);
    const existing = this.projects.find((project) => project.path === normalized);
    if (existing) {
      return existing;
    }
    const project: Project = {
      id: randomUUID(),
      path: normalized,
      name: path.basename(normalized)
    };
    this.projects.push(project);
    this.save();
    return project;
  }

  remove(projectId: string): void {
    this.projects = this.projects.filter((project) => project.id !== projectId);
    this.save();
  }

  /**
   * Which agent this project's git console runs. Kept here rather than in the project's own
   * meeseek.json: it is how one person likes to work in one checkout, not something the
   * repository has to carry around — and a file that changes on every dropdown would show up
   * as a local change every time.
   */
  setConsoleAgent(projectId: string, agentId: AgentId): void {
    const project = this.get(projectId);
    if (project) {
      project.consoleAgent = agentId;
      this.save();
    }
  }

  /**
   * Which session the console is running, so the next start can put it back there rather than
   * showing it as a tab. `undefined` clears it — a console that was just opened has no session
   * yet, and the one it replaced is no longer the console.
   */
  setConsoleSession(projectId: string, sessionId: string | undefined): void {
    const project = this.get(projectId);
    if (project && project.consoleSessionId !== sessionId) {
      project.consoleSessionId = sessionId;
      this.save();
    }
  }

  /**
   * Puts the projects in the given order. Ids the store doesn't know are dropped and projects
   * the caller left out keep their place at the end: the renderer sends the list it had on
   * screen, which can be a moment behind one added or closed elsewhere.
   */
  reorder(projectIds: string[]): void {
    const known = new Map(this.projects.map((project) => [project.id, project]));
    const ordered = projectIds
      .map((projectId) => known.get(projectId))
      .filter((project): project is Project => project !== undefined);
    const seen = new Set(ordered.map((project) => project.id));
    this.projects = [...ordered, ...this.projects.filter((project) => !seen.has(project.id))];
    this.save();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.projects = parsed.filter(
          (entry): entry is Project =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as Project).id === "string" &&
            typeof (entry as Project).path === "string" &&
            typeof (entry as Project).name === "string"
        );
      }
    } catch {
      // No file yet (first start) or unreadable — start with an empty workspace.
      this.projects = [];
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.projects, null, 2), "utf8");
    } catch (error) {
      console.error("[meeseek] could not persist projects:", error);
    }
  }
}
