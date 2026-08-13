import * as path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { listAgents } from "../agents";
import type {
  AgentId,
  CheckoutResult,
  CheckoutTarget,
  FileDiff,
  Project,
  RepositoryState,
  TerminalDescriptor,
  TerminalStatus
} from "../shared/types";
import { resolveRoot } from "./git";
import { ProjectStore } from "./projects";
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
const repositories = new RepositoryManager((projectId, state) => send("repo:state-changed", { projectId, state }));
const sessions = new SessionManagerRegistry({
  onTabs: (projectId, tabs) => send("terminal:tabs", { projectId, tabs }),
  onOutput: queueOutput,
  onStatus: (projectId, tabId, status: TerminalStatus) => send("terminal:status", { projectId, tabId, status }),
  onNotice: (message) => send("app:notice", { message })
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

  ipcMain.handle("repo:checkout", async (_event, projectId: string, target: CheckoutTarget): Promise<CheckoutResult> => {
    const repository = repositories.get(projectId);
    if (!repository) {
      return { ok: false, error: MISSING_REPOSITORY.error };
    }
    return repository.checkout(target);
  });

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
    sessions.get(projectId)?.write(tabId, data);
  });

  ipcMain.on("terminal:resize", (_event, projectId: string, tabId: string, cols: number, rows: number) => {
    sessions.get(projectId)?.handleResize(tabId, cols, rows);
  });

  ipcMain.handle("agents:list", () => listAgents());
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
      process.platform === "darwin" ? undefined : { color: "#181818", symbolColor: "#cccccc", height: 40 },
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
