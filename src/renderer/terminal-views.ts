import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { createFileLinkProvider } from "./links/file-links";
import type { WrappedUrlResolver } from "./links/link-provider";
import { createUrlLinkProvider } from "./links/url-links";
import { isMac, isModifierHeld } from "./platform";
import { buildXtermTheme } from "./theme";

interface TerminalView {
  term: Terminal;
  fit: FitAddon;
}

/**
 * xterm instances live outside React: terminal output is written straight to them instead of
 * going through component state, and they survive view and project switches unchanged.
 * Tab ids are only unique within their project, so views are keyed by both.
 */
const views = new Map<string, TerminalView>();

/**
 * Per project, what to do when a ctrl-clicked file turns out to have local changes: the
 * pane shows it in its git tab. Registered by the pane itself, which owns that selection.
 */
const revealHandlers = new Map<string, (path: string) => void>();

function viewKey(projectId: string, tabId: string): string {
  return `${projectId} ${tabId}`;
}

window.meeseek.terminals.onOutput(({ projectId, tabId, data }) =>
  views.get(viewKey(projectId, tabId))?.term.write(data)
);

export function setRevealHandler(projectId: string, handler: (path: string) => void): () => void {
  revealHandlers.set(projectId, handler);
  return () => revealHandlers.delete(projectId);
}

/** What VS Code's own `terminal.integrated.fontSize` defaults to, per platform. */
function defaultFontSize(): number {
  return isMac() ? 12 : 14;
}

function openUrl(url: string): void {
  void window.meeseek.shell.openUrl(url);
}

function openFile(projectId: string, filePath: string): void {
  void window.meeseek.shell.openFile(projectId, filePath).then((changedPath) => {
    if (changedPath) {
      revealHandlers.get(projectId)?.(changedPath);
    }
  });
}

/**
 * How long a "the agent knows no such url" answer is trusted. Not forever: the url may
 * simply not have been persisted yet when it was first asked about — a message still being
 * written is the normal case for a link that just appeared. Kept short because a retry is
 * cheap: it only fires while the pointer sits on that very link, the in-flight set folds
 * the per-render calls into one request, and the host answers from a local http call.
 */
const NEGATIVE_TTL_MS = 2000;

/**
 * Answers to resolveUrl, keyed by the tab and fragment asked about; null means the host has
 * no url for it and it must not be asked again. Only grows by one entry per distinct url the
 * user holds the modifier over, so it needs no eviction.
 */
const resolvedUrls = new Map<string, string | null>();
const negativeAnswers = new Map<string, number>();
const pendingUrlRequests = new Set<string>();

