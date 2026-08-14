import * as fs from "node:fs";
import * as path from "node:path";

/**
 * opencode ships a palette of its own and draws its TUI in it, so its terminal looks nothing
 * like the window around it. Claude Code needs no equivalent: it paints with the ANSI colours
 * the terminal hands it, which are the `--vscode-*` ones (`src/renderer/theme.ts`).
 * `"theme": "system"` is opencode's own way of saying the same.
 *
 * It goes in a file of meezeek's own that `OPENCODE_TUI_CONFIG` points at, layered on top of
 * whatever opencode already loaded; the user's `tui.json` is never read, written or replaced.
 * Set on the *terminal* rather than on the server, since under `attach` the TUI is what draws —
 * and passed as a default, so a user who sets that variable themselves keeps their own file
 * (see spawnAgentProcess).
 *
 * One file for every repository: nothing in it names one.
 */
export function installTuiConfig(storageRoot: string): Record<string, string> {
  const file = path.join(storageRoot, "opencode-tui.json");
  const contents = JSON.stringify({ $schema: "https://opencode.ai/tui.json", theme: "system" }, null, 2);
  try {
    fs.writeFileSync(file, contents);
  } catch (error) {
    // A TUI in opencode's own colours is still a working TUI — unlike the server, this is not
    // worth marking the agent unstartable over.
    console.error("[meezeek] could not write the opencode tui config:", error);
    return {};
  }
  return { OPENCODE_TUI_CONFIG: file };
}
