import type { ITheme } from "@xterm/xterm";
import type { AgentId } from "../shared/types";

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
 * --vscode-* custom properties of the theme layer are read out into a plain xterm ITheme.
 *
 * One thing in it depends on the agent (see the swap below), so a terminal's theme is built per
 * terminal rather than once for the window.
 */
export function buildXtermTheme(agentId: AgentId): ITheme {
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

  // opencode's TUI assigns blue and magenta the other way round from VS Code's terminal
  // palette, so what it draws comes out in the colour the user did not theme — swapping the
  // two in the palette it is handed puts them back. Ported from sbc-vsc-agents, where it was
  // observed; it goes with the `"theme": "system"` in tui-config.ts, which is what makes
  // opencode take this palette at all rather than painting in its own. Nothing else needs it,
  // so it is a conditional here rather than a callback on AgentDefinition: that interface is
  // the main process's, and the renderer is where a colour is resolved.
  const ansiCssVars =
    agentId === "opencode"
      ? { ...ANSI_CSS_VARS, blue: ANSI_CSS_VARS.magenta, magenta: ANSI_CSS_VARS.blue }
      : ANSI_CSS_VARS;

  for (const [key, cssVar] of Object.entries(ansiCssVars)) {
    (theme as Record<string, string | undefined>)[key] = read(cssVar);
  }

  return theme;
}

/** monaco color id to the --vscode-* variable it reads — see editor.ts's `applyChrome`. */
const MONACO_CSS_VARS: Record<string, string> = {
  "editor.background": "--vscode-editor-background",
  "editor.foreground": "--vscode-editor-foreground",
  "editorLineNumber.foreground": "--vscode-editorLineNumber-foreground",
  "editorLineNumber.activeForeground": "--vscode-editorLineNumber-activeForeground",
  "editorCursor.foreground": "--vscode-editorCursor-foreground",
  "editor.selectionBackground": "--vscode-editor-selectionBackground",
  "editor.inactiveSelectionBackground": "--vscode-editor-inactiveSelectionBackground",
  "editor.lineHighlightBorder": "--vscode-editor-lineHighlightBorder",
  "editor.findMatchBackground": "--vscode-editor-findMatchBackground",
  "editor.findMatchHighlightBackground": "--vscode-editor-findMatchHighlightBackground",
  "editorIndentGuide.background1": "--vscode-editorIndentGuide-background1",
  "editorIndentGuide.activeBackground1": "--vscode-editorIndentGuide-activeBackground1",
  "editorWidget.background": "--vscode-editorWidget-background",
  "editorWidget.border": "--vscode-editorWidget-border",
  "widget.shadow": "--vscode-widget-shadow",
  "input.background": "--vscode-input-background",
  "input.foreground": "--vscode-input-foreground",
  "input.border": "--vscode-input-border",
  "input.placeholderForeground": "--vscode-input-placeholderForeground",
  focusBorder: "--vscode-focusBorder",
  // The find widget's Aa/ab/.* toggles: a plain, persistent background when on — the same
  // translucent grey an action button already hovers with everywhere else — rather than monaco's
  // own default of a `#007ACC` border and a recoloured icon. No colour at all, not even the
  // shared accent: an icon-button toggle turning blue reads fine standing alone, but these three
  // sit in a row together, and a row of icons some blue and some not reads as broken, not toggled.
  "inputOption.activeForeground": "--vscode-foreground",
  "inputOption.activeBackground": "--vscode-toolbar-hoverBackground",
  "scrollbarSlider.background": "--vscode-scrollbarSlider-background",
  "scrollbarSlider.hoverBackground": "--vscode-scrollbarSlider-hoverBackground",
  "scrollbarSlider.activeBackground": "--vscode-scrollbarSlider-activeBackground",
  "menu.background": "--vscode-menu-background",
  "menu.foreground": "--vscode-menu-foreground",
  "menu.border": "--vscode-menu-border",
  "menu.selectionBackground": "--vscode-menu-selectionBackground",
  "menu.selectionForeground": "--vscode-menu-selectionForeground",
  "menu.separatorBackground": "--vscode-menu-separatorBackground",
  "list.hoverBackground": "--vscode-list-hoverBackground",
  "list.activeSelectionBackground": "--vscode-list-activeSelectionBackground",
  "list.activeSelectionForeground": "--vscode-list-activeSelectionForeground"
};

/**
 * The editor's chrome (background, gutter, selection, widgets...) as monaco color overrides,
 * read the same way `buildXtermTheme` reads xterm's — everything else (bracket match, hover
 * widget, suggest widget...) is left to monaco's own vs-dark defaults, which are VS Code's own
 * values anyway. Without this the editor stays shiki's dark-plus chrome (`#1e1e1e`, not tet's
 * `#1f1f1f`) — see editor.ts's `applyChrome`.
 */
export function buildMonacoColors(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  const colors: Record<string, string> = {};
  for (const [id, cssVar] of Object.entries(MONACO_CSS_VARS)) {
    const value = styles.getPropertyValue(cssVar).trim();
    if (value) {
      colors[id] = value;
    }
  }
  // No border box around an active toggle — just the background set through the map above.
  colors["inputOption.activeBorder"] = "#00000000";
  return colors;
}
