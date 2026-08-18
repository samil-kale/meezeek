import { buildMonacoColors } from "./theme";
import { highlighter, loadGrammar, THEME } from "./diff-highlight";
import type { HighlighterCore } from "shiki/core";

/**
 * monaco-editor's own "editor.main" pulls in ~80 Monarch languages plus full CSS/HTML/JSON/
 * TypeScript language services, each wanting a worker of its own — everything `monaco-core.ts`
 * leaves out on purpose, since colouring goes through the same shiki instance the diff view uses
 * instead (`@shikijs/monaco`). Both this module's dynamic import and the language services it
 * would otherwise pull in stay unevaluated until an editor is actually opened.
 */
export type Monaco = typeof import("./monaco-core");

let monacoPromise: Promise<Monaco> | undefined;

/** Loads monaco once, sharing the promise across every `CodeEditor` mount. */
export function loadMonaco(): Promise<Monaco> {
  if (!monacoPromise) {
    // Must be set before the first editor is created, and only once — later assignments would
    // race an already-starting worker. `getWorker` rather than `getWorkerUrl`: a recent monaco
    // build makes a module worker from the latter, which can fail to start from a `file://`
    // origin; a classic worker from `getWorker` does not.
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker: () => new Worker("./editor.worker.js")
    };
    monacoPromise = import("./monaco-core");
  }
  return monacoPromise;
}

/** One language registered at a time is enough for a re-run of `shikiToMonaco` below — see it. */
const registered = new Set<string>();

/**
 * Wires a language into monaco through shiki, so a token reads the same color here as in the
 * diff view: `shikiToMonaco` only sees languages loaded into shiki *and* registered with monaco
 * at the moment it runs, so it has to run again after every newly loaded grammar — which also
 * redefines the theme from shiki's own colors, wiping `applyChrome`'s override. Hence the fixed
 * order below, every time.
 */
export async function ensureLanguage(monaco: Monaco, language: string): Promise<void> {
  const shiki = await highlighter();
  await loadGrammar(shiki, language);
  if (!registered.has(language)) {
    monaco.languages.register({ id: language });
    registered.add(language);
  }
  const { shikiToMonaco } = await import("@shikijs/monaco");
  // @shikijs/monaco types itself against the `monaco-editor-core` package rather than
  // `monaco-editor`'s own re-export of the identical API — structurally the same shape, but TS
  // sees two different nominal origins for the same interfaces.
  shikiToMonaco(shiki, monaco as never);
  applyChrome(monaco, shiki);
}

/**
 * Layers tet's own `--vscode-*` chrome colors on top of shiki's token colors. `defineTheme` only
 * inherits from monaco's own built-in bases (`vs-dark`, ...), not from another custom theme, so
 * "layering" means rebuilding the same rules shiki already computed and adding colors — the
 * exact translation `@shikijs/monaco` does internally, exposed as `textmateThemeToMonacoTheme`.
 * Without this the editor stays shiki's dark-plus chrome (`#1e1e1e`), not tet's (`#1f1f1f`).
 */
function applyChrome(monaco: Monaco, shiki: HighlighterCore): void {
  void import("@shikijs/monaco").then(({ textmateThemeToMonacoTheme }) => {
    const base = textmateThemeToMonacoTheme(shiki.getTheme(THEME));
    monaco.editor.defineTheme(THEME, { ...base, colors: { ...base.colors, ...buildMonacoColors() } });
    monaco.editor.setTheme(THEME);
  });
}

/**
 * Options shared by every editor, tuned so Diff and Edit read as one tool rather than two:
 * matching font metrics (`.diff-body`'s own 13px/18px), no bracket-pair colors (the diff has
 * none), and a plain quick-edit surface — no suggestions, no sticky scroll, no minimap. Easy to
 * turn back on individually if that turns out to be missed.
 */
export function editorOptions(fontFamily: string): Record<string, unknown> {
  return {
    theme: THEME,
    fontFamily,
    fontSize: 13,
    lineHeight: 18,
    automaticLayout: true,
    minimap: { enabled: false },
    stickyScroll: { enabled: false },
    bracketPairColorization: { enabled: false },
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    renderLineHighlight: "line",
    scrollBeyondLastLine: false,
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    quickSuggestions: false,
    wordBasedSuggestions: "off"
  };
}
