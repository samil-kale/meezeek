import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * The file-editor's own keybindings, a plain key-combo-to-command map the user edits directly —
 * there is no dialog for this one, only the file. Lives in tet's own userData, like settings.json
 * beside it: a personal preference, not something a project carries around.
 *
 * Read fresh each time rather than cached: it is asked for once per editor opened, cheap either
 * way, and a value cached across an edit-then-reopen would show the file as it used to be.
 */
const FILE = "keybindings.json";

/**
 * The file's contents as a plain key-combo → command-id map, or `{}` for one that is missing,
 * unreadable, or shaped differently — the same rule `commands.ts` follows for tet.json: half of
 * a hand-edited file being wrong is not a reason to throw, and every entry is checked again on
 * the renderer side against what monaco actually knows how to run.
 */
export async function readKeybindings(userDataPath: string): Promise<Record<string, string>> {
  try {
    const content = await fs.readFile(path.join(userDataPath, FILE), "utf8");
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}
