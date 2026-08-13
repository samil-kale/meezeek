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
 */
const views = new Map<string, TerminalView>();

window.meeseex.terminals.onOutput(({ id, data }) => views.get(id)?.term.write(data));

function isModifierHeld(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return navigator.platform.startsWith("Mac") ? event.metaKey : event.ctrlKey;
}

function createView(id: string): TerminalView {
  const fontFamily =
    getComputedStyle(document.documentElement).getPropertyValue("--vscode-editor-font-family").trim() || "monospace";

  const term = new Terminal({
    fontFamily,
    fontSize: 13,
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

  term.onData((data) => window.meeseex.terminals.input(id, data));

  term.attachCustomKeyEventHandler((event) => {
    // xterm can't tell Shift+Enter from plain Enter at the data level — both arrive as "\r".
    // Send the ESC+CR sequence agent TUIs read as "insert newline" instead. event.repeat is
    // skipped: flooding a CLI's escape-sequence parser with back-to-back ESC+CR hangs it.
    if (event.type === "keydown" && event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        window.meeseex.terminals.input(id, "\x1b\r");
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
  views.set(id, view);
  return view;
}

export function attachTerminal(id: string, container: HTMLElement): void {
  const view = views.get(id) ?? createView(id);
  if (view.term.element?.parentElement !== container) {
    view.term.open(container);
  }
}

/** Refits the terminal to its container and reports the new size — this starts its process. */
export function fitTerminal(id: string): void {
  const view = views.get(id);
  if (!view) {
    return;
  }
  view.fit.fit();
  window.meeseex.terminals.resize(id, view.term.cols, view.term.rows);
}

export function focusTerminal(id: string): void {
  views.get(id)?.term.focus();
}

export function disposeTerminal(id: string): void {
  const view = views.get(id);
  if (!view) {
    return;
  }
  views.delete(id);
  view.term.dispose();
}
