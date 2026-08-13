export function isMac(): boolean {
  return navigator.platform.toLowerCase().includes("mac");
}

export function isWindows(): boolean {
  return navigator.platform.toLowerCase().includes("win");
}

/** The key that gates link activation and paste: Cmd on macOS, Ctrl everywhere else. */
export function isModifierHeld(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac() ? event.metaKey : event.ctrlKey;
}

export function isModifierKey(event: KeyboardEvent): boolean {
  return isMac() ? event.key === "Meta" : event.key === "Control";
}
