import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Project } from "../shared/types";

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
      console.error("[meeseex] could not persist projects:", error);
    }
  }
}
