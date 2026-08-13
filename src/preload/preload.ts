import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { MeeseekApi, Unsubscribe } from "../shared/api";

function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const api: MeeseekApi = {
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    add: () => ipcRenderer.invoke("projects:add"),
    remove: (projectId) => ipcRenderer.invoke("projects:remove", projectId),
    reorder: (projectIds) => ipcRenderer.invoke("projects:reorder", projectIds),
    setConsoleAgent: (projectId, agentId) => ipcRenderer.invoke("projects:set-console-agent", projectId, agentId)
  },
  repository: {
    state: (projectId) => ipcRenderer.invoke("repo:state", projectId),
    refresh: (projectId) => ipcRenderer.invoke("repo:refresh", projectId),
    checkout: (projectId, target) => ipcRenderer.invoke("repo:checkout", projectId, target),
    fetch: (projectId) => ipcRenderer.invoke("repo:fetch", projectId),
    pull: (projectId) => ipcRenderer.invoke("repo:pull", projectId),
    push: (projectId) => ipcRenderer.invoke("repo:push", projectId),
    discard: (projectId, paths) => ipcRenderer.invoke("repo:discard", projectId, paths),
    ignore: (projectId, filePath, scope) => ipcRenderer.invoke("repo:ignore", projectId, filePath, scope),
    diff: (projectId, filePath, options) => ipcRenderer.invoke("repo:diff", projectId, filePath, options),
    fileLines: (projectId, filePath, from, to) =>
      ipcRenderer.invoke("repo:file-lines", projectId, filePath, from, to),
    onState: (listener) => subscribe("repo:state-changed", listener)
  },
  actions: {
    list: (projectId) => ipcRenderer.invoke("actions:list", projectId),
    save: (projectId, actions) => ipcRenderer.invoke("actions:save", projectId, actions),
    run: (projectId, command) => ipcRenderer.invoke("actions:run", projectId, command),
    suggest: (projectId) => ipcRenderer.invoke("actions:suggest", projectId)
  },
  terminals: {
    list: (projectId) => ipcRenderer.invoke("terminal:list", projectId),
    create: (projectId, agentId, asConsole) => ipcRenderer.invoke("terminal:create", projectId, agentId, asConsole),
    close: (projectId, tabIds) => ipcRenderer.invoke("terminal:close", projectId, tabIds),
    rename: (projectId, tabId, title) => ipcRenderer.invoke("terminal:rename", projectId, tabId, title),
    input: (projectId, tabId, data) => ipcRenderer.send("terminal:input", projectId, tabId, data),
    resize: (projectId, tabId, cols, rows) => ipcRenderer.send("terminal:resize", projectId, tabId, cols, rows),
    resolveUrl: (projectId, tabId, fragment) =>
      ipcRenderer.invoke("terminal:resolve-url", projectId, tabId, fragment),
    onTabs: (listener) => subscribe("terminal:tabs", listener),
    onOutput: (listener) => subscribe("terminal:output", listener),
    onStatus: (listener) => subscribe("terminal:status", listener),
    onStartupProgress: (listener) => subscribe("terminal:startup-progress", listener),
    starting: (projectId) => ipcRenderer.invoke("terminal:starting", projectId)
  },
  agents: {
    list: () => ipcRenderer.invoke("agents:list")
  },
  files: {
    // Electron 32 removed the non-standard File.path in favour of this; it has to run here
    // in the preload, since contextIsolation keeps the renderer out of electron's modules.
    pathOf: (file) => webUtils.getPathForFile(file),
    writeTemp: (name, dataBase64) => ipcRenderer.invoke("files:write-temp", name, dataBase64),
    clipboardImage: () => ipcRenderer.invoke("clipboard:image-file")
  },
  shell: {
    openUrl: (url) => ipcRenderer.invoke("shell:open-url", url),
    openFile: (projectId, filePath) => ipcRenderer.invoke("shell:open-file", projectId, filePath),
    revealFile: (projectId, filePath) => ipcRenderer.invoke("shell:reveal-file", projectId, filePath)
  },
  onNotice: (listener) => subscribe("app:notice", listener)
};

contextBridge.exposeInMainWorld("meeseek", api);
