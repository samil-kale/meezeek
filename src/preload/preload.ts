import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { MeezeekApi, Unsubscribe } from "../shared/api";

function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const api: MeezeekApi = {
  startup: {
    check: () => ipcRenderer.invoke("startup:check"),
    quit: () => ipcRenderer.send("startup:quit")
  },
  app: {
    info: () => ipcRenderer.invoke("app:info")
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (settings) => ipcRenderer.invoke("settings:save", settings)
  },
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    pickDirectory: (title, defaultPath) => ipcRenderer.invoke("projects:pick-directory", title, defaultPath),
    open: (directory) => ipcRenderer.invoke("projects:open-path", directory),
    clone: (url, directory, name, accountId) => ipcRenderer.invoke("projects:clone", url, directory, name, accountId),
    create: (directory, name) => ipcRenderer.invoke("projects:create", directory, name),
    remove: (projectId) => ipcRenderer.invoke("projects:remove", projectId),
    reorder: (projectIds) => ipcRenderer.invoke("projects:reorder", projectIds)
  },
  providers: {
    accounts: () => ipcRenderer.invoke("providers:accounts"),
    addAccount: (provider, host, token) => ipcRenderer.invoke("providers:add-account", provider, host, token),
    removeAccount: (accountId) => ipcRenderer.invoke("providers:remove-account", accountId),
    setNamespace: (accountId, namespace) => ipcRenderer.invoke("providers:set-namespace", accountId, namespace),
    repos: (accountId) => ipcRenderer.invoke("providers:repos", accountId)
  },
  repository: {
    state: (projectId) => ipcRenderer.invoke("repo:state", projectId),
    refresh: (projectId) => ipcRenderer.invoke("repo:refresh", projectId),
    checkout: (projectId, target) => ipcRenderer.invoke("repo:checkout", projectId, target),
    fetch: (projectId) => ipcRenderer.invoke("repo:fetch", projectId),
    pull: (projectId) => ipcRenderer.invoke("repo:pull", projectId),
    push: (projectId) => ipcRenderer.invoke("repo:push", projectId),
    setRemoteUrl: (projectId, remote, url) => ipcRenderer.invoke("repo:set-remote-url", projectId, remote, url),
    createBranch: (projectId, name, startPoint) =>
      ipcRenderer.invoke("repo:create-branch", projectId, name, startPoint),
    renameBranch: (projectId, from, to) => ipcRenderer.invoke("repo:rename-branch", projectId, from, to),
    deleteBranch: (projectId, name, onRemote) =>
      ipcRenderer.invoke("repo:delete-branch", projectId, name, onRemote),
    merge: (projectId, ref) => ipcRenderer.invoke("repo:merge", projectId, ref),
    rebase: (projectId, ref) => ipcRenderer.invoke("repo:rebase", projectId, ref),
    abort: (projectId) => ipcRenderer.invoke("repo:abort", projectId),
    createTag: (projectId, name, target, message) =>
      ipcRenderer.invoke("repo:create-tag", projectId, name, target, message),
    pushTag: (projectId, name) => ipcRenderer.invoke("repo:push-tag", projectId, name),
    deleteTag: (projectId, name, onRemote) => ipcRenderer.invoke("repo:delete-tag", projectId, name, onRemote),
    checkoutTag: (projectId, name) => ipcRenderer.invoke("repo:checkout-tag", projectId, name),
    stashPush: (projectId, message) => ipcRenderer.invoke("repo:stash-push", projectId, message),
    stash: (projectId, command, ref) => ipcRenderer.invoke("repo:stash", projectId, command, ref),
    discard: (projectId, paths) => ipcRenderer.invoke("repo:discard", projectId, paths),
    ignore: (projectId, filePath, scope) => ipcRenderer.invoke("repo:ignore", projectId, filePath, scope),
    diff: (projectId, filePath, options) => ipcRenderer.invoke("repo:diff", projectId, filePath, options),
    fileLines: (projectId, filePath, from, to) =>
      ipcRenderer.invoke("repo:file-lines", projectId, filePath, from, to),
    onState: (listener) => subscribe("repo:state-changed", listener)
  },
  commands: {
    list: (projectId) => ipcRenderer.invoke("commands:list", projectId),
    save: (projectId, commands) => ipcRenderer.invoke("commands:save", projectId, commands),
    run: (projectId, command) => ipcRenderer.invoke("commands:run", projectId, command),
    suggest: (projectId) => ipcRenderer.invoke("commands:suggest", projectId)
  },
  terminals: {
    list: (projectId) => ipcRenderer.invoke("terminal:list", projectId),
    create: (projectId, agentId) => ipcRenderer.invoke("terminal:create", projectId, agentId),
    close: (projectId, tabIds) => ipcRenderer.invoke("terminal:close", projectId, tabIds),
    rename: (projectId, tabId, title) => ipcRenderer.invoke("terminal:rename", projectId, tabId, title),
    seen: (projectId, tabId) => ipcRenderer.send("terminal:seen", projectId, tabId),
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
    revealFile: (projectId, filePath) => ipcRenderer.invoke("shell:reveal-file", projectId, filePath),
    openFileExternally: (projectId, filePath) =>
      ipcRenderer.invoke("shell:open-file-externally", projectId, filePath),
    openProject: (projectId) => ipcRenderer.invoke("shell:open-project", projectId)
  },
  onNotice: (listener) => subscribe("app:notice", listener)
};

contextBridge.exposeInMainWorld("meezeek", api);
