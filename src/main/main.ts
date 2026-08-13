import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from "electron";
import { listAgents } from "../agents";
import type {
  AgentId,
  CheckoutTarget,
  FileDiff,
  GitActionResult,
  Project,
  RepositoryState,
  TerminalDescriptor,
  TerminalStatus
} from "../shared/types";
import { resolveRoot } from "./git";
import { ProjectStore } from "./projects";
import { countActivity, startEventLoopMonitor } from "./event-loop-monitor";
import { RepositoryManager } from "./repository";
import { SessionManagerRegistry } from "./session-manager";

/** Terminal output arrives in many small chunks; one IPC message per chunk is wasteful. */
const OUTPUT_FLUSH_MS = 8;

let window: BrowserWindow | undefined;

function send(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}

const pendingOutput = new Map<string, { projectId: string; tabId: string; data: string }>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function flushOutput(): void {
  flushTimer = undefined;
  for (const chunk of pendingOutput.values()) {
    send("terminal:output", chunk);
  }
  pendingOutput.clear();
}

function queueOutput(projectId: string, tabId: string, data: string): void {
  countActivity("output");
  const key = `${projectId}\u0000${tabId}`;
  const pending = pendingOutput.get(key);
  if (pending) {
    pending.data += data;
  } else {
    pendingOutput.set(key, { projectId, tabId, data });
  }
  flushTimer ??= setTimeout(flushOutput, OUTPUT_FLUSH_MS);
}

const store = new ProjectStore(app.getPath("userData"));
const repositories = new RepositoryManager(
  (projectId, state) => send("repo:state-changed", { projectId, state }),
  (severity, message) => send("app:notice", { severity, message })
);
const sessions = new SessionManagerRegistry(app.getPath("userData"), {
  onTabs: (projectId, tabs) => send("terminal:tabs", { projectId, tabs }),
  onOutput: queueOutput,
  onStatus: (projectId, tabId, status: TerminalStatus) => send("terminal:status", { projectId, tabId, status }),
  onStartupProgress: (projectId, show) => send("terminal:startup-progress", { projectId, show }),
  onNotice: (severity, message) => send("app:notice", { severity, message })
});

const MISSING_REPOSITORY: RepositoryState = {
  head: "",
  detached: false,
  localBranches: [],
  remotes: [],
  changes: [],
  error: "Project not found"
};

function openProject(project: Project): void {
  repositories.open(project);
  sessions.open(project);
}

/** Writes bytes the renderer holds but has no path for to a temp file, and returns it. */
function writeTempFile(name: string, data: Buffer): string {
  const file = path.join(os.tmpdir(), `meeseek-${Date.now()}-${path.basename(name)}`);
  fs.writeFileSync(file, data);
  return file;
}

