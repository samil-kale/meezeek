import { isMac, isModifierHeld } from "./platform";

/**
 * The window's own shortcuts, all of them on combinations xterm's `Keyboard.ts` never turns into
 * bytes (verified against the installed `@xterm/xterm`, not assumed) — so none of them can be a
 * key an agent could have received. See "The keyboard belongs to the terminal" in CLAUDE.md.
 *
 * One list rather than a binding in `App.tsx` and a separate description in the settings dialog:
 * two spellings of the same shortcut would drift apart the way `parseEnv`/`formatEnv` do not.
 */
export type ShortcutId = "settings" | "toggleGit" | "needsAttention" | "nextTab" | "previousTab" | "newShellTab";

interface ShortcutDef {
  id: ShortcutId;
  description: string;
  shift: boolean;
  /** `event.key.toLowerCase()` to match. */
  key: string;
  /** The key as shown to the user, unlowercased. */
  label: string;
}

const DEFS: ShortcutDef[] = [
  { id: "settings", description: "Open settings", shift: false, key: ",", label: "," },
  { id: "toggleGit", description: "Show or hide the repository", shift: true, key: "g", label: "G" },
  {
    id: "needsAttention",
    description: "Jump to the session that needs you — a question first, then one that finished out of sight",
    shift: true,
    key: "u",
    label: "U"
  },
  { id: "nextTab", description: "Next tab", shift: true, key: ".", label: "." },
  { id: "previousTab", description: "Previous tab", shift: true, key: ",", label: "," },
  { id: "newShellTab", description: "New shell tab", shift: true, key: "t", label: "T" }
];

export function matchesShortcut(event: KeyboardEvent, id: ShortcutId): boolean {
  const def = DEFS.find((entry) => entry.id === id);
  return (
    def !== undefined && isModifierHeld(event) && event.shiftKey === def.shift && event.key.toLowerCase() === def.key
  );
}

export function shortcutLabel(id: ShortcutId): string {
  const def = DEFS.find((entry) => entry.id === id);
  if (!def) {
    return "";
  }
  const mod = isMac() ? "⌘" : "Ctrl";
  return def.shift ? `${mod}+Shift+${def.label}` : `${mod}+${def.label}`;
}

/** What the settings dialog's Shortcuts tab lists, in the order defined above. */
export const SHORTCUTS: { id: ShortcutId; description: string }[] = DEFS.map(({ id, description }) => ({
  id,
  description
}));
