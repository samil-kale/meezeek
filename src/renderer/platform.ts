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

/** What each platform calls its own file manager, the way GitHub Desktop names them. */
export function revealLabel(): string {
  if (isMac()) {
    return "Reveal in Finder";
  }
  return isWindows() ? "Show in Explorer" : "Show in your file manager";
}

/** git (and this app's own file listing) reports paths relative to the root with `/`; the
 *  clipboard gets one the platform's own file manager accepts. */
export function absolutePath(projectPath: string, relative: string): string {
  return [projectPath, ...relative.split("/")].join(isWindows() ? "\\" : "/");
}