function registerIpc(): void {
  ipcMain.handle("projects:list", (): Project[] => store.list());

  ipcMain.handle("projects:add", async (): Promise<Project | null> => {
    const result = await dialog.showOpenDialog({
      title: "Add repository",
      properties: ["openDirectory"]
    });
    const directory = result.filePaths[0];
    if (result.canceled || !directory) {
      return null;
    }
    // Picking a subdirectory of a repository opens the repository itself: git reports every
    // path relative to the root, and the root is what branches and status describe.
    const project = store.add((await resolveRoot(directory)) ?? directory);
    openProject(project);
    return project;
  });

  ipcMain.handle("projects:reorder", (_event, projectIds: string[]): void => store.reorder(projectIds));

  ipcMain.handle("projects:remove", (_event, projectId: string): void => {
    sessions.close(projectId);
    repositories.close(projectId);
    store.remove(projectId);
  });

  ipcMain.handle("repo:state", (_event, projectId: string): RepositoryState => {
    return repositories.get(projectId)?.getState() ?? MISSING_REPOSITORY;
  });

  ipcMain.handle("repo:refresh", async (_event, projectId: string): Promise<RepositoryState> => {
    return (await repositories.get(projectId)?.refresh()) ?? MISSING_REPOSITORY;
  });

  ipcMain.handle("repo:checkout", async (_event, projectId: string, target: CheckoutTarget): Promise<GitActionResult> => {
    const repository = repositories.get(projectId);
    if (!repository) {
      return { ok: false, error: MISSING_REPOSITORY.error };
    }
    return repository.checkout(target);
  });

  ipcMain.handle(
    "repo:create-branch",
    async (_event, projectId: string, name: string, startPoint?: string): Promise<GitActionResult> => {
      const repository = repositories.get(projectId);
      if (!repository) {
        return { ok: false, error: MISSING_REPOSITORY.error };
      }
      return repository.createBranch(name, startPoint);
    }
  );

  ipcMain.handle(
    "repo:rename-branch",
    async (_event, projectId: string, from: string, to: string): Promise<GitActionResult> => {
      const repository = repositories.get(projectId);
      if (!repository) {
        return { ok: false, error: MISSING_REPOSITORY.error };
      }
      return repository.renameBranch(from, to);
    }
  );

  ipcMain.handle(
    "repo:delete-branch",
    async (_event, projectId: string, name: string, remote?: string): Promise<GitActionResult> => {
      const repository = repositories.get(projectId);
      if (!repository) {
        return { ok: false, error: MISSING_REPOSITORY.error };
      }
      return repository.deleteBranch(name, remote);
    }
  );

  ipcMain.handle("repo:discard", async (_event, projectId: string, paths: string[]): Promise<GitActionResult> => {
    const repository = repositories.get(projectId);
    if (!repository) {
      return { ok: false, error: MISSING_REPOSITORY.error };
    }
    return paths.length > 0 ? repository.discard(paths) : { ok: true };
  });

  ipcMain.handle(
    "repo:ignore",
    async (_event, projectId: string, filePath: string, scope: "file" | "extension"): Promise<GitActionResult> => {
      const repository = repositories.get(projectId);
      if (!repository) {
        return { ok: false, error: MISSING_REPOSITORY.error };
      }
      return repository.ignore(filePath, scope);
    }
  );

  ipcMain.handle("repo:diff", async (_event, projectId: string, filePath: string): Promise<FileDiff> => {
    const repository = repositories.get(projectId);
    if (!repository) {
      return { path: filePath, lines: [], binary: false, truncated: false, error: MISSING_REPOSITORY.error };
    }
    return repository.diff(filePath);
  });

  ipcMain.handle("terminal:list", (_event, projectId: string): TerminalDescriptor[] => {
    return sessions.get(projectId)?.snapshot() ?? [];
  });

  ipcMain.handle("terminal:create", (_event, projectId: string, agentId: AgentId): TerminalDescriptor => {
    const manager = sessions.get(projectId);
    if (!manager) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    return manager.createTab(agentId);
  });

  ipcMain.handle("terminal:close", async (_event, projectId: string, tabIds: string[]): Promise<void> => {
    await sessions.get(projectId)?.closeTabs(tabIds);
  });

  ipcMain.handle("terminal:rename", async (_event, projectId: string, tabId: string, title: string): Promise<void> => {
    await sessions.get(projectId)?.renameTab(tabId, title);
  });

  ipcMain.on("terminal:input", (_event, projectId: string, tabId: string, data: string) => {
    countActivity("input");
    sessions.get(projectId)?.write(tabId, data);
  });

  ipcMain.on("terminal:resize", (_event, projectId: string, tabId: string, cols: number, rows: number) => {
    sessions.get(projectId)?.handleResize(tabId, cols, rows);
  });

  ipcMain.handle("terminal:starting", (_event, projectId: string): boolean => {
    return sessions.get(projectId)?.isStarting() ?? false;
  });

  ipcMain.handle("terminal:resolve-url", async (_event, projectId: string, tabId: string, fragment: string) => {
    return (await sessions.get(projectId)?.resolveUrlPrefix(tabId, fragment)) ?? null;
  });

  ipcMain.handle("agents:list", () => listAgents());

  ipcMain.handle("shell:open-url", async (_event, url: string): Promise<void> => {
    try {
      await shell.openExternal(url);
    } catch (error) {
      send("app:notice", { severity: "error", message: `Could not open URL: ${url} (${String(error)})` });
    }
  });

  /**
   * A path the user ctrl-clicked in a terminal. A file with local changes is answered with
   * its repository-relative path, which the renderer shows in the git tab; anything else is
   * handed to the OS here, where the filesystem actually is.
   */
  ipcMain.handle("shell:open-file", async (_event, projectId: string, rawPath: string): Promise<string | null> => {
    const repository = repositories.get(projectId);
    if (!repository) {
      return null;
    }
    const expanded =
      rawPath === "~" || rawPath.startsWith("~/") || rawPath.startsWith("~\\")
        ? path.join(os.homedir(), rawPath.slice(1))
        : rawPath;
    const root = repository.project.path;
    const resolved = path.isAbsolute(expanded) ? expanded : path.join(root, expanded);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      send("app:notice", { severity: "error", message: `Could not find file: ${rawPath}` });
      return null;
    }
    // git reports every path relative to the root with forward slashes, so match in that shape.
    const relative = path.relative(root, resolved).replace(/\\/g, "/");
    if (repository.getState().changes.some((change) => change.path === relative)) {
      return relative;
    }
    const error = await shell.openPath(resolved);
    if (error) {
      send("app:notice", { severity: "error", message: `Could not open file: ${rawPath} (${error})` });
    }
    return null;
  });

  /** A changed file shown in the OS file manager — the git tab's context menu. */
  ipcMain.handle("shell:reveal-file", (_event, projectId: string, filePath: string): void => {
    const repository = repositories.get(projectId);
    if (repository) {
      shell.showItemInFolder(path.join(repository.project.path, filePath));
    }
  });

  ipcMain.handle("files:write-temp", (_event, name: string, dataBase64: string): string => {
    return writeTempFile(name, Buffer.from(dataBase64, "base64"));
  });

  /** The clipboard's image as a file on disk, so its path can be typed into a CLI. */
  ipcMain.handle("clipboard:image-file", (): string | null => {
    const image = clipboard.readImage();
    return image.isEmpty() ? null : writeTempFile(`pasted-image-${Date.now()}.png`, image.toPNG());
  });
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#1f1f1f",
    show: false,
    // The project tabs live in the title bar, as in the reference views; the platform's
    // own window controls stay in place through the overlay.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    titleBarOverlay:
      // Height must match the .titlebar rule in the renderer, or the window controls and
      // the drag region disagree about where the title bar ends.
      process.platform === "darwin" ? undefined : { color: "#181818", symbolColor: "#cccccc", height: 35 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => {
    window = undefined;
  });

  // No application menu (the title bar is our own), so wire the devtools shortcuts by hand.
  window.webContents.on("before-input-event", (_event, input) => {
    const toggle =
      input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i");
    if (input.type === "keyDown" && toggle) {
      window?.webContents.toggleDevTools();
    }
  });

  void window.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  startEventLoopMonitor(path.join(app.getPath("userData"), "event-loop.log"));
  registerIpc();
  for (const project of store.list()) {
    openProject(project);
  }
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  sessions.disposeAll();
  repositories.disposeAll();
});
