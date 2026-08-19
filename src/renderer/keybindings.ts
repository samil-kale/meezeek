import type { Monaco } from "./editor";

/**
 * The editor's own default bindings for the commands tet adds itself — layered under whatever
 * the user's keybindings.json says, so a file that never mentions "tet.save" still saves on
 * Ctrl+S, and one that does simply overrides this entry for that key.
 */
const DEFAULT_KEYBINDINGS: Record<string, string> = {
  "ctrl+s": "tet.save"
};

/** Key names keybindings.json may use for the part after the last `+` — VS Code's own spelling
 *  where one exists, so a binding copied from there mostly just works. Not exhaustive: this is
 *  a personal preference file for the handful of commands worth rebinding, not a full keyboard. */
const KEY_NAMES: Record<string, string> = {
  backspace: "Backspace",
  tab: "Tab",
  enter: "Enter",
  return: "Enter",
  escape: "Escape",
  esc: "Escape",
  space: "Space",
  pageup: "PageUp",
  pagedown: "PageDown",
  end: "End",
  home: "Home",
  left: "LeftArrow",
  up: "UpArrow",
  right: "RightArrow",
  down: "DownArrow",
  insert: "Insert",
  delete: "Delete",
  del: "Delete",
  ";": "Semicolon",
  "=": "Equal",
  ",": "Comma",
  "-": "Minus",
  ".": "Period",
  "/": "Slash",
  "`": "Backquote",
  "[": "BracketLeft",
  "\\": "Backslash",
  "]": "BracketRight",
  "'": "Quote",
  numpad0: "Numpad0",
  numpad1: "Numpad1",
  numpad2: "Numpad2",
  numpad3: "Numpad3",
  numpad4: "Numpad4",
  numpad5: "Numpad5",
  numpad6: "Numpad6",
  numpad7: "Numpad7",
  numpad8: "Numpad8",
  numpad9: "Numpad9",
  numpad_multiply: "NumpadMultiply",
  numpad_add: "NumpadAdd",
  numpad_subtract: "NumpadSubtract",
  numpad_decimal: "NumpadDecimal",
  numpad_divide: "NumpadDivide"
};
for (let n = 0; n <= 9; n++) {
  KEY_NAMES[String(n)] = `Digit${n}`;
}
for (let n = 1; n <= 24; n++) {
  KEY_NAMES[`f${n}`] = `F${n}`;
}
for (const letter of "abcdefghijklmnopqrstuvwxyz") {
  KEY_NAMES[letter] = `Key${letter.toUpperCase()}`;
}

/**
 * One entry of a key-combo string ("ctrl+shift+s") into monaco's keybinding number, or undefined
 * for anything this table doesn't know — an unrecognised entry in the user's file is skipped
 * rather than guessed at, the same tolerance `readKeybindings` already gives the file itself.
 */
export function parseKeyCombo(monaco: Monaco, combo: string): number | undefined {
  const parts = combo
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  const key = parts[parts.length - 1];
  const keyCodeName = KEY_NAMES[key];
  if (!keyCodeName) {
    return undefined;
  }
  let mods = 0;
  for (const modifier of parts.slice(0, -1)) {
    if (modifier === "ctrl" || modifier === "cmd" || modifier === "meta") {
      mods |= monaco.KeyMod.CtrlCmd;
    } else if (modifier === "shift") {
      mods |= monaco.KeyMod.Shift;
    } else if (modifier === "alt" || modifier === "option") {
      mods |= monaco.KeyMod.Alt;
    } else {
      return undefined;
    }
  }
  const keyCode = (monaco.KeyCode as unknown as Record<string, number>)[keyCodeName];
  return keyCode === undefined ? undefined : mods | keyCode;
}

/** The user's keybindings.json, merged over tet's own defaults for the commands it adds. */
export async function loadKeybindings(): Promise<Record<string, string>> {
  const user = await window.tet.keybindings.get();
  return { ...DEFAULT_KEYBINDINGS, ...user };
}
