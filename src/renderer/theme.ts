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
    // Everything xterm draws down the lane at the right edge, made invisible — a scrollbar has
    // no business beside a TUI (see styles.css), and the ruler is only there to keep FitAddon
    // from reserving room for one (see terminal-views.ts). Color rather than CSS is what does
    // it: both are xterm's own elements, redrawn as the buffer grows, and this is the value
    // they are painted with. Spelled `#00000000` and not `transparent`, since it goes through
    // xterm's color parser on the way to a stylesheet and a canvas.
    //
    // The theme layer's own scrollbar variables are deliberately not read here: they are for
    // the app's lists, where a slider is exactly what you want.
    scrollbarSliderBackground: "#00000000",
    scrollbarSliderHoverBackground: "#00000000",
    scrollbarSliderActiveBackground: "#00000000",
    // The ruler outlines itself on every frame whether or not a mark is in it, and this is the
    // color it uses (`_renderRulerOutline`). Left unset, xterm's default is light: a white line
    // down the right of every terminal.
    overviewRulerBorder: "#00000000"
  };

  for (const [key, cssVar] of Object.entries(ANSI_CSS_VARS)) {
    (theme as Record<string, string | undefined>)[key] = read(cssVar);
  }

  return theme;
}
