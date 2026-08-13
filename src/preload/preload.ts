import { contextBridge, ipcRenderer } from "electron";
import type { MeeseexApi, Unsubscribe } from "../shared/api";

function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const api: MeeseexApi = {
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    add: () => ipcRenderer.invoke("projects:add"),
    remove: (projectId) => ipcRenderer.invoke("projects:remove", projectId)
  },
  repository: {
    state: (projectId) => ipcRenderer.invoke("repo:state", projectId),
    refresh: (projectId) => ipcRenderer.invoke("repo:refresh", projectId),
    checkout: (projectId, target) => ipcRenderer.invoke("repo:checkout", projectId, target),
    diff: (projectId, filePath) => ipcRenderer.invoke("repo:diff", projectId, filePath),
    onState: (listener) => subscribe("repo:state-changed", listener)
  },
  terminals: {
    list: (projectId) => ipcRenderer.invoke("terminal:list", projectId),
    create: (projectId, agentId) => ipcRenderer.invoke("terminal:create", projectId, agentId),
    close: (projectId, tabIds) => ipcRenderer.invoke("terminal:close", projectId, tabIds),
    rename: (projectId, tabId, title) => ipcRenderer.invoke("terminal:rename", projectId, tabId, title),
    input: (projectId, tabId, data) => ipcRenderer.send("terminal:input", projectId, tabId, data),
    resize: (projectId, tabId, cols, rows) => ipcRenderer.send("terminal:resize", projectId, tabId, cols, rows),
    onTabs: (listener) => subscribe("terminal:tabs", listener),
    onOutput: (listener) => subscribe("terminal:output", listener),
    onStatus: (listener) => subscribe("terminal:status", listener)
  },
  agents: {
    list: () => ipcRenderer.invoke("agents:list")
  },
  onNotice: (listener) => subscribe("app:notice", listener)
};

contextBridge.exposeInMainWorld("meeseex", api);
