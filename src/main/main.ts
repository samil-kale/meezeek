import * as path from "node:path";
import { app, BrowserWindow, Menu } from "electron";
import { AccountStore } from "../providers/accounts";
import type { Project, TerminalOutput, TerminalStatus } from "../shared/types";
import { countActivity, startEventLoopMonitor } from "./event-loop-monitor";
import { startGitProcess, stopGitProcess } from "./git-client";
import { registerIpc } from "./ipc";
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
const accounts = new AccountStore(app.getPath("userData"));
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

function openProject(project: Project): void {
  repositories.open(project);
  sessions.open(project);
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#1f1f1f",
    show: false,
    // What the taskbar and the window itself show. The same file the title bar draws, so
    // there is one icon to replace rather than two that can drift apart.
    icon: path.join(__dirname, "icon.png"),
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
  // Only when NODE_DEBUG asks for it; see startEventLoopMonitor.
  startEventLoopMonitor(path.join(app.getPath("userData"), "event-loop.log"));
  // Up front rather than on the first repository: forking it costs a moment, and every
  // project that opens below is about to ask it something.
  startGitProcess();
  registerIpc({ store, accounts, repositories, sessions, send, openProject });
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
