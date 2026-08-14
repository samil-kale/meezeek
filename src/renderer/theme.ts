import type { ITheme } from "@xterm/xterm";

const ANSI_CSS_VARS: Record<string, string> = {
  black: "--vscode-terminal-ansiBlack",
  red: "--vscode-terminal-ansiRed",
  green: "--vscode-terminal-ansiGreen",
  yellow: "--vscode-terminal-ansiYellow",
  blue: "--vscode-terminal-ansiBlue",
  magenta: "--vscode-terminal-ansiMagenta",
  cyan: "--vscode-terminal-ansiCyan",
  white: "--vscode-terminal-ansiWhite",
  brightBlack: "--vscode-terminal-ansiBrightBlack",
  brightRed: "--vscode-terminal-ansiBrightRed",
  brightGreen: "--vscode-terminal-ansiBrightGreen",
  brightYellow: "--vscode-terminal-ansiBrightYellow",
  brightBlue: "--vscode-terminal-ansiBrightBlue",
  brightMagenta: "--vscode-terminal-ansiBrightMagenta",
  brightCyan: "--vscode-terminal-ansiBrightCyan",
  brightWhite: "--vscode-terminal-ansiBrightWhite"
};

/**
 * xterm renders on canvas and needs resolved color values, not CSS var() references, so the
 * --vscode-* custom properties of the theme layer are read out and turned into a plain
 * xterm ITheme.
 */
export function buildXtermTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string): string | undefined => styles.getPropertyValue(name).trim() || undefined;

  const theme: ITheme = {
    background: read("--vscode-terminal-background") ?? read("--vscode-editor-background"),
    foreground: read("--vscode-terminal-foreground") ?? read("--vscode-editor-foreground"),
    // Everything xterm draws down the right-hand lane, made invisible. `#00000000` rather than
    // the word: these go through xterm's own color parser before they reach CSS or a canvas.
    //
    // The scrollbar has no business beside a TUI (see styles.css), and hiding it in CSS does
    // not settle it — the element is xterm's own and gets rebuilt as the buffer grows, and it
    // carries this color. The theme layer's own scrollbar variables are deliberately not read
    // here: they are for the app's lists, where a slider is exactly what you want.
    scrollbarSliderBackground: "#00000000",
    scrollbarSliderHoverBackground: "#00000000",
    scrollbarSliderActiveBackground: "#00000000",
    // And the line the overview ruler paints down its left edge, unconditionally, whether or
    // not anything ever put a mark in it (`_renderRulerOutline`). meeseek asks for that ruler
    // only to stop FitAddon reserving 14px for it — see terminal-views.ts — so its outline is
    // a white strip beside every terminal and nothing else.
    overviewRulerBorder: "#00000000"
  };

  for (const [key, cssVar] of Object.entries(ANSI_CSS_VARS)) {
    (theme as Record<string, string | undefined>)[key] = read(cssVar);
  }

  return theme;
}
