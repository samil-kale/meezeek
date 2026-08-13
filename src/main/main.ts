import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from "electron";
import { AGENTS, listAgents } from "../agents";
import type { AgentDefinition } from "../agents/agent";
import { mergeActions, readActions, runAction, suggestActions, suggestQuestion, writeActions } from "./actions";
import { checkAgentInstalled } from "./terminal-session";
import type {
  AgentId,
  CheckoutTarget,
  DiffOptions,
  FileDiff,
  GitActionResult,
  Project,
  RepositoryState,
  TerminalDescriptor,
  TerminalOutput,
  TerminalStatus
} from "../shared/types";
import { git, startGitProcess, stopGitProcess } from "./git-client";
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

const pendingOutput = new Map<string, TerminalOutput>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/** All of it in one message: see TerminalOutput for why it is not one per tab. */
function flushOutput(): void {
  flushTimer = undefined;
  if (pendingOutput.size > 0) {
    send("terminal:output", [...pendingOutput.values()]);
    pendingOutput.clear();
  }
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
  ahead: 0,
  behind: 0,
  stashes: [],
  tags: [],
  localBranches: [],
  remotes: [],
  changes: [],
  error: "Project not found"
};

function openProject(project: Project): void {
  repositories.open(project);
  sessions.open(project);
}

/**
 * The first installed agent that can be asked a question without a terminal, in the order
 * `listAgents` reports them. The shell has no `askArgs` and is skipped by that alone.
 */
async function findAskableAgent(cwd: string): Promise<{ executable: string; agent: AgentDefinition } | undefined> {
  for (const agent of AGENTS) {
    if (!agent.askArgs || !agent.versionArgs) {
      continue;
    }
    const executable = agent.executable();
    if (await checkAgentInstalled(executable, agent.versionArgs, cwd)) {
      return { executable, agent };
    }
  }
  return undefined;
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
    const project = store.add((await git.resolveRoot(directory).catch(() => undefined)) ?? directory);
    openProject(project);
    return project;
  });

  ipcMain.handle("projects:reorder", (_event, projectIds: string[]): void => store.reorder(projectIds));

  ipcMain.handle("projects:set-console-agent", (_event, projectId: string, agentId: AgentId): void => {
    store.setConsoleAgent(projectId, agentId);
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

  ipcMain.handle("repo:checkout", async (_event, projectId: string, target: CheckoutTarget): Promise<GitActionResult> => {
    const repository = repositories.get(projectId);
    if (!repository) {
      return { ok: false, error: MISSING_REPOSITORY.error };
    }
    return repository.checkout(target);
  });

  /** The three that reach a remote; each takes nothing but the project. */
  for (const command of ["fetch", "pull", "push"] as const) {
    ipcMain.handle(`repo:${command}`, async (_event, projectId: string): Promise<GitActionResult> => {
      const repository = repositories.get(projectId);
      return repository ? repository[command]() : { ok: false, error: MISSING_REPOSITORY.error };
    });
  }

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

  ipcMain.handle(
    "repo:diff",
    async (_event, projectId: string, filePath: string, options: DiffOptions): Promise<FileDiff> => {
      const repository = repositories.get(projectId);
      if (!repository) {
        return { path: filePath, lines: [], binary: false, truncated: false, error: MISSING_REPOSITORY.error };
      }
      return repository.diff(filePath, options);
    }
  );

  ipcMain.handle(
    "repo:file-lines",
    async (_event, projectId: string, filePath: string, from: number, to: number): Promise<string[]> => {
      return (await repositories.get(projectId)?.fileLines(filePath, from, to)) ?? [];
    }
  );

  ipcMain.handle("actions:list", async (_event, projectId: string): Promise<string[] | null> => {
    const project = store.list().find((candidate) => candidate.id === projectId);
    return project ? readActions(project.path) : [];
  });

  ipcMain.handle("actions:save", async (_event, projectId: string, actions: string[]): Promise<void> => {
    const project = store.list().find((candidate) => candidate.id === projectId);
    if (!project) {
      return;
    }
    try {
      await writeActions(project.path, actions);
    } catch (error) {
      send("app:notice", { severity: "error", message: `Could not save actions: ${String(error)}` });
    }
  });

  /**
   * Runs one and reports how it went. Nothing is streamed while it runs: an action is started
   * and then waited on, and the answer is a single notice either way.
   */
  ipcMain.handle("actions:run", async (_event, projectId: string, command: string): Promise<void> => {
    const project = store.list().find((candidate) => candidate.id === projectId);
    if (!project) {
      return;
    }
    const result = await runAction(project.path, command);
    send("app:notice", {
      severity: result.code === 0 ? "info" : "error",
      message:
        result.code === 0
          ? `${command} finished`
          : `${command} exited with ${result.code}${result.output ? `\n${result.output}` : ""}`
    });
  });

  /**
   * The wand: asks whichever agent is installed what this project can run, and adds what it
   * names to the list. Whatever it gets wrong is one right-click away from being deleted,
   * which is why its answer goes straight in rather than through a review step.
   */
  ipcMain.handle("actions:suggest", async (_event, projectId: string): Promise<string[]> => {
    const project = store.list().find((candidate) => candidate.id === projectId);
    if (!project) {
      return [];
    }
    const askable = await findAskableAgent(project.path);
    if (!askable) {
      send("app:notice", {
        severity: "warning",
        message: "Neither claude nor opencode was found — install one to have it find the commands for you."
      });
      return [];
    }
    const { executable, agent } = askable;
    try {
      const found = await suggestActions(project.path, executable, agent.askArgs!(suggestQuestion()));
      const existing = (await readActions(project.path)) ?? [];
      const merged = mergeActions(existing, found);
      const added = merged.length - existing.length;
      if (added > 0) {
        await writeActions(project.path, merged);
      }
      send("app:notice", {
        severity: "info",
        message: added > 0 ? `Added ${added} actions` : "No new commands found"
      });
      return merged;
    } catch (error) {
      send("app:notice", { severity: "error", message: `Could not read the project: ${String(error)}` });
      return [];
    } finally {
      // Whether it answered or not, it may have persisted a session on the way — and one
      // nobody opened has no business showing up as a tab after the next restart.
      await agent.cleanupAsk?.(executable, project.path).catch(() => undefined);
    }
  });

  ipcMain.handle("terminal:list", (_event, projectId: string): TerminalDescriptor[] => {
    return sessions.get(projectId)?.snapshot() ?? [];
  });

  ipcMain.handle(
    "terminal:create",
    (_event, projectId: string, agentId: AgentId, asConsole?: boolean): TerminalDescriptor => {
      const manager = sessions.get(projectId);
      if (!manager) {
        throw new Error(`Unknown project: ${projectId}`);
      }
      return manager.createTab(agentId, asConsole);
    }
  );

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
  // Up front rather than on the first repository: forking it costs a moment, and every
  // project that opens below is about to ask it something.
  startGitProcess();
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
  stopGitProcess();
});
