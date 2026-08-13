import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
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

function viewKey(projectId: string, tabId: string): string {
  return `${projectId} ${tabId}`;
}

window.meeseex.terminals.onOutput(({ projectId, tabId, data }) =>
  views.get(viewKey(projectId, tabId))?.term.write(data)
);

function isMac(): boolean {
  return navigator.platform.startsWith("Mac");
}

function isModifierHeld(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac() ? event.metaKey : event.ctrlKey;
}

/** What VS Code's own `terminal.integrated.fontSize` defaults to, per platform. */
function defaultFontSize(): number {
  return isMac() ? 12 : 14;
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
    overviewRuler: { width: 1 }
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  // CLIs that support "select to copy" report the selection back via OSC 52, which xterm
  // ignores without this addon — the CLI's copy would silently go nowhere.
  term.loadAddon(new ClipboardAddon());

  term.onData((data) => window.meeseex.terminals.input(projectId, tabId, data));

  term.attachCustomKeyEventHandler((event) => {
    // xterm can't tell Shift+Enter from plain Enter at the data level — both arrive as "\r".
    // Send the ESC+CR sequence agent TUIs read as "insert newline" instead. event.repeat is
    // skipped: flooding a CLI's escape-sequence parser with back-to-back ESC+CR hangs it.
    if (event.type === "keydown" && event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        window.meeseex.terminals.input(projectId, tabId, "\x1b\r");
      }
      return false;
    }
    // xterm treats Ctrl+V as the literal control character 0x16 and calls preventDefault()
    // on it, so the browser never fires its native paste event — paste explicitly instead.
    if (event.type === "keydown" && event.key.toLowerCase() === "v" && isModifierHeld(event) && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        void navigator.clipboard.readText().then((text) => term.paste(text));
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
  if (view.term.element?.parentElement !== container) {
    view.term.open(container);
  }
}

/** Refits the terminal to its container and reports the new size — this starts its process. */
export function fitTerminal(projectId: string, tabId: string): void {
  const view = views.get(viewKey(projectId, tabId));
  if (!view) {
    return;
  }
  view.fit.fit();
  window.meeseex.terminals.resize(projectId, tabId, view.term.cols, view.term.rows);
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
