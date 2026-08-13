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
    scrollbarSliderBackground: read("--vscode-scrollbarSlider-background"),
    scrollbarSliderHoverBackground: read("--vscode-scrollbarSlider-hoverBackground"),
    scrollbarSliderActiveBackground: read("--vscode-scrollbarSlider-activeBackground")
  };

  for (const [key, cssVar] of Object.entries(ANSI_CSS_VARS)) {
    (theme as Record<string, string | undefined>)[key] = read(cssVar);
  }

  return theme;
}