function createWrappedUrlResolver(projectId: string, tabId: string): WrappedUrlResolver {
  const cacheKey = (fragment: string): string => `${viewKey(projectId, tabId)} ${fragment}`;
  return {
    lookup: (fragment) => {
      const key = cacheKey(fragment);
      const answeredNoAt = negativeAnswers.get(key);
      if (answeredNoAt !== undefined && Date.now() - answeredNoAt > NEGATIVE_TTL_MS) {
        negativeAnswers.delete(key);
        resolvedUrls.delete(key);
      }
      return resolvedUrls.get(key);
    },
    request: (fragment) => {
      // provideLinks runs per render, so this is called until the answer lands — the
      // in-flight set is what keeps that down to a single request.
      const key = cacheKey(fragment);
      if (pendingUrlRequests.has(key)) {
        return;
      }
      pendingUrlRequests.add(key);
      void window.meeseek.terminals.resolveUrl(projectId, tabId, fragment).then((url) => {
        pendingUrlRequests.delete(key);
        resolvedUrls.set(key, url);
        if (url === null) {
          negativeAnswers.set(key, Date.now());
        }
      });
    }
  };
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Types the dropped files' paths, the way a hand-typed reference would arrive. A file
 * dragged in from the filesystem has a real path; one dragged out of a browser carries only
 * its content, and gets saved to a temp file first so there is a path to name at all.
 */
async function pasteDroppedFiles(term: Terminal, files: File[]): Promise<void> {
  const paths: string[] = [];
  for (const file of files) {
    const existing = window.meeseek.files.pathOf(file);
    if (existing) {
      paths.push(existing);
      continue;
    }
    paths.push(await window.meeseek.files.writeTemp(file.name, toBase64(await file.arrayBuffer())));
  }
  if (paths.length > 0) {
    // Through term.paste, like clipboard text, so it can't be misread as individual
    // keystrokes (e.g. vim-mode commands) by whatever input mode the CLI is in.
    term.paste(`${paths.join(" ")} `);
  }
}

/** A copied screenshot has no path either — same temp-file trick, from the clipboard. */
async function pasteClipboardImage(term: Terminal): Promise<boolean> {
  const file = await window.meeseek.files.clipboardImage();
  if (file === null) {
    return false;
  }
  term.paste(`${file} `);
  return true;
}

async function pasteClipboard(term: Terminal): Promise<void> {
  if (!(await pasteClipboardImage(term))) {
    term.paste(await navigator.clipboard.readText());
  }
}

function createView(projectId: string, tabId: string): TerminalView {
  const fontFamily =
    getComputedStyle(document.documentElement).getPropertyValue("--vscode-editor-font-family").trim() || "monospace";

  const term = new Terminal({
    fontFamily,
    fontSize: defaultFontSize(),
    theme: buildXtermTheme(),
    scrollback: 4000,
    // The scrollbar is hidden in CSS, but FitAddon's column math still reserves pixel width
    // for it through `options.overviewRuler?.width || 14` — leaving a dead gap on the right.
    // `0` won't work (`0 || 14` is 14), so 1px is the smallest reservation possible.
    overviewRuler: { width: 1 },
    // Governs OSC 8 hyperlinks the CLI itself may emit (as opposed to plain URL text, which
    // the url link provider below matches by regex). Without this, xterm's built-in OSC 8
    // handling wins priority over our own link providers and opens links with window.open.
    linkHandler: {
      activate(event, text) {
        if (isModifierHeld(event)) {
          openUrl(text);
        }
      }
    }
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  // CLIs that support "select to copy" report the selection back via OSC 52, which xterm
  // ignores without this addon — the CLI's copy would silently go nowhere.
  term.loadAddon(new ClipboardAddon());
  term.registerLinkProvider(createUrlLinkProvider(term, openUrl, createWrappedUrlResolver(projectId, tabId)));
  term.registerLinkProvider(createFileLinkProvider(term, (filePath) => openFile(projectId, filePath)));

  term.onData((data) => window.meeseek.terminals.input(projectId, tabId, data));

  term.attachCustomKeyEventHandler((event) => {
    // xterm can't tell Shift+Enter from plain Enter at the data level — both arrive as "\r".
    // Send the ESC+CR sequence agent TUIs read as "insert newline" instead. event.repeat is
    // skipped: flooding a CLI's escape-sequence parser with back-to-back ESC+CR hangs it.
    if (event.type === "keydown" && event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        window.meeseek.terminals.input(projectId, tabId, "\x1b\r");
      }
      return false;
    }
    // xterm treats Ctrl+V as the literal control character 0x16 and calls preventDefault()
    // on it, so the browser never fires its native paste event — paste explicitly instead.
    if (event.type === "keydown" && event.key.toLowerCase() === "v" && isModifierHeld(event) && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        void pasteClipboard(term);
      }
      return false;
    }
    return true;
  });

  const view: TerminalView = { term, fit };
  views.set(viewKey(projectId, tabId), view);
  return view;
}

export function attachTerminal(projectId: string, tabId: string, container: HTMLElement): void {
  const view = views.get(viewKey(projectId, tabId)) ?? createView(projectId, tabId);
  if (view.term.element?.parentElement === container) {
    return;
  }
  view.term.open(container);

  // On the container rather than the document: several terminals are mounted at once, and a
  // drop belongs to the one it landed on.
  container.addEventListener("dragover", (event) => event.preventDefault());
  container.addEventListener("drop", (event) => {
    event.preventDefault();
    void pasteDroppedFiles(view.term, Array.from(event.dataTransfer?.files ?? []));
  });
  container.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    // Only the image case: both CLIs already act on the right mouse button themselves
    // through xterm's mouse reporting (Claude Code pastes, opencode copies the selection),
    // and handling plain text here too would risk clobbering an opencode copy. No CLI can
    // paste an image out of its own right-click handling, so that part stays ours.
    void pasteClipboardImage(view.term);
  });
}

/** Refits the terminal to its container and reports the new size — this starts its process. */
export function fitTerminal(projectId: string, tabId: string): void {
  const view = views.get(viewKey(projectId, tabId));
  if (!view) {
    return;
  }
  view.fit.fit();
  window.meeseek.terminals.resize(projectId, tabId, view.term.cols, view.term.rows);
}

export function focusTerminal(projectId: string, tabId: string): void {
  views.get(viewKey(projectId, tabId))?.term.focus();
}

export function disposeTerminal(projectId: string, tabId: string): void {
  const key = viewKey(projectId, tabId);
  const view = views.get(key);
  if (!view) {
    return;
  }
  views.delete(key);
  view.term.dispose();
}
